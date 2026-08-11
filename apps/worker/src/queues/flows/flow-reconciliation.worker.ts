import { Queue, Worker, type ConnectionOptions } from "bullmq";
import { withCrossWorkspaceScan, withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { scrubbedConsole } from "@mega-crm/redaction";
import { FLOW_RECONCILIATION_QUEUE } from "@mega-crm/shared-schemas";
import { buildJobOptions, STANDARD_JOB_RETENTION } from "@mega-crm/queue-core";
import { enqueueFlowRunAdvance } from "./flow-queues.js";

/** The reconciliation worker's own repeatable-tick queue -- self-produced and self-consumed within this file/process only. */
const RECONCILIATION_INTERVAL_MS = 60_000;

/**
 * The stable id `upsertJobScheduler` dedupes by (Phase 12, WRK-13) --
 * constant across every boot, mirrors `partition-maintenance.worker.ts`'s/
 * `send-reconciler.worker.ts`'s/`flow-segment-sweep.worker.ts`'s own
 * scheduler ids, so registering it on every worker boot never creates a
 * second competing schedule.
 */
const JOB_SCHEDULER_ID = "flow-reconciliation-tick";

/** The job name both the scheduled tick and this file's now-removed legacy repeatable job shared. */
const JOB_NAME = "scan-due-flow-runs";

/**
 * WRK-13 one-time cleanup identifiers: the OLD `tickQueue.add({repeat})`
 * registration this migrates away from, named here purely so the cleanup
 * below can be deleted once every environment has booted past this
 * migration. Redis persists across deploys -- leaving this entry in place
 * would run BOTH schedules after this change ships.
 */
const LEGACY_JOB_NAME = "scan-due-flow-runs";
const LEGACY_REPEAT_EVERY_MS = RECONCILIATION_INTERVAL_MS;
const LEGACY_JOB_ID = "scan-due-flow-runs";

/** Built through the shared `@mega-crm/queue-core` factory (Phase 12, WRK-11, D-10). */
const DEFAULT_JOB_OPTIONS = buildJobOptions(STANDARD_JOB_RETENTION);

interface DueFlowRunRow {
  id: string;
  workspaceId: string;
}

/**
 * Admin-side DISCOVERY scan for due waiting flow_runs (T-06-01-03,
 * T-06-05-02; Phase 10 SEC-01/SEC-02, D-01/D-02): runs on the dedicated
 * `mega_crm_scan` login role via `withCrossWorkspaceScan` -- this scan
 * doesn't know which workspace a run belongs to until it reads one, so it
 * can never go through `withTenant`/`withTenantTransaction`. Access control
 * is the role's identity plus migration 0042's role-scoped `flow_runs_scan`
 * policy (narrowed to `status = 'waiting' AND next_wake_at <= now()`), not a
 * session GUC -- `flow_runs_scan` covers `flow_runs` alone, NOT `flows`, so
 * this candidate list may include runs belonging to a `paused` flow; the
 * per-tenant re-verification below is what actually filters those out,
 * D-18/D-19. Deliberately NOT `FOR UPDATE` here, mirroring
 * `campaign-scheduler.worker.ts`'s `findDueCampaignCandidates` exactly: the
 * row-level lock for the actual transition happens per-tenant in
 * `transitionAndNudge`, below.
 */
// Phase 10 plan 10-14 (SEC-16): exported (mirrors campaign-scheduler.worker.ts's
// `findDueCampaignCandidates`/`transitionToSending` precedent exactly) so
// negative-cross-tenant-jobs.test.ts can drive the discovery scan and the
// per-tenant re-verification directly, the same way that file's own
// campaign-scheduler-scan.test.ts sibling already does for the campaign
// scheduler.
export async function findDueFlowRunCandidates(): Promise<DueFlowRunRow[]> {
  return withCrossWorkspaceScan(async (client) => {
    const { rows } = await client.query<DueFlowRunRow>(
      `SELECT id, workspace_id as "workspaceId" FROM flow_runs
       WHERE status = 'waiting' AND next_wake_at <= now()`
    );
    return rows;
  });
}

/**
 * Per-tenant re-verification (T-06-01-03, D-18/D-19): re-scopes via
 * `withTenant`/`withTenantTransaction` -- the SAME discipline every other
 * tenant-scoped write in this codebase uses -- and re-locks the row `FOR
 * UPDATE OF fr SKIP LOCKED`, re-checking BOTH the run's own due-ness AND its
 * PARENT FLOW's status in the SAME query. A `paused` flow's runs are
 * excluded here on EVERY tick and re-picked up automatically on the first
 * tick after resume -- no separate "on resume" code path is needed (D-19).
 * Gracefully skips (rather than blocks on) a row a concurrent tick/process
 * already has locked. The caller only enqueues an advance job when this
 * actually confirms the row is still due.
 */
export async function transitionAndNudge(row: DueFlowRunRow): Promise<boolean> {
  return withTenant(row.workspaceId, () =>
    withTenantTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `SELECT fr.id
         FROM flow_runs fr
         JOIN flows f ON f.id = fr.flow_id
         WHERE fr.id = $1
           AND fr.status = 'waiting'
           AND fr.next_wake_at <= now()
           AND f.status <> 'paused'
         FOR UPDATE OF fr SKIP LOCKED`,
        [row.id]
      );
      return rows.length > 0;
    })
  );
}

