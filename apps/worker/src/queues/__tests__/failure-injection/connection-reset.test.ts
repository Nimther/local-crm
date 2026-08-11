import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { Redis } from "ioredis";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "@mega-crm/test-support";
import { processSendJob } from "../../send-dispatch.js";
import {
  connectFixtureSendgridKey,
  countingSendMail,
  createFixtureCampaign,
  createFixtureContact,
  freshWorkspaceId,
  sendsRowCountFor,
  sendsStatusFor,
  sendsTimingFor,
  throwingSendMail,
} from "../../../test/failure-fixtures.js";

/**
 * 08-08 (QG-06) — failure mode 3 of 5: the connection to SendGrid is reset.
 *
 * Reproduce with `npm run failure:reset` from the repo root.
 *
 * Deliberately a separate file from timeout.test.ts even though
 * `classifyTransportError` (11-06, D-10) resolves BOTH to the SAME
 * `ambiguous` classification -- `ECONNRESET` has no `code` in the
 * pre-connection allowlist any more than `AbortError` does, so both fall
 * through to the fail-closed default. Two files, two error identities, two
 * commands: if a future change ever narrows `ECONNRESET` into the
 * pre-connection allowlist (it must not -- a reset proves a connection WAS
 * established, the opposite of "never left this process"), this file is the
 * one that would catch it.
 *
 * Phase 11 (11-06): `processSendJob` now classifies this throw INLINE and
 * writes `reconciling` directly on the FIRST call -- no redelivery required
 * to observe the disposition (see timeout.test.ts's file comment for the
 * full before/after).
 */
describe("failure injection: SendGrid connection reset (QG-06)", () => {
  let pool: Pool;
  let redisClient: Redis;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    pool = createTestPool();
    redisClient = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379/1");
  });

  afterAll(async () => {
    await pool.end();
    await redisClient.quit();
  });

  /**
   * A socket-level reset, as undici surfaces it: an Error carrying
   * `code: "ECONNRESET"`. Distinct in identity from timeout.test.ts's
   * DOMException on purpose — see the file comment.
   */
  const resetError = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });

  it("classifies the reset as ambiguous inline and resolves to reconciling with exactly one send attempt", async () => {
    const workspaceId = await freshWorkspaceId(pool, "failure-reset");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);

    const throwing = throwingSendMail(resetError);
    const result = await processSendJob(
      { workspaceId, campaignId, kind: "campaign", contactId },
      { sendMail: throwing.fn, redisClient },
    );

    expect(throwing.callCount(), "the send was attempted exactly once before the reset").toBe(1);
    expect(result.outcome).toBe("reconciling");
    if (result.outcome !== "reconciling") {
      throw new Error("test assertion failure: expected outcome 'reconciling'");
    }

    expect(
      await sendsStatusFor(workspaceId, campaignId, contactId),
      "an ambiguous throw must write 'reconciling' directly, never leave the row stranded at 'dispatching'",
    ).toBe("reconciling");

    const timing = await sendsTimingFor(result.sendId, workspaceId);
    expect(timing?.dispatchedAt, "dispatch timing must be recorded even on the ambiguous branch").not.toBeNull();
    expect(timing?.dispatchDurationMs).not.toBeNull();
    expect(timing?.reconcilingSince).not.toBeNull();

    // --- BullMQ redelivers (e.g. a crash strictly between this write and
    // job completion) -- the claim-gate's "skipped" branch, not a second
    // SendGrid call, must intercept it.
    const counting = countingSendMail(202);
    const redelivered = await processSendJob(
      { workspaceId, campaignId, kind: "campaign", contactId },
      { sendMail: counting.fn, redisClient },
    );

    expect(
      counting.callCount(),
      "a redelivered job for a 'reconciling' row must never call SendGrid again — this is the duplicate-email window",
    ).toBe(0);
    expect(redelivered.outcome).toBe("skipped");

    expect(await sendsStatusFor(workspaceId, campaignId, contactId)).toBe("reconciling");
    expect(
      await sendsRowCountFor(workspaceId, campaignId, contactId),
      "the redelivery must resolve the existing row, not insert a second one",
    ).toBe(1);
  });
});
