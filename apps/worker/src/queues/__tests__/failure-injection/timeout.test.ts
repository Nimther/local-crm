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
  throwingSendMail,
} from "../../../test/failure-fixtures.js";

/**
 * 08-08 (QG-06) — failure mode 2 of 5: the SendGrid call times out.
 *
 * Reproduce with `npm run failure:timeout` from the repo root.
 *
 * What this asserts is the chain that runs TODAY, deliberately. There is no
 * AbortController in packages/delivery-core/src/send-mail.ts yet, so a timeout
 * and a connection reset are indistinguishable to send-dispatch.ts: both are
 * simply a rejected promise. What the injected error models is therefore the
 * SHAPE Phase 11's timeout will throw, not a mechanism that exists now.
 *
 * The chain: rejection leaves the claim committed by unit 1 stranded at
 * `dispatching` -> BullMQ redelivers -> claimCampaignSend's interrupted branch
 * intercepts it before any second send attempt -> ambiguous status
 * `reconciling` (Phase 11, 11-03, DLV-02).
 *
 * That last step used to be the pre-Phase-11 baseline (`failed`) this harness
 * asserted literally rather than aspirationally. 11-03 is the deliberate,
 * named change that supersedes it: this process cannot prove whether
 * SendGrid was ever called for the stranded claim, so it now hands the row
 * to the reconciler (send-reconciler.worker.ts) instead of asserting an
 * outcome.
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

  it("strands the claim at dispatching, then the redelivery resolves it to reconciling without a second attempt", async () => {
    const workspaceId = await freshWorkspaceId(pool, "failure-timeout");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);

    // --- the timeout itself -------------------------------------------------
    const throwing = throwingSendMail(timeoutError);
    await expect(
      processSendJob(
        { workspaceId, campaignId, kind: "campaign", contactId },
        { sendMail: throwing.fn, redisClient },
      ),
      "the abort must propagate out of processSendJob with its identity intact",
    ).rejects.toBe(timeoutError);

    expect(throwing.callCount(), "the send was attempted exactly once before timing out").toBe(1);

    // --- the claim is stranded ---------------------------------------------
    // This is what a real mid-flight failure leaves behind: unit 1 committed
    // the claim, unit 3 never ran.
    expect(
      await sendsStatusFor(workspaceId, campaignId, contactId),
      "a rejection after the claim commit must leave the row at 'dispatching'",
    ).toBe("dispatching");

    // --- BullMQ redelivers --------------------------------------------------
    const counting = countingSendMail(202);
    const redelivered = await processSendJob(
      { workspaceId, campaignId, kind: "campaign", contactId },
      { sendMail: counting.fn, redisClient },
    );

    expect(
      counting.callCount(),
      "the interrupted branch must intercept the redelivery before any second SendGrid call — this is the duplicate-email window",
    ).toBe(0);
    expect(redelivered.outcome).toBe("reconciling");

    // Phase 11 (11-03): this is the deliberate update the comment above
    // named in advance -- `reconciling`, not `failed`, is what the code
    // produces now that the reconciler exists to resolve it.
    expect(await sendsStatusFor(workspaceId, campaignId, contactId)).toBe("reconciling");
    expect(
      await sendsRowCountFor(workspaceId, campaignId, contactId),
      "the redelivery must resolve the existing row, not insert a second one",
    ).toBe(1);
  });
});