/**
 * Constructs the repeatable flow-reconciliation Worker (FLOW-03/D-18/D-19,
 * T-06-05-04): the DURABLE backstop timer for waiting flow_runs -- scans
 * `flow_runs WHERE status='waiting' AND next_wake_at<=now()` every
 * `RECONCILIATION_INTERVAL_MS` (60s, matching `campaign-scheduler.worker.ts`'s
 * cadence), re-verifies each candidate per-tenant, and enqueues a
 * `FLOW_RUN_ADVANCE_QUEUE` job via `enqueueFlowRunAdvance` (CR-01, 06-12 --
 * unique-per-wake jobId, not a reused `flowRunId`) -- a redelivered/duplicate
 * nudge for the SAME run is harmless (the consumer's queue-as-doorbell
 * guards no-op on a run that is not due or already advanced). This scan is a
 * BACKSTOP, not the low-latency
 * path: once delay/wait-until nodes exist (06-07), a BullMQ delayed job set
 * at the moment a run enters a wait step is the low-latency wake mechanism;
 * this repeatable scan exists purely to catch a run whose delayed job was
 * lost (worker crash/restart, Redis data loss) -- Postgres's `next_wake_at`
 * column, not any in-memory timer, is the durable source of truth for what
 * is due. Self-healing/restart-safe by construction: a worker restart's
 * next tick simply re-scans and re-picks any still-due run.
 */
const registrationSettled = new WeakMap<Worker, Promise<void>>();

/**
 * Test-only: resolves once the `Worker` returned by
 * `createFlowReconciliationWorker` has finished registering its scheduler
 * (and closed its own internal tick-registration `Queue` handle). Not used
 * by production code, mirrors `partition-maintenance.worker.ts`'s identical
 * helper.
 */
export function waitForFlowReconciliationRegistration(worker: Worker): Promise<void> {
  return registrationSettled.get(worker) ?? Promise.resolve();
}

export interface CreateFlowReconciliationWorkerOptions {
  /**
   * Test-only, mirrors `partition-maintenance.worker.ts`'s/
   * `send-reconciler.worker.ts`'s identical option: BullMQ Workers start
   * processing immediately on construction; the scheduler-registration test
   * asserts what gets REGISTERED without wanting a real tick to race those
   * assertions against a live database. Omitted entirely from the
   * constructed worker's options unless a caller supplies it (G-12-1):
   * forwarding this key with an `undefined` value under the composition
   * root's one-argument call shape would overwrite BullMQ's own enabling
   * default rather than fall back to it, silently disabling the run loop.
   */
  autorun?: boolean;
}

/**
 * Phase 12 (WRK-13): the tick registration below migrated from the older
 * `tickQueue.add({repeat})` form to `queue.upsertJobScheduler(...)`, the
 * SAME `partition-maintenance.worker.ts`/`send-reconciler.worker.ts`/
 * `flow-segment-sweep.worker.ts` shape -- a stable scheduler id, an
 * immediate boot job, and a `try/catch/finally` that logs a failed
 * registration and always closes this file's own short-lived registration
 * `Queue` handle.
 */
export function createFlowReconciliationWorker(
  connection: ConnectionOptions,
  options: CreateFlowReconciliationWorkerOptions = {}
): Worker {
  const queue = new Queue(FLOW_RECONCILIATION_QUEUE, { connection });
  const bootJobId = `boot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const worker = new Worker(
    FLOW_RECONCILIATION_QUEUE,
    async () => {
      const dueRuns = await findDueFlowRunCandidates();
      for (const row of dueRuns) {
        const stillDue = await transitionAndNudge(row);
        if (!stillDue) continue; // already handled by a prior tick, or its flow is paused -- skip
        await enqueueFlowRunAdvance({ workspaceId: row.workspaceId, flowRunId: row.id });
      }
    },
    // G-12-1: the `autorun` key is included ONLY when a caller actually
    // supplied a value (mirrors `flow-segment-sweep.worker.ts`, which never
    // mentions the key at all) -- never nullish-coalesced to a restated
    // `true`, which would be a second source of truth for a value BullMQ
    // already owns. Under the composition root's single-argument call
    // shape, `options.autorun` is `undefined` and this spread contributes
    // nothing, leaving BullMQ's own default in effect.
    { connection, ...(options.autorun !== undefined ? { autorun: options.autorun } : {}) }
  );

  // Fire-and-forget registration -- mirrors partition-maintenance.worker.ts's
  // try/catch/finally exactly: a Redis hiccup at boot must log, not crash
  // every other registered worker via an unhandled promise rejection; the
  // `finally` always closes this short-lived internal Queue handle so a
  // failure here never leaks a standalone Redis connection past construction.
  const registration = (async () => {
    try {
      await queue.upsertJobScheduler(
        JOB_SCHEDULER_ID,
        { every: RECONCILIATION_INTERVAL_MS },
        { name: JOB_NAME, opts: DEFAULT_JOB_OPTIONS }
      );
      await queue.add(JOB_NAME, {}, { ...DEFAULT_JOB_OPTIONS, jobId: bootJobId });

      // WRK-13 one-time cleanup: remove the legacy repeatable entry this
      // file's OLD registration form created. Tolerated not-found (a fresh
      // environment never had it) -- remove this block once every
      // environment has booted past this migration.
      await queue.removeRepeatable(LEGACY_JOB_NAME, { every: LEGACY_REPEAT_EVERY_MS }, LEGACY_JOB_ID);
    } catch (err) {
      scrubbedConsole.error("flow-reconciliation: scheduler registration failed", err);
    } finally {
      await queue.close().catch(() => undefined);
    }
  })();
  registrationSettled.set(worker, registration);

  return worker;
}
