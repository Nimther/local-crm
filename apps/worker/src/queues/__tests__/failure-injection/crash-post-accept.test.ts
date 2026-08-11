import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { Redis } from "ioredis";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import {
  createTestPool,
  ensureTestDbMigrated,
  getScanTestDatabaseUrl,
  getTestDatabaseUrl,
  killAndAwaitExit,
  spawnAndAwaitReady,
  type SpawnedChild,
} from "@mega-crm/test-support";
import { deriveCampaignSendId } from "@mega-crm/delivery-core";

import { processSendJob } from "../../send-dispatch.js";
import { runReconcilerTick } from "../../send-reconciler.worker.js";
import { SIGKILL_HARNESS_ACCEPTED } from "../../../test/harness/sigkill-entrypoint.js";
import {
  connectFixtureSendgridKey,
  countingSendMail,
  createFixtureCampaign,
  createFixtureContact,
  freshWorkspaceId,
  sendsRowCountFor,
  sendsStatusFor,
  sendsTimingFor,
} from "../../../test/failure-fixtures.js";

/**
 * 11-11 (DLV-08 boundary 2) — the phase's headline scenario: a message
 * SendGrid has already accepted, whose sender dies before it can record that
 * fact. Proves the row is neither lost to a false `failed` (an operator
 * reading `failed` would wrongly conclude nothing was sent, when a phantom-
 * accepted mail may already be in the recipient's inbox) nor duplicated by a
 * retry — it waits in `reconciling` until its own webhook evidence resolves
 * it to `sent`.
 *
 * Reproduce with `npm run failure:crash-post-accept` from the repo root.
 *
 * Mirrors `sigkill.test.ts`'s structure exactly: the same `beforeAll`/
 * `afterAll`, the same `survivor` cleanup, the same spawn-then-kill-on-marker
 * discipline, and the same intermediate `dispatching` assertion that proves
 * the kill landed in the window rather than merely having happened at an
 * arbitrary point. The only difference from boundary 1 is WHICH marker the
 * harness posts and WHEN: here the injected mail function posts
 * `SIGKILL_HARNESS_ACCEPTED` — the harness's own faithful simulation of
 * "SendGrid has taken custody of the message" — and the process is killed
 * while it holds no record of that fact. See `sigkill-entrypoint.ts`'s own
 * doc comment for why this cannot be reproduced by literally returning a 202
 * and then dying (the process would simply commit the record normally, and
 * no crash would have occurred).
 *
 * `sends.id` is a deterministic UUIDv5 of the send intent (D-09), so this
 * test can compute the SAME id the harness's own dispatch used via
 * `deriveCampaignSendId` — this is exactly the correlation guarantee that
 * closes RESEARCH.md's Pitfall 4 (the release-claim phantom-event hole): the
 * phantom-accepted message's eventual webhook always lands on the row that
 * currently occupies that id.
 */
const HARNESS_ENTRYPOINT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../test/harness/sigkill-entrypoint.ts",
);

