import { Queue, Worker, type ConnectionOptions } from "bullmq";
import { Pool } from "pg";
import {
  BUFFER_ALERT_THRESHOLD_MONTHS,
  LOOKAHEAD_MONTHS,
  PARTITION_MAINTENANCE_CRON,
  type PartitionClient,
} from "@mega-crm/db/src/partitions/ensure-partitions.js";
import {
  runPartitionMaintenance,
  type MaintenanceRunSnapshot,
} from "@mega-crm/db/src/partitions/maintenance-run.js";

/**
 * 09-02 (DB-01/DB-02, D-07/D-13): the daily cron-scheduled tick that keeps
 * the `events`/`send_events` partition horizon self-maintaining, plus one
 * immediate off-schedule run per worker boot. This is the WORKER side of
 * the two-process dead-man's-switch this phase builds -- it calls
 * `runPartitionMaintenance` (packages/db/src/partitions/maintenance-run.ts,
 * 09-01) to create any missing months and write the health row;
 * `apps/api/src/modules/ops/partition-watchdog.ts` (09-01, wired into boot
 * by this plan's task 3) is the separate-process READER of that row.
 *
 * Registered with BullMQ's job-scheduler API (`upsertJobScheduler`), NOT the
 * interval-measured-from-boot form the four existing tick workers
 * (`analytics-reconciliation.worker.ts`, `campaign-scheduler.worker.ts`,
 * `flows/flow-reconciliation.worker.ts`, `flows/flow-segment-sweep.worker.ts`)
 * use -- D-13 asks for a fixed UTC hour, not a cadence measured from boot
 * time, so the operator knows when the job runs and the watchdog's
 * staleness threshold has a meaningful reference point. Those four workers
 * deliberately keep their older registration shape; retrofitting them is
 * outside this phase's boundary.
 */

/** This worker's own dedicated queue -- not shared with any other tick. */
export const PARTITION_MAINTENANCE_QUEUE = "partition-maintenance";

/**
 * The stable scheduler id `upsertJobScheduler` dedupes by -- constant
 * across every boot, so registering it twice never creates a second
 * competing schedule (WRK-13, test 2).
 */
const JOB_SCHEDULER_ID = "partition-maintenance-daily";

/** The job name both the scheduled tick and the boot-time immediate run share. */
const JOB_NAME = "run-partition-maintenance";

/**
 * Copied verbatim from `campaign-scheduler.worker.ts`. `removeOnFail: false`
 * is load-bearing here: a failed maintenance job must persist in Redis to
 * be inspectable. Honest state of that signal: Bull Board is not installed
 * in this repository (OPS-14 is Phase 15 scope; only mentioned in a comment
 * in `server.ts`), so a retained failed job is inspectable but nobody is
 * watching a UI -- the operator email (this plan's tasks 2/3) is the actual
 * loud signal.
 */
const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential" as const, delay: 2000 },
  removeOnComplete: { age: 86400 },
  removeOnFail: false,
};

/**
 * 09-REVIEW CR-03: a dedicated Postgres pool for this worker's DB path,
 * entirely separate from `@mega-crm/tenant-context`'s shared, tenant-scoped
 * pool -- mirroring the CLI script
 * (`packages/db/scripts/relocate-default-partition-rows.ts`) and every test
 * suite's own two-pool discipline (see `ensure-partitions.ts`'s comments for
 * the full reasoning, and CONVENTIONS.md's "Partition maintenance" section
 * for the binding rule this codifies). This worker previously defaulted to
 * `@mega-crm/tenant-context`'s `pool` -- the exact pool
 * `withTenantTransaction` checks connections out of for every other tick
 * worker in this same process -- which silently violated that invariant
 * even though this worker's only call path (`ensurePartitions` against
 * always-empty new months) never actually needed FK re-validation
 * visibility into `contacts`/`sends`. A future change that lets this call
 * path attach a pre-populated child (a retry/backfill path, or a refactor
 * that reuses this client for something else) would reintroduce T-09-06
 * with no defence in place -- and, unlike the DEFAULT-relocation CLI (10-06,
 * SEC-01/SEC-02), this worker never holds the elevated
 * `PARTITION_RELOCATION_ADMIN_DATABASE_URL` credential
 * `attachPartitionCheckFirst`'s `options.adminClient` needs for a non-empty
 * attach, so such a change would also need to plumb that credential through
 * deliberately, not merely reuse this pool.
 */
