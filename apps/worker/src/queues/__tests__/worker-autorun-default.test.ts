import { Queue, Worker, type ConnectionOptions, type Job } from "bullmq";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startTempRedis, ensureTestDbMigrated, type TempRedis } from "@mega-crm/test-support";
import { buildRedisConnectionOptions } from "@mega-crm/queue-core";
import { FLOW_RECONCILIATION_QUEUE, SEND_RECONCILER_QUEUE } from "@mega-crm/shared-schemas";
import {
  createCampaignSchedulerWorker,
  waitForCampaignSchedulerRegistration,
  getCampaignSchedulerKickoffQueueForTest,
  findDueCampaignCandidates,
} from "../campaign-scheduler.worker.js";
import { seedDueCampaign, readDueCampaignState } from "../../test/failure-fixtures.js";
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
 *
 * Isolation discipline deliberately differs from the sibling
 * `scheduler-registration.test.ts` suite: that suite shares ONE `TempRedis`
 * across every case, because every one of its workers is constructed with
 * `autorun: false` -- a job scheduler gets registered but no job is ever
 * actually processed, so replaying `upsertJobScheduler` for the SAME
 * scheduler id against the SAME queue, case after case, is invisible. This
 * file is the first suite to construct a REAL (autorun-on) worker against
 * one of these five queues, and an isolated repro (outside this suite)
 * showed that constructing a SECOND real worker against a queue whose job
 * scheduler a FIRST real worker already registered and ran against -- in
 * the SAME Redis instance -- can leave the very next tick job stuck
 * `active` forever: no `completed`, no `failed`, no `error`, just silence.
 * This reproduced with no `obliterate()` involved at all, so it is not a
 * cleanup-ordering bug in this file; it looks like a genuine BullMQ/Redis
 * interaction specific to re-registering a job scheduler for a queue a
 * prior REAL worker in the same process already consumed from. A fresh
 * `TempRedis` per test (via `beforeEach`/`afterEach` below, not a single
 * `beforeAll`/`afterAll`) sidesteps it entirely and is also the more
 * faithful model of what this bug fix actually needs proven: a worker
 * booting once against a fresh queue, the same as a real process start.
 */

/**
 * The accumulated backlog decision (G-12-1 `missing` item 3): while these
 * five workers were silently not consuming, every one of their tick
 * schedulers (and, for four of the five, their per-boot immediate job) kept
 * enqueuing on schedule. The fix in this plan re-enables consumption with no
 * separate drain/triage step -- on the FIRST boot after the fix, every one
 * of those accumulated jobs fires. The decision is to let them fire, with no
 * wait-list cleanup code added anywhere, because every one of these five
 * processors is an idempotent re-scan by construction:
 *
 * - campaign-scheduler: `transitionToSending` re-checks each candidate
 *   exclusively (`FOR UPDATE SKIP LOCKED` + a re-verified `WHERE status =
 *   'scheduled'`) before transitioning it, and the kickoff job it enqueues
 *   carries a deterministic `jobId: campaignId` -- a repeat tick transitions
 *   nothing twice and can never double-kick-off the same campaign. The burst
 *   case below now DEMONSTRATES this on seeded data (one seeded due
 *   campaign, exactly one kickoff job, unchanged on a further scan tick)
 *   rather than leaving it as unbacked reasoning (G-12-3, 12-14).
 * - partition-maintenance: `runPartitionMaintenance` re-runs the same
 *   idempotent horizon-maintenance DDL; repeating it against an
 *   already-sufficient horizon creates nothing new.
 * - analytics-reconciliation: `reconcileWorkspaceDay` OVERWRITES (never
 *   adds to) each recent day's rollup row from a fresh `COUNT(*)` scan --
 *   running it any number of extra times leaves the stored counts
 *   byte-identical.
 * - flow-reconciliation: `transitionAndNudge` re-checks each run's own
 *   due-ness and its parent flow's status in one query before nudging it;
 *   a run a prior tick already advanced no longer matches that predicate
 *   and is skipped.
 * - send-reconciler: `resolveOneSend` claims each candidate row exclusively
 *   (`FOR UPDATE SKIP LOCKED`) before classifying it; a concurrent or
 *   repeated tick racing for the same row claims nothing and returns
 *   `{ kind: "hold" }`.
 *
 * The burst is bounded by each worker's own concurrency (BullMQ's default
 * of 1 for every one of these five) -- the accumulated jobs execute in
 * sequence, not as a concurrent stampede, so there is no additional
 * resource-exhaustion risk beyond an ordinary backlog of that same size
 * ever presented one at a time.
 */