describe("failure injection: SIGKILL after the provider accepted, before the result was written (DLV-08 boundary 2)", () => {
  let pool: Pool;
  let redisClient: Redis;
  let survivor: SpawnedChild | undefined;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    process.env.SCAN_DATABASE_URL = getScanTestDatabaseUrl();
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

  async function campaignCountersFor(
    workspaceId: string,
    campaignId: string,
  ): Promise<{ sentCount: number; failedCount: number }> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ sentCount: number; failedCount: number }>(
          `SELECT sent_count as "sentCount", failed_count as "failedCount" FROM campaigns WHERE id = $1`,
          [campaignId],
        );
        if (!rows[0]) throw new Error("test setup failure: no campaign row found");
        return rows[0];
      }),
    );
  }

  /** The webhook evidence the phantom-accepted message eventually produces. */
  async function insertSendEventEvidence(workspaceId: string, sendId: string): Promise<void> {
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(
          `INSERT INTO send_events (id, workspace_id, sg_event_id, send_id, event_type, payload, occurred_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'processed', '{}'::jsonb, now())`,
          [workspaceId, `sg-evt-post-accept-${sendId}-${Date.now()}`, sendId],
        ),
      ),
    );
  }

  it("resolves the phantom-accepted send to reconciling on redelivery, then to sent once its own webhook evidence arrives", async () => {
    const workspaceId = await freshWorkspaceId(pool, "failure-crash-post-accept");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = deriveCampaignSendId(workspaceId, campaignId, contactId);
    const countersBefore = await campaignCountersFor(workspaceId, campaignId);

    const jobData = { workspaceId, campaignId, kind: "campaign" as const, contactId };

    // --- a real process, frozen just after it "hands the message to
    // SendGrid" ---------------------------------------------------------
    const child = await spawnAndAwaitReady({
      entrypoint: HARNESS_ENTRYPOINT,
      readyMessage: SIGKILL_HARNESS_ACCEPTED,
      execArgv: ["--import", "tsx"],
      env: {
        SIGKILL_HARNESS_JOB_DATA: JSON.stringify(jobData),
        SIGKILL_HARNESS_FREEZE_AT: "after_provider_accept",
        TEST_DATABASE_URL: getTestDatabaseUrl(),
        DATABASE_URL: getTestDatabaseUrl(),
        REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379/1",
      },
    });
    survivor = child;

    // --- the intermediate assertion that proves the kill window ----------
    // Without this, a child that died BEFORE the claim ever committed would
    // satisfy every assertion below just as well, and prove nothing at all.
    expect(
      await sendsStatusFor(workspaceId, campaignId, contactId),
      "the claim committed and the (faithfully simulated) acceptance marker fired before the freeze",
    ).toBe("dispatching");

    // --- the kill ----------------------------------------------------------
    const exit = await killAndAwaitExit(child);
    survivor = undefined;
    expect(exit.signal, "the child must have been killed, not have exited").toBe("SIGKILL");
    expect(exit.code).toBeNull();

    // --- the redelivery: reconciling, never a second provider call ---------
    const counting = countingSendMail(202);
    const redelivered = await processSendJob(jobData, { sendMail: counting.fn, redisClient });

    expect(
      counting.callCount(),
      "the message was already (phantom-)accepted — a redelivery must never call SendGrid again",
    ).toBe(0);
    expect(redelivered.outcome).toBe("reconciling");
    expect(await sendsStatusFor(workspaceId, campaignId, contactId)).toBe("reconciling");
    expect(
      await sendsRowCountFor(workspaceId, campaignId, contactId),
      "the redelivery resolves the existing row rather than inserting a second one",
    ).toBe(1);

    const timingAfterRedelivery = await sendsTimingFor(sendId, workspaceId);
    expect(timingAfterRedelivery?.reconcilingSince, "ambiguity is recorded, not silently dropped").not.toBeNull();

    const countersAfterRedelivery = await campaignCountersFor(workspaceId, campaignId);
    expect(countersAfterRedelivery.sentCount, "sent_count must not move for an unresolved ambiguous send").toBe(
      countersBefore.sentCount,
    );
    expect(
      countersAfterRedelivery.failedCount,
      "failed_count must not move — this send was never proven to have failed",
    ).toBe(countersBefore.failedCount);

    // --- the phantom message's own webhook eventually arrives --------------
    await insertSendEventEvidence(workspaceId, sendId);

    const tick = await runReconcilerTick();
    expect(tick.resolvedSent).toBeGreaterThanOrEqual(1);

    expect(
      await sendsStatusFor(workspaceId, campaignId, contactId),
      "evidence for the phantom-accepted message resolves the SAME row — the deterministic id is what closes this correlation window",
    ).toBe("sent");

    const timingAfterResolution = await sendsTimingFor(sendId, workspaceId);
    expect(timingAfterResolution?.sentAt, "sent_at is back-dated, never stamped at resolution time").not.toBeNull();

    const countersAfterResolution = await campaignCountersFor(workspaceId, campaignId);
    expect(countersAfterResolution.sentCount, "the backfill counts this send exactly once").toBe(
      countersBefore.sentCount + 1,
    );

    // --- running the tick again changes nothing further ---------------------
    const secondTick = await runReconcilerTick();
    expect(secondTick.resolvedSent).toBe(0);
    expect(await sendsStatusFor(workspaceId, campaignId, contactId)).toBe("sent");
    const countersAfterSecondTick = await campaignCountersFor(workspaceId, campaignId);
    expect(countersAfterSecondTick.sentCount).toBe(countersAfterResolution.sentCount);
  });
});
