import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { Redis } from "ioredis";
import { Queue, Worker } from "bullmq";
import { buildRedisConnectionOptions, SEND_LOCK_DURATION_MS } from "@mega-crm/queue-core";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { upsertWorkspaceSendSettings } from "@mega-crm/delivery-core";
import type { EmailBroadcastJob } from "@mega-crm/shared-schemas";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../../test/db-fixture.js";
import { handleEmailBroadcastJob } from "../../email-broadcast.worker.js";
import { DEFAULT_TENANT_RPS } from "../../rate-limiter.js";
import {
  connectFixtureSendgridKey,
  countingSendMail,
  createFixtureCampaign,
  createFixtureContact,
  freshWorkspaceId,
} from "../../../test/failure-fixtures.js";
import { LOADTEST_TENANT_RPS_DURATION_MS } from "../../../test/fairness-constants.js";

/**
 * Phase 12 (WRK-04, plan 12-05) -- the on-demand full-scale half of D-06.
 *
 * Reproduce with `npm run loadtest:tenant-rps` from the repo root.
 * Deliberately NOT wired into CI (D-04) -- it runs for
 * `LOADTEST_TENANT_RPS_DURATION_MS` (currently 15s) at the real
 * `DEFAULT_TENANT_RPS`, which would slow every pull request for no benefit
 * once the CI-resident, scaled-down `tenant-fairness.test.ts` already proves
 * the fairness MECHANISM on every PR.
 *
 * Runs entirely on the fake `sendMail` seam (T-12-05-01) -- no SendGrid
 * traffic, so this never risks a real tenant's sending reputation.
 */
describe("loadtest: DEFAULT_TENANT_RPS sustained throughput (WRK-04)", () => {
  let pool: Pool;
  let redisClient: Redis;
  const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";
  const ORIGINAL_BROADCAST_CAP = process.env.TENANT_LANE_CONCURRENCY_BROADCAST;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    pool = createTestPool();
    redisClient = new Redis(REDIS_URL);
    // Same rationale as tenant-fairness.test.ts's own override: this run is
    // a SINGLE tenant sustaining DEFAULT_TENANT_RPS through one queue whose
    // worker concurrency (below) can exceed the broadcast lane's small
    // production cap purely because that many of this ONE tenant's own jobs
    // can be in-flight at once -- widening the cap keeps this measurement
    // about the RPS ceiling, not about the lane-concurrency cap (already
    // proven separately by 12-04's tenant-concurrency-cap.test.ts).
    process.env.TENANT_LANE_CONCURRENCY_BROADCAST = "50";
  });

  afterAll(async () => {
    if (ORIGINAL_BROADCAST_CAP === undefined) {
      delete process.env.TENANT_LANE_CONCURRENCY_BROADCAST;
    } else {
      process.env.TENANT_LANE_CONCURRENCY_BROADCAST = ORIGINAL_BROADCAST_CAP;
    }
    await pool.end();
    await redisClient.quit();
  });

  it(
    "sustains DEFAULT_TENANT_RPS for the configured duration without the queue's waiting depth growing",
    async () => {
      const durationMs = LOADTEST_TENANT_RPS_DURATION_MS;
      const rps = DEFAULT_TENANT_RPS;
      const intervalMs = 1000 / rps;
      // A 15% buffer over the theoretical job count absorbs setTimeout/event-loop
      // jitter in the producer loop below without ever running the contact
      // pool dry before the window's wall-clock deadline is reached.
      const contactBudget = Math.ceil((rps * durationMs) / 1000 * 1.15) + 5;

      const workspaceId = await freshWorkspaceId(pool, "loadtest-tenant-rps");
      await connectFixtureSendgridKey(workspaceId);
      const campaignId = await createFixtureCampaign(workspaceId);
      await withTenant(workspaceId, () =>
        withTenantTransaction((client) => upsertWorkspaceSendSettings(client, workspaceId, { rpsLimit: rps }))
      );

      const contactIds: string[] = [];
      for (let i = 0; i < contactBudget; i += 1) {
        contactIds.push(await createFixtureContact(workspaceId));
      }

      const connection = () => buildRedisConnectionOptions(REDIS_URL);
      const queueName = `loadtest-tenant-rps-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const counting = countingSendMail(202);
      const queue = new Queue<EmailBroadcastJob>(queueName, { connection: connection() });
      const worker: Worker<EmailBroadcastJob> = new Worker<EmailBroadcastJob>(
        queueName,
        (job, token) => handleEmailBroadcastJob(job, worker, { sendMail: counting.fn, redisClient }, token),
        // Comfortably above `rps` so the WORKER's own concurrency is never
        // the bottleneck being measured -- this test is about the per-tenant
        // token bucket's sustained ceiling, not about worker pool sizing.
        { connection: connection(), concurrency: Math.max(20, rps * 2), lockDuration: SEND_LOCK_DURATION_MS }
      );

      // Continuous production at the configured RPS for the FULL window --
      // not a single upfront burst. A burst would only ever drain
      // monotonically and could never show a growing backlog; feeding the
      // queue at the same pace real production traffic would is what makes
      // the waiting-depth comparison below mean anything.
      let enqueuedCount = 0;
      const windowStart = Date.now();
      const startWaiting = await queue.getWaitingCount();

      const producing = (async () => {
        while (Date.now() - windowStart < durationMs && enqueuedCount < contactIds.length) {
          await queue.add("send", {
            workspaceId,
            campaignId,
            kind: "campaign",
            contactId: contactIds[enqueuedCount],
          });
          enqueuedCount += 1;
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
      })();

      // Midpoint sample is diagnostic (logged, not asserted on its own) --
      // the plan's actual assertion compares start vs. end.
      await new Promise((resolve) => setTimeout(resolve, durationMs / 2));
      const midWaiting = await queue.getWaitingCount();

      await producing;
      const endWaiting = await queue.getWaitingCount();

      console.log(
        `loadtest:tenant-rps -- enqueued=${enqueuedCount} completed=${counting.callCount()} ` +
          `waiting[start=${startWaiting} mid=${midWaiting} end=${endWaiting}]`
      );

      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();

      // A growing backlog is what "cannot sustain the configured RPS" looks
      // like -- the tolerance absorbs the last fractional second's worth of
      // in-flight jobs without masking genuine, sustained backlog growth.
      const waitingDepthTolerance = Math.ceil(rps * 0.5) + 2;
      expect(
        endWaiting,
        `waiting depth grew from ${startWaiting} to ${endWaiting} (tolerance ${waitingDepthTolerance}) -- ` +
          `the pipeline could not keep pace with DEFAULT_TENANT_RPS=${rps}`
      ).toBeLessThanOrEqual(startWaiting + waitingDepthTolerance);

      const expectedCompleted = (rps * durationMs) / 1000;
      const completedTolerance = expectedCompleted * 0.2;
      expect(
        counting.callCount(),
        `completed ${counting.callCount()} sends in ${durationMs}ms, expected ~${expectedCompleted.toFixed(0)} ` +
          `(±${completedTolerance.toFixed(0)}) at DEFAULT_TENANT_RPS=${rps}`
      ).toBeGreaterThanOrEqual(expectedCompleted - completedTolerance);
    },
    LOADTEST_TENANT_RPS_DURATION_MS + 30_000
  );
});
