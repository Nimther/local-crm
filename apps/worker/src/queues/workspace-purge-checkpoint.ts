import type { Pool, PoolClient } from "pg";

/**
 * Phase 22 (PRG-01/PRG-02/PRG-03/PRG-05, D-05/D-07, plan 22-01): read/write
 * primitives for the `purge_records` checkpoint. Mirrors
 * `apps/worker/src/queues/erasure-scrub-checkpoint.ts`'s shape -- one file,
 * plain functions, no ORM -- with ONLY its storage differing: this
 * checkpoint lives on a brand-new PLATFORM table (`purge_records`, migration
 * 0068) rather than columns bolted onto an existing tenant table, because
 * this checkpoint must survive the destruction of the very tables it walks
 * -- `erasure-scrub-checkpoint.ts`'s storage location (columns on
 * `erasure_records`, a tenant table) cannot be reused for that reason.
 *
 * Unlike `erasure-scrub-checkpoint.ts`'s functions (which require an
 * already-`withTenant`-scoped `PoolClient`, because `erasure_records` is
 * RLS-protected), these functions accept a plain `Pool` OR a `PoolClient`
 * indifferently -- `purge_records` carries no RLS (migration 0068's own
 * header comment), so there is no tenant GUC these queries depend on.
 *
 * DESIGN NOTE, recorded because it is a deliberate departure from this
 * plan's own action-step prose (Rule 1 -- the prose and the plan's own
 * `<behavior>` tests are internally in tension, and the tests are the
 * acceptance bar): `advanceWorkspacePurgeCheckpoint` does NOT accumulate
 * `deletedInPage` into `table_counts`. `table_counts` is written EXACTLY
 * ONCE, by the reporting phase, as the immutable pre-destruction census
 * (D-07/D-10 evidence) -- the plan's own `<behavior>` tests assert
 * `table_counts` is "unchanged from the census" after a full destructive
 * walk and "byte-identical" on replay, which an accumulating write into the
 * SAME column would violate (the census value plus every page's own count
 * would double- or triple-count). A `ctid`-batch DELETE (unlike
 * `erasure-scrub`'s keyset walk) also has no positional cursor to persist
 * per page in the first place -- `completed_tables` is the real per-table
 * resume state, and this function's per-batch call is a liveness heartbeat
 * (`last_progress_at`), useful to a future stuck-purge watchdog (plan
 * 22-08), sharing the SAME transaction as that page's batch DELETE so "one
 * commit, never two" (a must_haves truth) holds by construction.
 */

type PurgeRecordsClient = Pool | PoolClient;

export interface WorkspacePurgeProgress {
  status: string;
  completedTables: string[];
  tableCounts: Record<string, number>;
  firstDestructiveBatchAt: Date | null;
  reportedAt: Date | null;
}

interface WorkspacePurgeProgressRow {
  status: string;
  completedTables: string[];
  tableCounts: Record<string, number>;
  firstDestructiveBatchAt: Date | null;
  reportedAt: Date | null;
}

/** Returns the workspace's `purge_records` row, or `null` if none exists yet (never reported). */
export async function loadWorkspacePurgeProgress(
  client: PurgeRecordsClient,
  workspaceId: string,
): Promise<WorkspacePurgeProgress | null> {
  const { rows } = await client.query<WorkspacePurgeProgressRow>(
    `SELECT status,
            completed_tables AS "completedTables",
            table_counts AS "tableCounts",
            first_destructive_batch_at AS "firstDestructiveBatchAt",
            reported_at AS "reportedAt"
       FROM purge_records
      WHERE workspace_id = $1`,
    [workspaceId],
  );
  return rows[0] ?? null;
}

/**
 * The per-batch liveness heartbeat -- see this module's own header comment
 * for why it does NOT touch `table_counts`. Caller MUST pass the SAME
 * `PoolClient` and the SAME open transaction that issued the batch DELETE
 * (mirrors `erasure-scrub-checkpoint.ts`'s own binding rule), so the
 * heartbeat and the row destruction commit together.
 */
export async function advanceWorkspacePurgeCheckpoint(
  client: PurgeRecordsClient,
  workspaceId: string,
): Promise<void> {
  await client.query(
    `UPDATE purge_records SET last_progress_at = now(), updated_at = now() WHERE workspace_id = $1`,
    [workspaceId],
  );
}

/**
 * Appends `table` to `completed_tables`, guarded so a replay (a job retried
 * after this same UPDATE already committed) cannot append a duplicate
 * entry -- `NOT (completed_tables @> ARRAY[$2])` short-circuits the
 * `array_append` when the table is already present.
 */
export async function markPurgeTableDone(client: PurgeRecordsClient, workspaceId: string, table: string): Promise<void> {
  await client.query(
    `UPDATE purge_records
        SET completed_tables = CASE
              WHEN completed_tables @> ARRAY[$2]::text[] THEN completed_tables
              ELSE array_append(completed_tables, $2)
            END,
            updated_at = now()
      WHERE workspace_id = $1`,
    [workspaceId, table],
  );
}
