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
 * 08-08 (QG-06) — failure mode 2 of 5: the SendGrid call times out.
 *
 * Reproduce with `npm run failure:timeout` from the repo root.
 *
 * Phase 11 (11-06, D-10): `classifyTransportError` now classifies this throw
 * INLINE, inside `processSendJob` itself -- no redelivery required. An
 * `AbortError`/`TimeoutError` falls through the classifier's fail-closed
 * default (`ambiguous`, never `pre_connection_retryable`), so the FIRST call
 * to `processSendJob` already returns `{ outcome: "reconciling" }` and writes
 * `reconciling` directly. This supersedes the pre-11-06 baseline, where the
 * throw propagated out of `processSendJob` entirely and a SECOND
 * (redelivered) call was needed to observe `claimCampaignSend`'s interrupted
 * branch resolve the stranded claim -- that two-call shape is now the
 * behavior of a genuinely crashed worker (never even reaching the catch
 * block), not of a rejection this process is alive to observe.
 */
describe("failure injection: SendGrid timeout (QG-06)", () => {
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
   * The shape an AbortController-driven timeout throws. Distinct in identity
   * from connection-reset.test.ts's error on purpose: send-dispatch.ts treats
   * them identically today, and when Phase 11 starts telling them apart, the
   * assertion below is what makes the RIGHT file fail.
   */
  const timeoutError = new DOMException("The operation was aborted", "AbortError");

  it("classifies the timeout as ambiguous inline and resolves to reconciling with exactly one send attempt", async () => {
    const workspaceId = await freshWorkspaceId(pool, "failure-timeout");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);

    const throwing = throwingSendMail(timeoutError);
    const result = await processSendJob(
      { workspaceId, campaignId, kind: "campaign", contactId },
      { sendMail: throwing.fn, redisClient },
    );

    expect(throwing.callCount(), "the send was attempted exactly once before timing out").toBe(1);
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
