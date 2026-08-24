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
 * `deletedInPage` into `table_counts`. The tenant-table census keys (every
 * name in `PURGE_TABLE_ORDER`) are written EXACTLY ONCE, by the reporting
 * phase, as the immutable pre-destruction census (D-07/D-10 evidence) -- the
 * plan's own `<behavior>` tests assert `table_counts` is "unchanged from the
 * census" after a full destructive walk and "byte-identical" on replay,
 * which an accumulating write into the SAME column would violate (the
 * census value plus every page's own count would double- or triple-count).
 * A `ctid`-batch DELETE (unlike `erasure-scrub`'s keyset walk) also has no
 * positional cursor to persist per page in the first place --
 * `completed_tables` is the real per-table resume state, and this
 * function's per-batch call is a liveness heartbeat (`last_progress_at`),
 * useful to a future stuck-purge watchdog (plan 22-08), sharing the SAME
 * transaction as that page's batch DELETE so "one commit, never two" (a
 * must_haves truth) holds by construction.
 *
 * Gap-closure plan 22-11 reconciles this same claim for the AUTH keys
 * (`member`, `invitation`, see `recordAuthPurgeCounts` below): those two
 * keys are written once by the DESTRUCTIVE phase, before the auth delete,
 * and every later write for those keys is a no-op by construction (the
 * write-once jsonb merge). The tenant-table census keys above remain
 * written once by the reporting phase, unchanged.
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

/**
 * Phase 22 (PRG-02, D-10/D-12, plan 22-07; write-once merge added by
 * gap-closure plan 22-11) merges the auth step's two destroyed-row counts
 * (`member`, `invitation`) into the SAME `table_counts` jsonb payload the
 * tenant-table census above populates -- one evidence record describing the
 * whole purge, not two separate shapes.
 *
 * THE CRASH WINDOW THIS CLOSES: a purge killed after `deleteWorkspaceAuthRows`
 * commits on the elevated pool but before this write lands would, under a
 * naive merge, resume into a re-count of zero rows (the rows are already
 * gone) and record `{ member: 0, invitation: 0 }` as the FIRST successful
 * write for those keys -- destroying the real census permanently. Plan 22-11
 * closes this window from BOTH ends: `workspace-purge.worker.ts` now calls
 * `countWorkspaceAuthRows` and this function BEFORE `deleteWorkspaceAuthRows`
 * ever runs, so the real counts are captured while the rows still exist; and
 * this function is WRITE-ONCE, so even a resumed tick that re-enters this
 * step (auth already deleted, about to re-record) can never overwrite a
 * count already present.
 *
 * WRITE-ONCE MECHANISM: the freshly built
 * `jsonb_build_object('member', $2::int, 'invitation', $3::int)` is the LEFT
 * operand of the `||` concatenation and the existing `table_counts` column is
 * the RIGHT operand -- Postgres's jsonb `||` operator resolves duplicate keys
 * to the RIGHT-hand value, so any `member`/`invitation` key already present
 * in `table_counts` always wins over the freshly built object, while a key
 * that is genuinely absent still gets added. No `WHERE` guard is needed --
 * the operand order alone is the guard, and it handles the two keys
 * independently (a workspace could in principle carry one already-recorded
 * key and one still-absent key, though in practice both keys land together
 * from the same call). No `COALESCE` wrapper is needed or wanted either:
 * migration 0068 declares `table_counts jsonb NOT NULL DEFAULT '{}'::jsonb`,
 * so a null left-hand value is structurally impossible.
 *
 * Called exactly once per successful auth step, from
 * `apps/worker/src/queues/workspace-purge.worker.ts`, on the SAME
 * `platformClient` connection, now BEFORE `deleteWorkspaceAuthRows` --
 * see that file's own auth-step block comment for the full ordering.
 */
export async function recordAuthPurgeCounts(
  client: PurgeRecordsClient,
  workspaceId: string,
  counts: { memberCount: number; invitationCount: number },
): Promise<void> {
  await client.query(
    `UPDATE purge_records
        SET table_counts = jsonb_build_object('member', $2::int, 'invitation', $3::int) || table_counts,
            updated_at = now()
      WHERE workspace_id = $1`,
    [workspaceId, counts.memberCount, counts.invitationCount],
  );
}
