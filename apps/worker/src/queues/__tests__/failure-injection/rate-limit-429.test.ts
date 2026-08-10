/* eslint-disable @typescript-eslint/unbound-method -- asserting that mocked Job/Worker methods were (not) called requires referencing them unbound; there is no `this` to lose because every one is a vi.fn spy on a fake, not a real BullMQ method */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DelayedError, type Job, type Worker } from "bullmq";
import type { Pool } from "pg";
import { Redis } from "ioredis";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "@mega-crm/test-support";
import { upsertWorkspaceSendSettings } from "@mega-crm/delivery-core";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import type { EmailBroadcastJob } from "@mega-crm/shared-schemas";
import { processSendJob } from "../../send-dispatch.js";
import { handleEmailBroadcastJob } from "../../email-broadcast.worker.js";
import {
  connectFixtureSendgridKey,
  countingSendMail,
  createFixtureCampaign,
  createFixtureContact,
  fakeSendMail,
  freshWorkspaceId,
  sendsRowCountFor,
  sendsStatusFor,
} from "../../../test/failure-fixtures.js";

/** Fake `Job` exposing a spy `moveToDelayed` -- Phase 12 (WRK-01, plan 12-01)'s worker-wrapper-layer convention (`tenant-deferral.test.ts`). */
function fakeJob(data: EmailBroadcastJob): Job<EmailBroadcastJob> & { moveToDelayed: ReturnType<typeof vi.fn> } {
  return {
    data,
    moveToDelayed: vi.fn().mockResolvedValue(undefined),
  } as unknown as Job<EmailBroadcastJob> & { moveToDelayed: ReturnType<typeof vi.fn> };
}

/** Fake `Worker` exposing a spy `rateLimit` -- must remain uncalled once the tenant-scoped cause defers through `deferForTenantBucket` instead. */
function fakeWorker(): Worker<EmailBroadcastJob> & { rateLimit: ReturnType<typeof vi.fn> } {
  return { rateLimit: vi.fn() } as unknown as Worker<EmailBroadcastJob> & { rateLimit: ReturnType<typeof vi.fn> };
}

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

  /**
   * Phase 12 (WRK-01, plan 12-01): a workspace pinned to a 1-RPS ceiling with
   * its single token already burned this second -- the NEXT `processSendJob`
   * call for this workspace is denied by the bucket itself (cause:
   * "tenant_bucket"), never reaching SendGrid.
   */
  async function arrangeSaturatedWorkspace(seed: string): Promise<{ workspaceId: string; campaignId: string }> {
    const workspaceId = await freshWorkspaceId(pool, seed);
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) => upsertWorkspaceSendSettings(client, workspaceId, { rpsLimit: 1 })),
    );
    const burnContactId = await createFixtureContact(workspaceId);
    const burned = await processSendJob(
      { workspaceId, campaignId, kind: "campaign", contactId: burnContactId },
      { sendMail: fakeSendMail(202), redisClient },
    );
    expect(burned.outcome).toBe("sent");
    return { workspaceId, campaignId };
  }

  it("returns rate_limited with the Retry-After backoff and leaves no stranded claim", async () => {
    const { workspaceId, campaignId, contactId } = await arrangeSendableContact("failure-429-retry-after");

    const result = await processSendJob(
      { workspaceId, campaignId, kind: "campaign", contactId },
      { sendMail: fakeSendMail(429, { "retry-after": "3" }), redisClient },
    );

    // Phase 11 (D-10): a SendGrid 429/5xx now carries cause: "provider_backoff".
    expect(result).toEqual({ outcome: "rate_limited", rateLimitMs: 3000, cause: "provider_backoff" });

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
    expect(result).toEqual({ outcome: "rate_limited", rateLimitMs: 2000, cause: "provider_backoff" });
    expect(counting.callCount(), "the send must be attempted exactly once before backing off").toBe(1);
    expect(await sendsRowCountFor(workspaceId, campaignId, contactId)).toBe(0);
  });

  /**
   * Phase 12 (WRK-01, plan 12-01): the three cases above drive
   * `processSendJob` directly, proving the CAUSE is correctly derived. These
   * two additionally drive `handleEmailBroadcastJob` -- the worker-wrapper
   * layer -- to prove what happens with that cause once it reaches BullMQ's
   * job/worker API: a tenant-scoped rejection defers only the offending job
   * (never `worker.rateLimit()`), while provider backoff still consumes a
   * bounded attempt via a plain thrown Error.
   */
  it("at the worker-wrapper layer: a tenant-bucket rejection for workspace A defers via deferForTenantBucket while workspace B's send completes on the same worker", async () => {
    const { workspaceId: workspaceA, campaignId: campaignA } = await arrangeSaturatedWorkspace(
      "failure-429-worker-wrapper-tenant-a",
    );
    const contactA = await createFixtureContact(workspaceA);

    const {
      workspaceId: workspaceB,
      campaignId: campaignB,
      contactId: contactB,
    } = await arrangeSendableContact("failure-429-worker-wrapper-tenant-b");

    const jobA = fakeJob({ workspaceId: workspaceA, campaignId: campaignA, kind: "campaign", contactId: contactA });
    const jobB = fakeJob({ workspaceId: workspaceB, campaignId: campaignB, kind: "campaign", contactId: contactB });
    const worker = fakeWorker();

    const [resultA, resultB] = await Promise.allSettled([
      handleEmailBroadcastJob(jobA, worker, { sendMail: fakeSendMail(202), redisClient }, "tok-a"),
      handleEmailBroadcastJob(jobB, worker, { sendMail: fakeSendMail(202), redisClient }, "tok-b"),
    ]);

    expect(resultA.status).toBe("rejected");
    if (resultA.status === "rejected") {
      expect(resultA.reason).toBeInstanceOf(DelayedError);
    }
    expect(resultB.status).toBe("fulfilled");

    expect(jobA.moveToDelayed).toHaveBeenCalledTimes(1);
    expect(jobB.moveToDelayed).not.toHaveBeenCalled();
    expect(worker.rateLimit, "no worker-wide pause must be requested for a tenant-scoped cause").not.toHaveBeenCalled();

    expect(
      await sendsStatusFor(workspaceB, campaignB, contactB),
      "workspace B's ledger write must happen even while workspace A's job is deferred",
    ).toBe("sent");
  });

  it("at the worker-wrapper layer: provider backoff still consumes a bounded attempt -- a plain Error, never a deferral", async () => {
    const { workspaceId, campaignId, contactId } = await arrangeSendableContact(
      "failure-429-worker-wrapper-provider-backoff",
    );

    const job = fakeJob({ workspaceId, campaignId, kind: "campaign", contactId });
    const worker = fakeWorker();

    await expect(
      handleEmailBroadcastJob(
        job,
        worker,
        { sendMail: fakeSendMail(429, { "retry-after": "1" }), redisClient },
        "tok-provider",
      ),
    ).rejects.toThrow(/SendGrid provider backoff/);

    expect(job.moveToDelayed, "provider_backoff must never route through the tenant-scoped deferral helper").not.toHaveBeenCalled();
    expect(await sendsRowCountFor(workspaceId, campaignId, contactId)).toBe(0);
  });
});
