import { Queue, Worker, type ConnectionOptions } from "bullmq";
import { pool } from "@mega-crm/tenant-context";
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

export interface ProcessPartitionMaintenanceDeps {
  client?: PartitionClient;
  now?: () => Date;
  runMaintenance?: typeof runPartitionMaintenance;
}

/**
 * Factored out of the Worker's processor callback so it is testable without
 * a live queue (tests 4/5): defaults to the pooled client from
 * `@mega-crm/tenant-context`, `Date.now`-based `new Date()`, and the real
 * `runPartitionMaintenance`. Used directly, without `withTenant`/
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
  const client = deps.client ?? pool;
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
  // calls settle, so it never leaks a standalone Redis connection past
  // construction (the returned Worker keeps its own separate connection).
  const registration = (async () => {
    await queue.upsertJobScheduler(
      JOB_SCHEDULER_ID,
      { pattern: PARTITION_MAINTENANCE_CRON, tz: "UTC" },
      { name: JOB_NAME, opts: DEFAULT_JOB_OPTIONS },
    );
    await queue.add(JOB_NAME, {}, { ...DEFAULT_JOB_OPTIONS, jobId: bootJobId });
    await queue.close();
  })();
  registrationSettled.set(worker, registration);

  return worker;
}
