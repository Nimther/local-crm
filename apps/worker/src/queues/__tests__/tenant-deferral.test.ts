import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DelayedError, type Job, type Worker } from "bullmq";
import type { Pool } from "pg";
import { Redis } from "ioredis";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "@mega-crm/test-support";
import { upsertWorkspaceSendSettings } from "@mega-crm/delivery-core";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import type { EmailBroadcastJob } from "@mega-crm/shared-schemas";
import type { EmailTriggeredJob } from "@mega-crm/shared-schemas";
import { deferForTenantBucket, TENANT_DEFERRAL_MIN_DELAY_MS } from "../tenant-deferral.js";
import { processSendJob } from "../send-dispatch.js";
import { handleEmailBroadcastJob } from "../email-broadcast.worker.js";
import { handleEmailTriggeredJob } from "../email-triggered.worker.js";
import {
  connectFixtureSendgridKey,
  createFixtureCampaign,
  createFixtureContact,
  fakeSendMail,
  freshWorkspaceId,
} from "../../test/failure-fixtures.js";

/**
 * Phase 12 (WRK-01, plan 12-01): a tenant-scoped rate-limit rejection must
 * defer only the offending job via `job.moveToDelayed` -- never through
 * BullMQ's worker-wide `worker.rateLimit()` -- so one tenant's exhausted
 * bucket cannot stall every other tenant's sends in the same lane. Both send
 * lanes reach this through the SAME `deferForTenantBucket` helper (no drift).
 */

/** Fake `Job` exposing a spy `moveToDelayed`, mirroring `test-send-outcome.test.ts`'s `fakeJob` convention (fake job + fake deps, no live Queue). */
function fakeJob<T>(data: T): Job<T> & { moveToDelayed: ReturnType<typeof vi.fn> } {
  return {
    data,
    moveToDelayed: vi.fn().mockResolvedValue(undefined),
  } as unknown as Job<T> & { moveToDelayed: ReturnType<typeof vi.fn> };
}

/** Fake `Worker` exposing a spy `rateLimit` -- must remain uncalled on the tenant-scoped path. */
function fakeWorker<T>(): Worker<T> & { rateLimit: ReturnType<typeof vi.fn> } {
  return { rateLimit: vi.fn() } as unknown as Worker<T> & { rateLimit: ReturnType<typeof vi.fn> };
}

describe("deferForTenantBucket (Pitfall 1: throw immediately follows moveToDelayed)", () => {
  it("calls job.moveToDelayed exactly once with Date.now() + max(rateLimitMs, TENANT_DEFERRAL_MIN_DELAY_MS) and the supplied token, then throws DelayedError", async () => {
    const job = fakeJob({ any: "payload" });
    const before = Date.now();

    await expect(deferForTenantBucket(job, 5_000, "tok-abc")).rejects.toBeInstanceOf(DelayedError);

    const after = Date.now();
    expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
    const [timestamp, token] = job.moveToDelayed.mock.calls[0];
    expect(token).toBe("tok-abc");
    expect(timestamp).toBeGreaterThanOrEqual(before + 5_000);
    expect(timestamp).toBeLessThanOrEqual(after + 5_000);
  });

  it("never returns a value on any path -- the tenant-bucket cause always rejects", async () => {
    const job = fakeJob({ any: "payload" });
    await expect(deferForTenantBucket(job, 1_000, "tok-xyz")).rejects.toBeInstanceOf(DelayedError);
  });

  it("floors a zero/negative suggested delay at TENANT_DEFERRAL_MIN_DELAY_MS -- an exhausted bucket must still buy the lane a real gap", async () => {
    const job = fakeJob({ any: "payload" });
    const before = Date.now();

    await expect(deferForTenantBucket(job, 0, "tok-floor")).rejects.toBeInstanceOf(DelayedError);

    const [timestamp] = job.moveToDelayed.mock.calls[0];
    expect(timestamp).toBeGreaterThanOrEqual(before + TENANT_DEFERRAL_MIN_DELAY_MS);
  });

  it("throws a descriptive Error before touching the job when the token is missing", async () => {
    const job = fakeJob({ any: "payload" });

    await expect(deferForTenantBucket(job, 1_000, undefined)).rejects.toThrow(/token/i);
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });
});