const partitionMaintenancePool = new Pool({ connectionString: process.env.DATABASE_URL });

// Mirrors @mega-crm/tenant-context's own pool.on("error", ...): without
// this listener, an idle-connection termination (Postgres restart/failover/
// idle timeout) on THIS dedicated pool would surface as an uncaught 'error'
// event and crash the whole apps/worker process -- the same failure class
// CR-04 (below) closes for the scheduler-registration path.
partitionMaintenancePool.on("error", (err) => {
  console.error("partition-maintenance: idle pg pool client error (connection dropped)", err);
});

export interface ProcessPartitionMaintenanceDeps {
  client?: PartitionClient;
  now?: () => Date;
  runMaintenance?: typeof runPartitionMaintenance;
}

/**
 * Factored out of the Worker's processor callback so it is testable without
 * a live queue (tests 4/5): defaults to this file's own dedicated
 * `partitionMaintenancePool` (CR-03 -- never the shared, tenant-scoped pool
 * from `@mega-crm/tenant-context`), `Date.now`-based `new Date()`, and the
 * real `runPartitionMaintenance`. Used directly, without `withTenant`/
 * `withTenantTransaction` -- `events`/`send_events`/`partition_maintenance_runs`
 * maintenance is platform-level, exactly as `analytics-reconciliation.worker.ts`
 * uses the plain pool for its own top-level workspace enumeration.
 *
 * No try/catch: none of the four existing tick workers has one, and an
 * unhandled throw is precisely what puts the BullMQ job in the failed set
 * (T-09-09) -- `runPartitionMaintenance` itself already leaves a DDL failure
 * to propagate rather than writing a health row for a run that didn't
 * actually complete.
 */
export async function processPartitionMaintenance(
  deps: ProcessPartitionMaintenanceDeps = {},
): Promise<MaintenanceRunSnapshot> {
  const client = deps.client ?? partitionMaintenancePool;
  const now = deps.now ?? (() => new Date());
  const runMaintenanceFn = deps.runMaintenance ?? runPartitionMaintenance;

  const snapshot = await runMaintenanceFn(client, now(), {
    lookaheadMonths: LOOKAHEAD_MONTHS,
    bufferAlertThresholdMonths: BUFFER_ALERT_THRESHOLD_MONTHS,
  });

  // Pino arrives in Phase 15 / OPS-06 -- console.log carries the same
  // numbers the operator alert email would, so a human reading worker
  // output sees what the watchdog sees.
  console.log("partition-maintenance: run complete", {
    lastRunAt: snapshot.lastRunAt.toISOString(),
    eventsBufferMonths: snapshot.eventsBufferMonths,
    sendEventsBufferMonths: snapshot.sendEventsBufferMonths,
    bufferMonthsRemaining: snapshot.bufferMonthsRemaining,
    eventsDefaultCount: snapshot.eventsDefaultCount,
    sendEventsDefaultCount: snapshot.sendEventsDefaultCount,
    partitionsCreated: snapshot.partitionsCreated,
  });

  return snapshot;
}

export interface CreatePartitionMaintenanceWorkerOptions {
  /**
   * Test-only: BullMQ Workers start processing immediately on construction.
   * Tests 1-3 assert what gets REGISTERED (the scheduler shape, the
   * boot-time job) without wanting a real `processPartitionMaintenance()`
   * run to race against those assertions against the pooled client. Always
   * left at BullMQ's own default (`true`) in production -- this worker must
   * actually process jobs there.
   */
  autorun?: boolean;
}

/**
 * Constructs the partition-maintenance Worker: registers the daily
 * 03:00 UTC job-scheduler (idempotent by `JOB_SCHEDULER_ID` -- test 2) and
 * separately enqueues one immediate off-schedule job with a per-boot unique
 * `jobId` (D-07) so a restart repairs the horizon within seconds instead of
 * waiting up to 24h for the next tick. That unique id also means it can
 * never collide with a still-running job from a previous boot.
 */
