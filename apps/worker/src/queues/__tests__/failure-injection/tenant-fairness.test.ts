import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { Redis } from "ioredis";
import { Queue, Worker } from "bullmq";
import * as deliveryCore from "@mega-crm/delivery-core";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { buildRedisConnectionOptions, SEND_LOCK_DURATION_MS } from "@mega-crm/queue-core";
import type { EmailBroadcastJob, EmailTriggeredJob } from "@mega-crm/shared-schemas";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool, createFixtureFlowRun } from "../../../test/db-fixture.js";
import { handleEmailBroadcastJob } from "../../email-broadcast.worker.js";
import { handleEmailTriggeredJob } from "../../email-triggered.worker.js";
import * as rateLimiterModule from "../../rate-limiter.js";
import * as semaphore from "../../tenant-lane-semaphore.js";
import {
  connectFixtureSendgridKey,
  countingSendMail,
  createFixtureCampaign,
  createFixtureContact,
  freshWorkspaceId,
} from "../../../test/failure-fixtures.js";
import { FAIRNESS_SCENARIO_VOLUMES, TENANT_FAIRNESS_MIN_BASELINE_RATIO } from "../../../test/fairness-constants.js";

/**
 * Phase 12 (WRK-03/WRK-04, plan 12-05) -- the phase's own success criterion
 * ("proven by a two-tenant load test, not by code review") made real.
 *
 * Reproduce with `npm run failure:tenant-fairness` from the repo root.
 *
 * Every scenario below injects `sendMail` through the SAME
 * `ProcessSendJobDeps` seam every other failure-injection file uses
 * (`handleEmailBroadcastJob`/`handleEmailTriggeredJob`'s `deps` argument) --
 * no scenario ever constructs `sendTenantMailV3`'s real fetch-based
 * transport, so no SendGrid traffic is generated and no tenant's API key
 * ever leaves this process (T-12-05-01).
 *
 * D-05: "measurably unaffected" is asserted RELATIVE to a baseline captured
 * in the SAME run, never against a hard-coded throughput number -- see
 * `TENANT_FAIRNESS_MIN_BASELINE_RATIO`'s own rationale comment
 * (`fairness-constants.ts`) for why an absolute floor would rot.
 */
