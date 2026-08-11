import { Queue, Worker, type ConnectionOptions, type Job } from "bullmq";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startTempRedis, type TempRedis } from "@mega-crm/test-support";
import { buildRedisConnectionOptions } from "@mega-crm/queue-core";
import { FLOW_RECONCILIATION_QUEUE, SEND_RECONCILER_QUEUE } from "@mega-crm/shared-schemas";
import { createCampaignSchedulerWorker, waitForCampaignSchedulerRegistration } from "../campaign-scheduler.worker.js";
import {
  createAnalyticsReconciliationWorker,
  waitForAnalyticsReconciliationRegistration,
} from "../analytics-reconciliation.worker.js";
import {
  createFlowReconciliationWorker,
  waitForFlowReconciliationRegistration,
} from "../flows/flow-reconciliation.worker.js";
import {
  createPartitionMaintenanceWorker,
  waitForPartitionMaintenanceRegistration,
  PARTITION_MAINTENANCE_QUEUE,
} from "../partition-maintenance.worker.js";
import { createSendReconcilerWorker, waitForSendReconcilerRegistration } from "../send-reconciler.worker.js";

/**
 * G-12-1 (blocker, UAT test 1): five repeatable-tick workers pass
 * `autorun: options.autorun` straight through to `new Worker(...)`. The
 * composition root (`apps/worker/src/server.ts`) calls every factory with
 * exactly ONE argument -- no options object -- so `options.autorun` is
 * `undefined` under that call shape. BullMQ merges its own defaults with the
 * caller's options via a plain object assign
 * (`Object.assign({ ...defaults, autorun: true }, opts)`); an own property
 * holding `undefined` REPLACES the `true` default rather than falling back
 * to it, and the subsequent `if (this.opts.autorun) { this.run() }` check
 * (falsy on `undefined`) skips starting the processing loop entirely.
 * Construction, listener registration and scheduler registration all still
 * succeed -- only consumption is silently disabled -- which is why the boot
 * log stays clean and the five wait lists grow forever instead of erroring.
 *
 * This file exists to catch EXACTLY that shape: every "production shape"
 * case below calls its factory with a single argument, matching
 * `server.ts`'s own call sites literally -- not with an empty options
 * object, which reproduces the composition root's effective behaviour but
 * not its literal call shape (and would silently stop catching a future
 * parameter-default change).
 *
 * Deliberately NO source-text scan asserting the absence of the broken
 * `autorun: options.autorun` pattern is added anywhere in this file. Both
 * acceptable fixes for the bug (a conditional spread that omits the key
 * entirely, or a nullish-coalescing default) still mention the same option
 * name (`autorun`) and the same parameter (`options.autorun`) as the broken
 * code -- any negative grep over these five files would match the CORRECTED
 * code too and fail on the very fix meant to close this gap. A behavioural
 * test -- does the loop actually start, does a queued job actually get
 * picked up -- is the only regression guard that survives the fix. Do not
 * add a source-text scan here.
 */

interface AutorunFixture {
  label: string;
  tickQueueName: string;
  /** Calls the factory with the connection options as the ONLY argument -- the exact production call shape. */
  createProductionWorker: (connection: ConnectionOptions) => Worker;
  waitForRegistration: (worker: Worker) => Promise<void>;
}

const FIXTURES: AutorunFixture[] = [
  {
    label: "campaign-scheduler",
    tickQueueName: "campaign-scheduler",
    createProductionWorker: (connection) => createCampaignSchedulerWorker(connection),
    waitForRegistration: waitForCampaignSchedulerRegistration,
  },
  {
    label: "analytics-reconciliation",
    tickQueueName: "analytics-reconcile",
    createProductionWorker: (connection) => createAnalyticsReconciliationWorker(connection),
    waitForRegistration: waitForAnalyticsReconciliationRegistration,
  },
  {
    label: "flow-reconciliation",
    tickQueueName: FLOW_RECONCILIATION_QUEUE,
    createProductionWorker: (connection) => createFlowReconciliationWorker(connection),
    waitForRegistration: waitForFlowReconciliationRegistration,
  },
  {
    label: "partition-maintenance",
    tickQueueName: PARTITION_MAINTENANCE_QUEUE,
    createProductionWorker: (connection) => createPartitionMaintenanceWorker(connection),
    waitForRegistration: waitForPartitionMaintenanceRegistration,
  },
  {
    label: "send-reconciler",
    tickQueueName: SEND_RECONCILER_QUEUE,
    createProductionWorker: (connection) => createSendReconcilerWorker(connection),
    waitForRegistration: waitForSendReconcilerRegistration,
  },
];

describe("repeatable-tick worker autorun default (G-12-1, WRK-13)", () => {
  let redis: TempRedis;

  beforeAll(async () => {
    redis = await startTempRedis({});
  });

  afterAll(async () => {
    await redis?.stop();
  });

  describe.each(FIXTURES)("$label", (fixture) => {
    it("constructed with the production single-argument call shape, its processing loop is running", async () => {
      const connection = buildRedisConnectionOptions(redis.url);
      const worker = fixture.createProductionWorker(connection);
      const queue = new Queue(fixture.tickQueueName, { connection });

      try {
        // BullMQ's Worker sets `running` synchronously inside `run()`, which
        // fires (uncalled-back) from the constructor when `autorun` is
        // truthy -- but wait briefly via vi.waitFor rather than asserting
        // immediately, since nothing in this factory's own contract
        // guarantees synchronous timing here, and asserting on a fact that
        // just happens to be synchronous today would be a fragile test.
        await vi.waitFor(() => {
          expect(worker.isRunning()).toBe(true);
        });

        await fixture.waitForRegistration(worker);
      } finally {
        await worker.close();
        await queue.obliterate({ force: true }).catch(() => undefined);
        await queue.close();
      }
    });
  });

  it("campaign-scheduler: a job sitting on its tick queue is picked up and reaches 'active' on a production-shape worker", async () => {
    const connection = buildRedisConnectionOptions(redis.url);
    const worker = createCampaignSchedulerWorker(connection);
    const queue = new Queue("campaign-scheduler", { connection });

    try {
      const activeJobId = "pickup-probe";
      const activePromise = new Promise<void>((resolve) => {
        worker.on("active", (job: Job) => {
          if (job.id === activeJobId) resolve();
        });
      });

      await queue.add("scan-due-campaigns", {}, { jobId: activeJobId });

      // Pickup is the assertion here -- NOT what the processor subsequently
      // does with the job. `findDueCampaignCandidates()` hits a real
      // database scan and may well fail in this harness (no seeded
      // campaigns/workspaces); a processor failure after pickup must never
      // fail this case, since this case exists purely to prove the run loop
      // consumes a waiting job, not that the campaign scan succeeds.
      await activePromise;

      await waitForCampaignSchedulerRegistration(worker);
    } finally {
      await worker.close();
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
    }
  });

  it("the explicit test-only suppression (autorun: false) still prevents the loop from starting", async () => {
    const connection = buildRedisConnectionOptions(redis.url);
    const worker = createPartitionMaintenanceWorker(connection, { autorun: false });
    const queue = new Queue(PARTITION_MAINTENANCE_QUEUE, { connection });

    try {
      // A negative fact can't be proven by waiting for it to become true, so
      // give the (non-existent) run loop a brief window to have started
      // before asserting it never did.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(worker.isRunning()).toBe(false);

      await waitForPartitionMaintenanceRegistration(worker);
    } finally {
      await worker.close();
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
    }
  });
});
