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
  fakeSendMail,
  freshWorkspaceId,
  sendsRowCountFor,
} from "../../../test/failure-fixtures.js";

/**
 * 08-08 (QG-06) — failure mode 1 of 5: SendGrid rate-limits the send.
 *
 * Reproduce with `npm run failure:429` from the repo root.
 *
 * The audit's concern is not that a 429 is reported — it is whether the
 * dispatch claim survives one. `dispatchSendGate` commits a `dispatching` row
 * in its own transaction before SendGrid is ever called, so a rate-limited
 * attempt that failed to release that claim would strand the row forever: the
 * retry would hit `claimCampaignSend`'s interrupted branch and resolve the send
 * to `failed`, turning a routine backoff into a permanently undelivered email.
 *
 * The returned outcome alone cannot catch that — it would read `rate_limited`
 * either way. The row-count assertion is the one that actually proves it.
 *
 * Nothing here reaches packages/delivery-core/src/send-mail.ts: every scenario
 * injects `sendMail` through the ProcessSendJobDeps seam that has existed since
 * Phase 4, so the real SendGrid endpoint is never contacted (T-08-08-01).
 */
describe("failure injection: SendGrid 429 rate limit (QG-06)", () => {
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

  async function arrangeSendableContact(seed: string): Promise<{
    workspaceId: string;
    campaignId: string;
    contactId: string;
  }> {
    const workspaceId = await freshWorkspaceId(pool, seed);
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    return { workspaceId, campaignId, contactId };
  }

  it("returns rate_limited with the Retry-After backoff and leaves no stranded claim", async () => {
    const { workspaceId, campaignId, contactId } = await arrangeSendableContact("failure-429-retry-after");

    const result = await processSendJob(
      { workspaceId, campaignId, kind: "campaign", contactId },
      { sendMail: fakeSendMail(429, { "retry-after": "3" }), redisClient },
    );

    expect(result).toEqual({ outcome: "rate_limited", rateLimitMs: 3000 });

    // The assertion that matters. A claim left at `dispatching` would send the
    // retry into the interrupted branch and resolve this contact to `failed`.
    expect(
      await sendsRowCountFor(workspaceId, campaignId, contactId),
      "a rate-limited attempt must release its dispatch claim, leaving no sends row behind",
    ).toBe(0);
  });

  it("derives the backoff from X-RateLimit-Reset when Retry-After is absent", async () => {
    const { workspaceId, campaignId, contactId } = await arrangeSendableContact("failure-429-reset-header");

    const resetInSeconds = 5;
    const resetUnixSeconds = Math.floor(Date.now() / 1000) + resetInSeconds;

    const result = await processSendJob(
      { workspaceId, campaignId, kind: "campaign", contactId },
      { sendMail: fakeSendMail(429, { "x-ratelimit-reset": String(resetUnixSeconds) }), redisClient },
    );

    expect(result.outcome).toBe("rate_limited");
    if (result.outcome !== "rate_limited") throw new Error("unreachable — narrowed above");

    // parseRetryAfter computes `reset * 1000 - Date.now()`, so the exact value
    // depends on how much of the current second has elapsed. Bounding it is the
    // honest assertion; pinning it would be flaky.
    expect(result.rateLimitMs).toBeGreaterThan((resetInSeconds - 2) * 1000);
    expect(result.rateLimitMs).toBeLessThanOrEqual(resetInSeconds * 1000);

    expect(await sendsRowCountFor(workspaceId, campaignId, contactId)).toBe(0);
  });

  it("falls back to the fixed 2s seed when neither header is present, calling SendGrid exactly once", async () => {
    const { workspaceId, campaignId, contactId } = await arrangeSendableContact("failure-429-no-header");

    // countingSendMail sends no headers at all, which is precisely the
    // no-header case AND lets the call count be asserted in the same run.
    const counting = countingSendMail(429);
    const result = await processSendJob(
      { workspaceId, campaignId, kind: "campaign", contactId },
      { sendMail: counting.fn, redisClient },
    );

    // 2000 is parseRetryAfter's final fallback in send-dispatch.ts.
    expect(result).toEqual({ outcome: "rate_limited", rateLimitMs: 2000 });
    expect(counting.callCount(), "the send must be attempted exactly once before backing off").toBe(1);
    expect(await sendsRowCountFor(workspaceId, campaignId, contactId)).toBe(0);
  });
});
