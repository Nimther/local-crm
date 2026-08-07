import { Queue, Worker, type ConnectionOptions } from "bullmq";
import { withCrossWorkspaceScan, withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { FLOW_RECONCILIATION_QUEUE } from "@mega-crm/shared-schemas";
import { enqueueFlowRunAdvance } from "./flow-queues.js";

/** The reconciliation worker's own repeatable-tick queue -- self-produced and self-consumed within this file/process only. */
const RECONCILIATION_INTERVAL_MS = 60_000;

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
async function findDueFlowRunCandidates(): Promise<DueFlowRunRow[]> {
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
async function transitionAndNudge(row: DueFlowRunRow): Promise<boolean> {
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
export function createFlowReconciliationWorker(connection: ConnectionOptions): Worker {
  const tickQueue = new Queue(FLOW_RECONCILIATION_QUEUE, { connection });
  // Idempotent registration: BullMQ dedupes a repeatable job by its own
  // repeat config + jobId, so calling this on every worker boot never
  // creates a second competing repeatable schedule.
  void tickQueue.add(
    "scan-due-flow-runs",
    {},
    { repeat: { every: RECONCILIATION_INTERVAL_MS }, jobId: "scan-due-flow-runs" }
  );

  return new Worker(
    FLOW_RECONCILIATION_QUEUE,
    async () => {
      const dueRuns = await findDueFlowRunCandidates();
      for (const row of dueRuns) {
        const stillDue = await transitionAndNudge(row);
        if (!stillDue) continue; // already handled by a prior tick, or its flow is paused -- skip
        await enqueueFlowRunAdvance({ workspaceId: row.workspaceId, flowRunId: row.id });
      }
    },
    { connection }
  );
}
