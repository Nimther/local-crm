/**
 * 11-09 (D-14): the health-row read/write helpers for `send_reconciler_runs`
 * (migration 0050, schema packages/db/src/schema/send-reconciler-runs.ts).
 * Structurally mirrors packages/db/src/partitions/maintenance-run.ts -- this
 * is the WORKER side of the reconciler's own two-process dead-man's-switch:
 * `apps/worker/src/queues/send-reconciler.worker.ts` writes this row every
 * tick (`recordReconcilerRun`), and `apps/api/src/modules/ops/send-reconciler-watchdog.ts`
 * -- a DIFFERENT process, on its own clock -- only ever reads it
 * (`readLatestReconcilerRun`). Neither process can mask the other's death:
 * a worker that stops ticking simply stops updating `last_run_at`, and the
 * watchdog's own staleness check (an independent poll interval) is what
 * ever notices.
 *
 * Takes the same structural `{ query }`-shaped client type
 * `maintenance-run.ts` takes (not a concrete `Pool`/`PoolClient`), so both
 * the worker's shared `@mega-crm/tenant-context` pool (unscoped -- this
 * table carries no `workspace_id` and needs no `withTenant` scope) and the
 * API's own plain pool can be passed without either side importing "pg".
 */

export interface ReconcilerRunClient {
  query<T = Record<string, unknown>>(queryText: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface ReconcilerRunSnapshot {
  lastRunAt: Date;
  candidatesScanned: number;
  rowsResolved: number;
  rowsMarkedUnknown: number;
  staleDispatchingSwept: number;
  /** The earliest `reconciling_since` this tick observed across every still-`reconciling` row, or `null` when none exist -- a real, distinguishable "no backlog" state, not "unknown". */
  oldestReconcilingSince: Date | null;
}

export interface ReconcilerRunRow extends ReconcilerRunSnapshot {
  id: number;
  /** Owned exclusively by the watchdog (apps/api) -- this module never writes it. */
  lastAlertSentAt: Date | null;
  updatedAt: Date;
}

/**
 * `INSERT ... VALUES (1, ...) ON CONFLICT (id) DO UPDATE SET` against the
 * singleton row -- lists ONLY the worker-owned columns plus `updated_at`.
 * Deliberately never touches `last_alert_sent_at`: that column belongs to
 * the watchdog process (apps/api), and a reconciler tick must never reset an
 * in-flight alert-dedup window just by running. If a future change needs
 * this function to touch that column, it has broken the two-process
 * invariant this module exists to enforce -- do not "fix" a test failure by
 * adding it here.
 */
export async function recordReconcilerRun(
  client: ReconcilerRunClient,
  snapshot: ReconcilerRunSnapshot,
): Promise<void> {
  await client.query(
    `INSERT INTO send_reconciler_runs (
       id, last_run_at, candidates_scanned, rows_resolved, rows_marked_unknown,
       stale_dispatching_swept, oldest_reconciling_since, updated_at
     ) VALUES (1, $1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (id) DO UPDATE SET
       last_run_at = EXCLUDED.last_run_at,
       candidates_scanned = EXCLUDED.candidates_scanned,
       rows_resolved = EXCLUDED.rows_resolved,
       rows_marked_unknown = EXCLUDED.rows_marked_unknown,
       stale_dispatching_swept = EXCLUDED.stale_dispatching_swept,
       oldest_reconciling_since = EXCLUDED.oldest_reconciling_since,
       updated_at = now()`,
    [
      snapshot.lastRunAt,
      snapshot.candidatesScanned,
      snapshot.rowsResolved,
      snapshot.rowsMarkedUnknown,
      snapshot.staleDispatchingSwept,
      snapshot.oldestReconcilingSince,
    ],
  );
}

interface RawReconcilerRunRow {
  id: number;
  last_run_at: Date;
  candidates_scanned: number;
  rows_resolved: number;
  rows_marked_unknown: number;
  stale_dispatching_swept: number;
  oldest_reconciling_since: Date | null;
  last_alert_sent_at: Date | null;
  updated_at: Date;
}

function mapRow(row: RawReconcilerRunRow): ReconcilerRunRow {
  return {
    id: row.id,
    lastRunAt: row.last_run_at,
    candidatesScanned: row.candidates_scanned,
    rowsResolved: row.rows_resolved,
    rowsMarkedUnknown: row.rows_marked_unknown,
    staleDispatchingSwept: row.stale_dispatching_swept,
    oldestReconcilingSince: row.oldest_reconciling_since,
    lastAlertSentAt: row.last_alert_sent_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Reads the singleton health row, or `null` if it is somehow absent (it
 * never should be -- migration 0050 seeds it unconditionally at epoch -- but
 * the reader must not throw on a state it did not cause).
 */
export async function readLatestReconcilerRun(
  client: ReconcilerRunClient,
): Promise<ReconcilerRunRow | null> {
  const { rows } = await client.query<RawReconcilerRunRow>(
    `SELECT id, last_run_at, candidates_scanned, rows_resolved, rows_marked_unknown,
            stale_dispatching_swept, oldest_reconciling_since, last_alert_sent_at, updated_at
       FROM send_reconciler_runs
      WHERE id = 1`,
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}