describe("tenant-scoped deferral end-to-end through both send lanes (WRK-01)", () => {
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

  async function arrangeSaturatedWorkspace(seed: string): Promise<{ workspaceId: string; campaignId: string }> {
    const workspaceId = await freshWorkspaceId(pool, seed);
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) => upsertWorkspaceSendSettings(client, workspaceId, { rpsLimit: 1 }))
    );
    // Burn the workspace's single token for this second so the NEXT
    // processSendJob call in the same window is denied by the bucket itself.
    const burnContactId = await createFixtureContact(workspaceId);
    const burned = await processSendJob(
      { workspaceId, campaignId, kind: "campaign", contactId: burnContactId },
      { sendMail: fakeSendMail(202), redisClient }
    );
    expect(burned.outcome).toBe("sent");
    return { workspaceId, campaignId };
  }

  async function arrangeFreshWorkspace(seed: string): Promise<{ workspaceId: string; campaignId: string }> {
    const workspaceId = await freshWorkspaceId(pool, seed);
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);
    return { workspaceId, campaignId };
  }

  describe.each([
    {
      lane: "broadcast" as const,
      handle: (job: Job<EmailBroadcastJob>, worker: Worker<EmailBroadcastJob>, deps: Parameters<typeof processSendJob>[1], token: string) =>
        handleEmailBroadcastJob(job, worker, deps, token),
      buildJob: (workspaceId: string, campaignId: string, contactId: string): EmailBroadcastJob => ({
        workspaceId,
        campaignId,
        kind: "campaign",
        contactId,
      }),
    },
    {
      lane: "triggered" as const,
      handle: (job: Job<EmailTriggeredJob>, worker: Worker<EmailTriggeredJob>, deps: Parameters<typeof processSendJob>[1], token: string) =>
        handleEmailTriggeredJob(job, worker, deps, token),
      buildJob: (workspaceId: string, campaignId: string, contactId: string): EmailTriggeredJob => ({
        workspaceId,
        kind: "campaign",
        campaignId,
        contactId,
      }),
    },
  ])("$lane lane", ({ handle, buildJob }) => {
    it("defers a tenant-bucket rejection through deferForTenantBucket, and never pauses the worker (rateLimit uncalled)", async () => {
      const { workspaceId, campaignId } = await arrangeSaturatedWorkspace(`deferral-tb-${Math.random()}`);
      const contactId = await createFixtureContact(workspaceId);

      const job = fakeJob(buildJob(workspaceId, campaignId, contactId));
      const worker = fakeWorker();

      await expect(
        handle(job as never, worker as never, { sendMail: fakeSendMail(202), redisClient }, "tok-tenant")
      ).rejects.toBeInstanceOf(DelayedError);

      expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
      expect(worker.rateLimit).not.toHaveBeenCalled();
    });

    it("throws a plain Error for provider_backoff and never calls moveToDelayed -- the bounded-attempts path is unchanged", async () => {
      const { workspaceId, campaignId } = await arrangeFreshWorkspace(`deferral-pb-${Math.random()}`);
      const contactId = await createFixtureContact(workspaceId);

      const job = fakeJob(buildJob(workspaceId, campaignId, contactId));
      const worker = fakeWorker();

      await expect(
        handle(job as never, worker as never, { sendMail: fakeSendMail(429, { "retry-after": "1" }), redisClient }, "tok-provider")
      ).rejects.toThrow(/SendGrid provider backoff/);

      expect(job.moveToDelayed).not.toHaveBeenCalled();
    });

    it("resolves without throwing for a non-rate_limited outcome (the no-automatic-retry guarantee is preserved)", async () => {
      const { workspaceId, campaignId } = await arrangeFreshWorkspace(`deferral-ok-${Math.random()}`);
      const contactId = await createFixtureContact(workspaceId);

      const job = fakeJob(buildJob(workspaceId, campaignId, contactId));
      const worker = fakeWorker();

      await expect(
        handle(job as never, worker as never, { sendMail: fakeSendMail(202), redisClient }, "tok-ok")
      ).resolves.toBeUndefined();

      expect(job.moveToDelayed).not.toHaveBeenCalled();
    });
  });

  it("broadcast lane: a two-workspace race -- workspace A's tenant-bucket deferral does not stall workspace B's job on the same worker", async () => {
    const { workspaceId: workspaceA, campaignId: campaignA } = await arrangeSaturatedWorkspace(`race-a-${Math.random()}`);
    const contactA = await createFixtureContact(workspaceA);

    const { workspaceId: workspaceB, campaignId: campaignB } = await arrangeFreshWorkspace(`race-b-${Math.random()}`);
    const contactB = await createFixtureContact(workspaceB);

    const jobA = fakeJob<EmailBroadcastJob>({ workspaceId: workspaceA, campaignId: campaignA, kind: "campaign", contactId: contactA });
    const jobB = fakeJob<EmailBroadcastJob>({ workspaceId: workspaceB, campaignId: campaignB, kind: "campaign", contactId: contactB });
    const worker = fakeWorker<EmailBroadcastJob>();

    const [resultA, resultB] = await Promise.allSettled([
      handleEmailBroadcastJob(jobA, worker, { sendMail: fakeSendMail(202), redisClient }, "tok-race-a"),
      handleEmailBroadcastJob(jobB, worker, { sendMail: fakeSendMail(202), redisClient }, "tok-race-b"),
    ]);

    expect(resultA.status).toBe("rejected");
    if (resultA.status === "rejected") {
      expect(resultA.reason).toBeInstanceOf(DelayedError);
    }
    expect(resultB.status).toBe("fulfilled");

    expect(jobA.moveToDelayed).toHaveBeenCalledTimes(1);
    expect(jobB.moveToDelayed).not.toHaveBeenCalled();
    expect(worker.rateLimit).not.toHaveBeenCalled();
  });

  it("triggered lane: a two-workspace race -- workspace A's tenant-bucket deferral does not stall workspace B's job on the same worker", async () => {
    const { workspaceId: workspaceA, campaignId: campaignA } = await arrangeSaturatedWorkspace(`race-trig-a-${Math.random()}`);
    const contactA = await createFixtureContact(workspaceA);

    const { workspaceId: workspaceB, campaignId: campaignB } = await arrangeFreshWorkspace(`race-trig-b-${Math.random()}`);
    const contactB = await createFixtureContact(workspaceB);

    const jobA = fakeJob<EmailTriggeredJob>({ workspaceId: workspaceA, kind: "campaign", campaignId: campaignA, contactId: contactA });
    const jobB = fakeJob<EmailTriggeredJob>({ workspaceId: workspaceB, kind: "campaign", campaignId: campaignB, contactId: contactB });
    const worker = fakeWorker<EmailTriggeredJob>();

    const [resultA, resultB] = await Promise.allSettled([
      handleEmailTriggeredJob(jobA, worker, { sendMail: fakeSendMail(202), redisClient }, "tok-race-trig-a"),
      handleEmailTriggeredJob(jobB, worker, { sendMail: fakeSendMail(202), redisClient }, "tok-race-trig-b"),
    ]);

    expect(resultA.status).toBe("rejected");
    if (resultA.status === "rejected") {
      expect(resultA.reason).toBeInstanceOf(DelayedError);
    }
    expect(resultB.status).toBe("fulfilled");

    expect(jobA.moveToDelayed).toHaveBeenCalledTimes(1);
    expect(jobB.moveToDelayed).not.toHaveBeenCalled();
    expect(worker.rateLimit).not.toHaveBeenCalled();
  });
});
