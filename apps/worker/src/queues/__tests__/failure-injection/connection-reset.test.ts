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
 * 08-08 (QG-06) — failure mode 3 of 5: the connection to SendGrid is reset.
 *
 * Reproduce with `npm run failure:reset` from the repo root.
 *
 * Deliberately a separate file from timeout.test.ts even though send-dispatch.ts
 * cannot currently tell the two apart — both arrive as a rejected promise, and
 * there is no AbortController in packages/delivery-core/src/send-mail.ts to
 * distinguish a timeout from a socket error. Two files, two error identities,
 * two commands: when Phase 11 gives these different handling, the file that
 * fails will name which mode regressed instead of one shared test failing
 * ambiguously.
 *
 * The chain is the same one timeout.test.ts documents: rejection strands the
 * committed claim at `dispatching`, the BullMQ redelivery is intercepted by
 * claimCampaignSend's interrupted branch, and the send resolves to
 * `reconciling` (Phase 11, DLV-02 -- was `failed` pre-11-03) with no second
 * SendGrid call.
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

  it("strands the claim at dispatching, then the redelivery resolves it to reconciling without a second attempt", async () => {
    const workspaceId = await freshWorkspaceId(pool, "failure-reset");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);

    // --- the reset itself ---------------------------------------------------
    const throwing = throwingSendMail(resetError);
    await expect(
      processSendJob(
        { workspaceId, campaignId, kind: "campaign", contactId },
        { sendMail: throwing.fn, redisClient },
      ),
      "the ECONNRESET must propagate out of processSendJob with its identity intact",
    ).rejects.toBe(resetError);

    expect(throwing.callCount(), "the send was attempted exactly once before the reset").toBe(1);

    // --- the claim is stranded ---------------------------------------------
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

    // Phase 11 (11-03): the pre-change baseline (`failed`) is now superseded
    // -- this process cannot prove whether SendGrid was ever called, so it
    // hands the row to the reconciler instead of asserting an outcome.
    expect(await sendsStatusFor(workspaceId, campaignId, contactId)).toBe("reconciling");
    expect(
      await sendsRowCountFor(workspaceId, campaignId, contactId),
      "the redelivery must resolve the existing row, not insert a second one",
    ).toBe(1);
  });
});