interface AutorunFixture {
  label: string;
  tickQueueName: string;
  /** Calls the factory with the connection options as the ONLY argument -- the exact production call shape. */
  createProductionWorker: (connection: ConnectionOptions) => Worker;
  waitForRegistration: (worker: Worker) => Promise<void>;
}

function waitForJobActive(worker: Worker, jobId: string, timeoutMs = 15_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      worker.off("active", onActive);
      reject(new Error(`timed out waiting for job ${jobId} to reach active`));
    }, timeoutMs);

    const onActive = (job: Job): void => {
      if (job.id !== jobId) return;
      clearTimeout(timeout);
      worker.off("active", onActive);
      resolve();
    };

    worker.on("active", onActive);
  });
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
    // The burst case (below) needs `campaigns` to actually exist and
    // succeed a real scan -- mirrors campaign-scheduler-scan.test.ts's own
    // `beforeAll`. Memoized per test process, so this is a no-op when a
    // sibling file in the same run already migrated the ephemeral database.
    await ensureTestDbMigrated();
  });

  // A fresh throwaway Redis PER TEST, not one shared for the whole file --
  // see the file header comment for why.
  beforeEach(async () => {
    redis = await startTempRedis({});
  });

  afterEach(async () => {
    await redis?.stop();
  });

  describe.each(FIXTURES)("$label", (fixture) => {
    it("constructed with the production single-argument call shape, its processing loop is running", async () => {
      const connection = buildRedisConnectionOptions(redis.url);
      const worker = fixture.createProductionWorker(connection);
      const queue = new Queue(fixture.tickQueueName, { connection });
      const campaignKickoffQueue = getCampaignSchedulerKickoffQueueForTest(worker);

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
        await queue.close();
        await campaignKickoffQueue?.close();
      }
    });
  });

  it("campaign-scheduler: a job sitting on its tick queue is picked up and reaches 'active' on a production-shape worker", async () => {
    const connection = buildRedisConnectionOptions(redis.url);
    const worker = createCampaignSchedulerWorker(connection);
    const queue = new Queue("campaign-scheduler", { connection });
    const kickoffQueue = getCampaignSchedulerKickoffQueueForTest(worker);

    try {
      const activeJobId = "pickup-probe";
      const activePromise = waitForJobActive(worker, activeJobId);

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
      await queue.close();
      await kickoffQueue?.close();
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
      await queue.close();
    }
  });

  it(
    "campaign-scheduler: a stacked burst of identical tick jobs kicks off one seeded due campaign exactly once, never twice",
    async () => {
    // G-12-3: arrange guard -- prove the scan is empty BEFORE seeding, so a
    // due campaign left behind by an earlier file in this run can never make
    // the "exactly one" assertion below pass for the wrong reason.
    expect(await findDueCampaignCandidates()).toEqual([]);

    const { workspaceId, campaignId } = await seedDueCampaign("burst-dedup");

    const dueAfterSeed = await findDueCampaignCandidates();
    expect(dueAfterSeed).toHaveLength(1);
    expect(dueAfterSeed[0]).toMatchObject({ id: campaignId, workspaceId });

    const BURST_SIZE = 20;
    const connection = buildRedisConnectionOptions(redis.url);
    const queue = new Queue("campaign-scheduler", { connection });

    // Stack the burst while nothing is consuming -- a suppressed worker
    // establishes the queue/scheduler exactly as a real boot would, without
    // racing the enqueue below against a live processing loop.
    const suppressedWorker = createCampaignSchedulerWorker(connection, { autorun: false });
    let kickoffQueue: ReturnType<typeof getCampaignSchedulerKickoffQueueForTest>;
    try {
      await waitForCampaignSchedulerRegistration(suppressedWorker);
      kickoffQueue = getCampaignSchedulerKickoffQueueForTest(suppressedWorker);

      for (let i = 0; i < BURST_SIZE; i++) {
        await queue.add("scan-due-campaigns", {}, { jobId: `burst-${String(i)}` });
      }
    } finally {
      await suppressedWorker.close();
    }

    // Now let a production-shape worker (single argument, no options object)
    // drain the accumulated backlog -- this is the exact shape a real boot
    // uses, on the exact backlog this bug lets accumulate.
    const drainWorker = createCampaignSchedulerWorker(connection);
    let drainKickoffQueue: ReturnType<typeof getCampaignSchedulerKickoffQueueForTest>;
    try {
      // `delayed` is deliberately NOT asserted to zero: the job scheduler
      // this worker registers (`upsertJobScheduler`) always keeps one
      // delayed job armed for its NEXT tick once the queue is otherwise
      // drained -- that is the scheduler working as designed, not backlog.
      await vi.waitFor(
        async () => {
          const counts = await queue.getJobCounts("waiting", "active", "failed");
          expect(counts.waiting).toBe(0);
          expect(counts.active).toBe(0);
          expect(counts.failed).toBe(0);
        },
        { timeout: 15_000 }
      );

      await waitForCampaignSchedulerRegistration(drainWorker);

      // G-12-3: the seeded campaign proves the dedup-bearing loop
      // (campaign-scheduler.worker.ts:200-204) actually ran -- exactly one
      // kickoff job across the five states, not the vacuous "zero because
      // nothing was seeded" observation this case used to make.
      drainKickoffQueue = getCampaignSchedulerKickoffQueueForTest(drainWorker);
      const kickoffCounts = await drainKickoffQueue?.getJobCounts(
        "waiting",
        "active",
        "delayed",
        "completed",
        "failed"
      );
      // Nothing consumes CAMPAIGN_KICKOFF_QUEUE in this test, so the single
      // kickoff job sits in `waiting` and never completes -- assert the
      // five-state SUM, not `completed` (contra 12-REVIEW.md WR-03).
      const kickoffTotal =
        (kickoffCounts?.waiting ?? 0) +
        (kickoffCounts?.active ?? 0) +
        (kickoffCounts?.delayed ?? 0) +
        (kickoffCounts?.completed ?? 0) +
        (kickoffCounts?.failed ?? 0);
      expect(kickoffTotal).toBe(1);

      const kickoffJob = await drainKickoffQueue?.getJob(campaignId);
      expect(kickoffJob).toBeDefined();
      expect(kickoffJob?.data).toEqual({ workspaceId, campaignId });

      const seededState = await readDueCampaignState(workspaceId, campaignId);
      expect(seededState.status).toBe("sending");

      // G-12-3 (b): transition-once re-check. A further scan tick must find
      // the campaign no longer `scheduled` and neither re-transition it nor
      // enqueue a second kickoff -- pinned directly (not by inference) via a
      // byte-identical `sending_started_at` and an unchanged kickoff total.
      // Register the `completed` listener BEFORE adding the job, mirroring
      // the pickup-probe pattern above, to close the completion race.
      // `recheck-tick` cannot collide with the burst's `burst-N` ids or the
      // factory's own `boot-*` id.
      const recheckTickId = "recheck-tick";
      const recheckCompletedPromise = new Promise<void>((resolve) => {
        drainWorker.on("completed", (job: Job) => {
          if (job.id === recheckTickId) resolve();
        });
      });
      await queue.add("scan-due-campaigns", {}, { jobId: recheckTickId });
      await recheckCompletedPromise;

      const recheckState = await readDueCampaignState(workspaceId, campaignId);
      expect(recheckState.status).toBe("sending");
      expect(seededState.sendingStartedAt).not.toBeNull();
      expect(recheckState.sendingStartedAt).not.toBeNull();
      expect(recheckState.sendingStartedAt?.getTime()).toBe(seededState.sendingStartedAt?.getTime());

      const recheckKickoffCounts = await drainKickoffQueue?.getJobCounts(
        "waiting",
        "active",
        "delayed",
        "completed",
        "failed"
      );
      const recheckKickoffTotal =
        (recheckKickoffCounts?.waiting ?? 0) +
        (recheckKickoffCounts?.active ?? 0) +
        (recheckKickoffCounts?.delayed ?? 0) +
        (recheckKickoffCounts?.completed ?? 0) +
        (recheckKickoffCounts?.failed ?? 0);
      expect(recheckKickoffTotal).toBe(1);
    } finally {
      // This test's own throwaway Redis (freshly started in `beforeEach`) is
      // stopped in `afterEach` regardless, but close every handle explicitly
      // rather than relying on that teardown to reclaim connections.
      await drainWorker.close();
      await queue.close();
      await kickoffQueue?.close();
      await drainKickoffQueue?.close();
    }
    },
    30_000
  );

  // G-12-3: the other half of the discrimination proof. The case above
  // observes exactly one kickoff on a seeded due campaign; this one observes
  // zero on an empty scan -- together they prove the kickoff-total assertion
  // actually distinguishes "dedup worked" from "nothing happened", instead
  // of an all-zeros assertion that reads the same in both worlds. A handful
  // of ticks, not the full 20-job burst -- burst SIZE is not what this case
  // is about. Its own arrange guard also makes a polluted ephemeral database
  // fail loudly and self-describingly here instead of producing a confusing
  // count mismatch in a sibling case.
  it("campaign-scheduler: no due campaigns produces zero kickoff jobs (control)", async () => {
    const CONTROL_TICKS = 3;
    const connection = buildRedisConnectionOptions(redis.url);
    const queue = new Queue("campaign-scheduler", { connection });

    expect(await findDueCampaignCandidates()).toEqual([]);

    const suppressedWorker = createCampaignSchedulerWorker(connection, { autorun: false });
    let kickoffQueue: ReturnType<typeof getCampaignSchedulerKickoffQueueForTest>;
    try {
      await waitForCampaignSchedulerRegistration(suppressedWorker);
      kickoffQueue = getCampaignSchedulerKickoffQueueForTest(suppressedWorker);

      for (let i = 0; i < CONTROL_TICKS; i++) {
        await queue.add("scan-due-campaigns", {}, { jobId: `control-${String(i)}` });
      }
    } finally {
      await suppressedWorker.close();
    }

    const drainWorker = createCampaignSchedulerWorker(connection);
    let drainKickoffQueue: ReturnType<typeof getCampaignSchedulerKickoffQueueForTest>;
    try {
      await vi.waitFor(
        async () => {
          const counts = await queue.getJobCounts("waiting", "active", "failed");
          expect(counts.waiting).toBe(0);
          expect(counts.active).toBe(0);
          expect(counts.failed).toBe(0);
        },
        { timeout: 15_000 }
      );

      await waitForCampaignSchedulerRegistration(drainWorker);

      drainKickoffQueue = getCampaignSchedulerKickoffQueueForTest(drainWorker);
      const kickoffCounts = await drainKickoffQueue?.getJobCounts(
        "waiting",
        "active",
        "delayed",
        "completed",
        "failed"
      );
      const kickoffTotal =
        (kickoffCounts?.waiting ?? 0) +
        (kickoffCounts?.active ?? 0) +
        (kickoffCounts?.delayed ?? 0) +
        (kickoffCounts?.completed ?? 0) +
        (kickoffCounts?.failed ?? 0);
      expect(kickoffTotal).toBe(0);
    } finally {
      await drainWorker.close();
      await queue.close();
      await kickoffQueue?.close();
      await drainKickoffQueue?.close();
    }
  });
});