/**
 * Test-only synchronization: `createPartitionMaintenanceWorker`'s own
 * scheduler/boot-job registration (and the short-lived internal `Queue`
 * handle it runs through) is fire-and-forget in production, matching every
 * existing tick worker's `void queue.add(...)` shape. A test that tears
 * down its temp Redis immediately after the returned `Worker` closes can
 * otherwise race that background registration's own `queue.close()call --
 * this WeakMap lets `waitForPartitionMaintenanceRegistration` below hand a
 * test a promise that resolves only once registration (including closing
 * that internal handle) has actually settled.
 */
const registrationSettled = new WeakMap<Worker, Promise<void>>();

/**
 * Test-only: resolves once the `Worker` returned by
 * `createPartitionMaintenanceWorker` has finished registering its
 * scheduler and boot-time job (and closed its own internal `Queue`
 * handle). Not used by production code -- `buildWorker()` never awaits
 * this and does not need to; it exists so a test can deterministically
 * order its own cleanup ahead of stopping Redis.
 */
export function waitForPartitionMaintenanceRegistration(worker: Worker): Promise<void> {
  return registrationSettled.get(worker) ?? Promise.resolve();
}

/**
 * Constructs the partition-maintenance Worker: registers the daily
 * 03:00 UTC job-scheduler (idempotent by `JOB_SCHEDULER_ID` -- test 2) and
 * separately enqueues one immediate off-schedule job with a per-boot unique
 * `jobId` (D-07) so a restart repairs the horizon within seconds instead of
 * waiting up to 24h for the next tick. That unique id also means it can
 * never collide with a still-running job from a previous boot.
 */
export function createPartitionMaintenanceWorker(
  connection: ConnectionOptions,
  options: CreatePartitionMaintenanceWorkerOptions = {},
): Worker {
  const queue = new Queue(PARTITION_MAINTENANCE_QUEUE, { connection });
  const bootJobId = `boot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const worker = new Worker(
    PARTITION_MAINTENANCE_QUEUE,
    async () => {
      await processPartitionMaintenance();
    },
    { connection, autorun: options.autorun },
  );

  // Fire-and-forget registration -- the constructor itself stays
  // synchronous, mirroring every existing tick worker's `void queue.add(...)`
  // shape. This worker's own short-lived Queue handle is closed once both
  // calls settle (or fail), so it never leaks a standalone Redis connection
  // past construction (the returned Worker keeps its own separate
  // connection).
  //
  // 09-REVIEW CR-04: nobody in production (`buildWorker()` in
  // apps/worker/src/server.ts) ever awaits or `.catch()`s this promise --
  // `waitForPartitionMaintenanceRegistration` below is test-only. Before
  // this try/catch/finally, a rejecting `upsertJobScheduler`/`add` (a
  // transient Redis hiccup at boot is entirely plausible) became an
  // unhandled promise rejection, which under Node's default
  // `--unhandled-rejections=throw` terminates the WHOLE apps/worker
  // process -- all 14 registered BullMQ workers, not just this one -- over
  // a failure in what is meant to be a best-effort boot-time step. The
  // `finally` also guarantees `queue.close()` always runs, even on failure
  // (previously it was the last statement in the chain and was skipped
  // whenever an earlier `await` threw, leaking the internal `Queue`'s Redis
  // connection).
  const registration = (async () => {
    try {
      await queue.upsertJobScheduler(
        JOB_SCHEDULER_ID,
        { pattern: PARTITION_MAINTENANCE_CRON, tz: "UTC" },
        { name: JOB_NAME, opts: DEFAULT_JOB_OPTIONS },
      );
      await queue.add(JOB_NAME, {}, { ...DEFAULT_JOB_OPTIONS, jobId: bootJobId });
    } catch (err) {
      // Best-effort registration: log, don't crash the process. The daily
      // watchdog (apps/api's partition-watchdog.ts) independently catches a
      // job that consequently never runs.
      console.error("partition-maintenance: scheduler registration failed", err);
    } finally {
      await queue.close().catch(() => undefined);
    }
  })();
  registrationSettled.set(worker, registration);

  return worker;
}
