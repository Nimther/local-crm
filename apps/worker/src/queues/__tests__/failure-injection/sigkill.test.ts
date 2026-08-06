import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { Redis } from "ioredis";
import {
  createTestPool,
  ensureTestDbMigrated,
  getTestDatabaseUrl,
  killAndAwaitExit,
  spawnAndAwaitReady,
  type SpawnedChild,
} from "@mega-crm/test-support";

import { processSendJob } from "../../send-dispatch.js";
import { SIGKILL_HARNESS_READY } from "../../../test/harness/sigkill-entrypoint.js";
import {
  connectFixtureSendgridKey,
  countingSendMail,
  createFixtureCampaign,
  createFixtureContact,
  freshWorkspaceId,
  sendsRowCountFor,
  sendsStatusFor,
} from "../../../test/failure-fixtures.js";

/**
 * 08-12 (QG-06) — failure mode 4 of 5: the process dies mid-send.
 *
 * Reproduce with `npm run failure:sigkill` from the repo root.
 *
 * The only scenario in this phase that needs a real process to die. The other
 * four inject a fake and stay in-process; this one forks a child, lets it run
 * the real `processSendJob` against the same live Postgres and Redis, and
 * SIGKILLs it — a signal that cannot be caught, blocked or ignored, so the
 * child runs no shutdown path on the way out.
 *
 * WHEN the kill lands is the entire point. SPEC R6 says an arbitrary kill
 * moment proves nothing, so nothing here is on a timer or a poll: the child's
 * injected mail function posts an IPC marker and then never settles, and the
 * kill is triggered by that marker. The marker is emitted from inside the call
 * that the claim commit immediately precedes, so the process is provably frozen
 * in the window rather than approaching it.
 *
 * The intermediate `dispatching` assertion is what proves the landing. Without
 * it, a child that died before ever committing its claim would satisfy the
 * final no-duplicate assertion just as well — and prove nothing at all.
 */
const HARNESS_ENTRYPOINT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../test/harness/sigkill-entrypoint.ts",
);

describe("failure injection: SIGKILL inside the dispatch claim window (QG-06)", () => {
  let pool: Pool;
  let redisClient: Redis;
  let survivor: SpawnedChild | undefined;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    pool = createTestPool();
    redisClient = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379/1");
  });

  afterAll(async () => {
    // Belt and braces: a failed assertion between spawn and kill would
    // otherwise leave a frozen child holding a database connection.
    if (survivor) await killAndAwaitExit(survivor).catch(() => undefined);
    await pool.end();
    await redisClient.quit();
  });

  it("kills a real process in the window, strands the claim, and does not re-send on restart", async () => {
    const workspaceId = await freshWorkspaceId(pool, "failure-sigkill");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);

    const jobData = { workspaceId, campaignId, kind: "campaign" as const, contactId };

    // --- a real process, frozen in the window ------------------------------
    // TEST_DATABASE_URL is forwarded explicitly: the child is a separate
    // process and does not inherit vitest globalSetup's in-process assignment.
    // If it connected elsewhere, the status query below would read a row that
    // does not exist and the failure would look like a broken harness rather
    // than broken wiring.
    const child = await spawnAndAwaitReady({
      entrypoint: HARNESS_ENTRYPOINT,
      readyMessage: SIGKILL_HARNESS_READY,
      execArgv: ["--import", "tsx"],
      env: {
        SIGKILL_HARNESS_JOB_DATA: JSON.stringify(jobData),
        TEST_DATABASE_URL: getTestDatabaseUrl(),
        DATABASE_URL: getTestDatabaseUrl(),
        REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379/1",
      },
    });
    survivor = child;

    // --- the kill -----------------------------------------------------------
    const exit = await killAndAwaitExit(child);
    survivor = undefined;

    // A process that had ended on its own reports a numeric code and a null
    // signal, and would satisfy a bare "it is gone" check while proving nothing.
    expect(exit.signal, "the child must have been killed, not have exited").toBe("SIGKILL");
    expect(exit.code).toBeNull();

    // --- the claim is stranded ---------------------------------------------
    expect(
      await sendsStatusFor(workspaceId, campaignId, contactId),
      "the claim committed before the freeze, and the kill prevented any terminal write",
    ).toBe("dispatching");

    // --- the restart --------------------------------------------------------
    const counting = countingSendMail(202);
    const restarted = await processSendJob(jobData, { sendMail: counting.fn, redisClient });

    expect(
      counting.callCount(),
      "a restart must never re-send for a claim a dead process left behind — this is CR-04",
    ).toBe(0);
    expect(restarted.outcome).toBe("failed");
    expect(await sendsStatusFor(workspaceId, campaignId, contactId)).toBe("failed");
    expect(
      await sendsRowCountFor(workspaceId, campaignId, contactId),
      "the restart resolves the existing row rather than inserting a second one",
    ).toBe(1);
  });
});