describe("failure injection: two-tenant fairness under saturation (WRK-03/WRK-04)", () => {
  let pool: Pool;
  let redisClient: Redis;
  const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";
  const semaphoreKeysToClean: string[] = [];
  const realSendSpy = vi.fn();

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    pool = createTestPool();
    redisClient = new Redis(REDIS_URL);
    // T-12-05-01: proves no scenario in this file ever reaches the real
    // transport, regardless of which case runs or in what order.
    // eslint-disable-next-line @typescript-eslint/require-await -- the mock's signature must match the async function it replaces at the DI seam; it never resolves normally (always throws), so it has nothing to await
    vi.spyOn(deliveryCore, "sendTenantMailV3").mockImplementation(async (...args) => {
      realSendSpy(...args);
      throw new Error("tenant-fairness.test.ts: sendTenantMailV3 must never be called -- every dispatch must use the injected fake seam");
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await pool.end();
    await redisClient.quit();
  });

  afterEach(async () => {
    if (semaphoreKeysToClean.length > 0) {
      await redisClient.del(...semaphoreKeysToClean);
      semaphoreKeysToClean.length = 0;
    }
  });

  function connection(): ReturnType<typeof buildRedisConnectionOptions> {
    return buildRedisConnectionOptions(REDIS_URL);
  }

  function uniqueQueueName(label: string): string {
    return `fairness-${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async function arrangeTenant(
    seed: string,
    rpsLimit: number
  ): Promise<{ workspaceId: string; campaignId: string }> {
    const workspaceId = await freshWorkspaceId(pool, seed);
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) => deliveryCore.upsertWorkspaceSendSettings(client, workspaceId, { rpsLimit }))
    );
    return { workspaceId, campaignId };
  }

  async function createContacts(workspaceId: string, count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      ids.push(await createFixtureContact(workspaceId));
    }
    return ids;
  }

  /** Terminal ledger rows for a campaign -- the throughput measure the plan specifies (counting completed rows over a wall-clock window, not timing individual jobs). */
  async function countTerminalCampaignSends(workspaceId: string, campaignId: string): Promise<number> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*)::text as count FROM sends WHERE workspace_id = $1 AND campaign_id = $2 AND status IN ('sent','failed')`,
          [workspaceId, campaignId]
        );
        return Number(rows[0]?.count ?? 0);
      })
    );
  }

  /** Same shape, scoped to the flow lane (no single campaign_id to filter on -- the workspace is exclusively used for one job set per phase). */
  async function countTerminalFlowSends(workspaceId: string): Promise<number> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*)::text as count FROM sends WHERE workspace_id = $1 AND kind = 'flow' AND status IN ('sent','failed')`,
          [workspaceId]
        );
        return Number(rows[0]?.count ?? 0);
      })
    );
  }

  /** Polls `fetchCount` until it reaches `target`, returning elapsed wall-clock ms. A stalled drain throws rather than hanging the suite. */
  async function measureDrainMs(fetchCount: () => Promise<number>, target: number, maxWaitMs: number): Promise<number> {
    const start = Date.now();
    for (;;) {
      const count = await fetchCount();
      if (count >= target) {
        return Date.now() - start;
      }
      if (Date.now() - start >= maxWaitMs) {
        throw new Error(`measureDrainMs: only reached ${count}/${target} after ${maxWaitMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }

  it(
    "tenant B keeps its own baseline throughput while tenant A saturates its own RPS ceiling (WRK-03/D-05)",
    async () => {
      const { tenantBJobCount, tenantBRpsLimit, tenantAOversaturationJobCount, tenantARpsLimit } =
        FAIRNESS_SCENARIO_VOLUMES;

      // This case measures RPS-bucket fairness specifically (WRK-03), not
      // the tenant-lane-semaphore's OWN concurrency cap (already proven by
      // 12-04's tenant-concurrency-cap.test.ts). Both phases below run a
      // SINGLE tenant's fixed job count through a worker whose concurrency
      // (5) can exceed the broadcast lane's small production default cap
      // (3) purely because that many of ONE tenant's own jobs can be
      // in-flight at once here -- the lane semaphore's crash-safe
      // retry-after estimate (bounded by the multi-second `SEND_SLOT_LEASE_TTL_MS`
      // lease, not by how fast a holder actually releases) would otherwise
      // stall this measurement on a concern this case isn't testing.
      // Widening the cap comfortably above the worker concurrency below
      // means every rate_limited outcome in this case is attributable to
      // the RPS bucket, which is what WRK-03 is actually about.
      const ORIGINAL_BROADCAST_CAP = process.env.TENANT_LANE_CONCURRENCY_BROADCAST;
      process.env.TENANT_LANE_CONCURRENCY_BROADCAST = "20";

      try {
        // --- phase 1: tenant B's solo baseline -----------------------------
        const baseline = await arrangeTenant("fairness-b-baseline", tenantBRpsLimit);
        const baselineContacts = await createContacts(baseline.workspaceId, tenantBJobCount);
        const baselineQueueName = uniqueQueueName("baseline");
        const baselineCounting = countingSendMail(202);
        const baselineQueue = new Queue<EmailBroadcastJob>(baselineQueueName, { connection: connection() });
        const baselineWorker: Worker<EmailBroadcastJob> = new Worker<EmailBroadcastJob>(
          baselineQueueName,
          (job, token) =>
            handleEmailBroadcastJob(job, baselineWorker, { sendMail: baselineCounting.fn, redisClient }, token),
          { connection: connection(), concurrency: 5, lockDuration: SEND_LOCK_DURATION_MS }
        );

        for (const contactId of baselineContacts) {
          await baselineQueue.add("send", {
            workspaceId: baseline.workspaceId,
            campaignId: baseline.campaignId,
            kind: "campaign",
            contactId,
          });
        }

        const baselineDurationMs = await measureDrainMs(
          () => countTerminalCampaignSends(baseline.workspaceId, baseline.campaignId),
          tenantBJobCount,
          20_000
        );
        await baselineWorker.close();
        await baselineQueue.obliterate({ force: true });
        await baselineQueue.close();

        const baselineRate = tenantBJobCount / (baselineDurationMs / 1000);
        expect(baselineCounting.callCount(), "the baseline phase must dispatch every job through the fake seam").toBe(
          tenantBJobCount
        );

        // --- phase 2: tenant A oversaturating alongside tenant B's identical workload ---
        const contendedA = await arrangeTenant("fairness-a-contended", tenantARpsLimit);
        const contendedB = await arrangeTenant("fairness-b-contended", tenantBRpsLimit);
        const contendedAContacts = await createContacts(contendedA.workspaceId, tenantAOversaturationJobCount);
        const contendedBContacts = await createContacts(contendedB.workspaceId, tenantBJobCount);

        const tenantBucketRejections = new Set<string>();
        const originalConsumeTenantToken = rateLimiterModule.consumeTenantToken;
        const consumeSpy = vi
          .spyOn(rateLimiterModule, "consumeTenantToken")
          .mockImplementation(async (redis, workspaceId, rps) => {
            const result = await originalConsumeTenantToken(redis, workspaceId, rps);
            if (!result.allowed) {
              tenantBucketRejections.add(workspaceId);
            }
            return result;
          });

        const contendedQueueName = uniqueQueueName("contended");
        const contendedCounting = countingSendMail(202);
        const contendedQueue = new Queue<EmailBroadcastJob>(contendedQueueName, { connection: connection() });
        const contendedWorker: Worker<EmailBroadcastJob> = new Worker<EmailBroadcastJob>(
          contendedQueueName,
          (job, token) =>
            handleEmailBroadcastJob(job, contendedWorker, { sendMail: contendedCounting.fn, redisClient }, token),
          { connection: connection(), concurrency: 5, lockDuration: SEND_LOCK_DURATION_MS }
        );

        // Interleaved, not sequential: tenant A's flood and tenant B's
        // identical workload arrive "alongside" each other (plan wording),
        // roughly proportional to their relative volumes, so tenant B's jobs
        // are spread throughout the queue rather than clustered at one end.
        const ratio = Math.max(1, Math.round(contendedAContacts.length / contendedBContacts.length));
        let aIndex = 0;
        let bIndex = 0;
        while (aIndex < contendedAContacts.length || bIndex < contendedBContacts.length) {
          for (let i = 0; i < ratio && aIndex < contendedAContacts.length; i += 1) {
            await contendedQueue.add("send", {
              workspaceId: contendedA.workspaceId,
              campaignId: contendedA.campaignId,
              kind: "campaign",
              contactId: contendedAContacts[aIndex],
            });
            aIndex += 1;
          }
          if (bIndex < contendedBContacts.length) {
            await contendedQueue.add("send", {
              workspaceId: contendedB.workspaceId,
              campaignId: contendedB.campaignId,
              kind: "campaign",
              contactId: contendedBContacts[bIndex],
            });
            bIndex += 1;
          }
        }

        const contendedDurationMs = await measureDrainMs(
          () => countTerminalCampaignSends(contendedB.workspaceId, contendedB.campaignId),
          tenantBJobCount,
          30_000
        );
        const contendedRate = tenantBJobCount / (contendedDurationMs / 1000);

        await contendedWorker.close();
        await contendedQueue.obliterate({ force: true });
        await contendedQueue.close();
        consumeSpy.mockRestore();

        // The vacuous-pass guard (T-12-05-02): a run where tenant A never
        // actually crossed its own ceiling would certify fairness it never
        // tested.
        expect(
          tenantBucketRejections.has(contendedA.workspaceId),
          "tenant A must actually receive tenant-scoped deferrals during the contended phase, or this scenario proves nothing"
        ).toBe(true);

        expect(
          contendedRate,
          `tenant B's contended throughput (${contendedRate.toFixed(2)}/s) must stay at or above ` +
            `${TENANT_FAIRNESS_MIN_BASELINE_RATIO} of its own solo baseline (${baselineRate.toFixed(2)}/s)`
        ).toBeGreaterThanOrEqual(baselineRate * TENANT_FAIRNESS_MIN_BASELINE_RATIO);
      } finally {
        if (ORIGINAL_BROADCAST_CAP === undefined) {
          delete process.env.TENANT_LANE_CONCURRENCY_BROADCAST;
        } else {
          process.env.TENANT_LANE_CONCURRENCY_BROADCAST = ORIGINAL_BROADCAST_CAP;
        }
      }
    },
    45_000
  );

  it(
    "a tenant saturating its own broadcast lane does not cost that same tenant's triggered-lane throughput (assumption-delta invariant, 12-01-PLAN.md)",
    async () => {
      const { laneIsolationJobCount, laneIsolationRpsLimit } = FAIRNESS_SCENARIO_VOLUMES;

      async function runTriggeredLane(seed: string): Promise<{ workspaceId: string; durationMs: number }> {
        const workspaceId = await freshWorkspaceId(pool, seed);
        await connectFixtureSendgridKey(workspaceId);
        await withTenant(workspaceId, () =>
          withTenantTransaction((client) =>
            deliveryCore.upsertWorkspaceSendSettings(client, workspaceId, { rpsLimit: laneIsolationRpsLimit })
          )
        );

        const jobPayloads: Array<{ contactId: string; flowRunId: string; nodeId: string }> = [];
        for (let i = 0; i < laneIsolationJobCount; i += 1) {
          const contactId = await createFixtureContact(workspaceId);
          const { flowRunId, nodeId } = await createFixtureFlowRun(workspaceId, contactId, { nodeId: `send-${i}` });
          jobPayloads.push({ contactId, flowRunId, nodeId });
        }

        const queueName = uniqueQueueName("lane");
        const counting = countingSendMail(202);
        const queue = new Queue<EmailTriggeredJob>(queueName, { connection: connection() });
        const worker: Worker<EmailTriggeredJob> = new Worker<EmailTriggeredJob>(
          queueName,
          (job, token) => handleEmailTriggeredJob(job, worker, { sendMail: counting.fn, redisClient }, token),
          { connection: connection(), concurrency: 20, lockDuration: SEND_LOCK_DURATION_MS }
        );

        for (const { contactId, flowRunId, nodeId } of jobPayloads) {
          await queue.add("send", {
            workspaceId,
            kind: "flow",
            flowRunId,
            nodeId,
            contactId,
          } satisfies EmailTriggeredJob);
        }

        const durationMs = await measureDrainMs(() => countTerminalFlowSends(workspaceId), laneIsolationJobCount, 20_000);
        await worker.close();
        await queue.obliterate({ force: true });
        await queue.close();
        expect(counting.callCount()).toBe(laneIsolationJobCount);
        return { workspaceId, durationMs };
      }

      const baseline = await runTriggeredLane("fairness-lane-baseline");
      const baselineRate = laneIsolationJobCount / (baseline.durationMs / 1000);

      // Saturate the SAME tenant's broadcast lane directly through the
      // semaphore module -- deterministic (no real broadcast traffic
      // needed), mirroring tenant-concurrency-cap.test.ts's own `fillLane`
      // convention. Held for the WHOLE triggered-lane run below.
      const contendedWorkspaceId = await freshWorkspaceId(pool, "fairness-lane-contended");
      await connectFixtureSendgridKey(contendedWorkspaceId);
      await withTenant(contendedWorkspaceId, () =>
        withTenantTransaction((client) =>
          deliveryCore.upsertWorkspaceSendSettings(client, contendedWorkspaceId, { rpsLimit: laneIsolationRpsLimit })
        )
      );
      const broadcastCap = semaphore.resolveTenantLaneCap("broadcast");
      semaphoreKeysToClean.push(`tenant-lane-sem:${contendedWorkspaceId}:broadcast`);
      for (let i = 0; i < broadcastCap; i += 1) {
        const result = await semaphore.acquireTenantLaneSlot(redisClient, contendedWorkspaceId, "broadcast", {
          cap: broadcastCap,
        });
        if (!result.acquired) {
          throw new Error("test setup failure: could not pre-fill the broadcast lane to its cap");
        }
      }

      const contended = await runTriggeredLane("fairness-lane-contended-triggered");
      const contendedRate = laneIsolationJobCount / (contended.durationMs / 1000);

      expect(
        contendedRate,
        `the same tenant's triggered-lane throughput (${contendedRate.toFixed(2)}/s) must stay at or above ` +
          `${TENANT_FAIRNESS_MIN_BASELINE_RATIO} of its own solo baseline (${baselineRate.toFixed(2)}/s) ` +
          `even while its broadcast lane is fully saturated`
      ).toBeGreaterThanOrEqual(baselineRate * TENANT_FAIRNESS_MIN_BASELINE_RATIO);
    },
    30_000
  );

  it("no scenario in this file ever constructs the real SendGrid transport (T-12-05-01)", () => {
    // By this point every case above has run -- if any of them had reached
    // sendTenantMailV3, the mock installed in beforeAll would have thrown
    // and failed that case's own assertions long before this one runs.
    expect(realSendSpy).not.toHaveBeenCalled();
  });
});
