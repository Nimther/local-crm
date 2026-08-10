import type { PoolClient } from "pg";

/**
 * Phase 12 (WRK-05/WRK-06, D-09): transaction-scoped read/write for the
 * segment sweep's per-flow resume cursor (`flow_segment_sweep_checkpoint`,
 * migration 0053). All three functions take a `PoolClient` as their first
 * argument -- they never open their own connection -- so the caller can run
 * a checkpoint write on the SAME transaction as that page's enrollment
 * writes. D-09 requires this: a page's enrollment work and its cursor
 * advance must commit together, or a kill between them could leave a page
 * "done" with no cursor to prove it (re-doing that page on resume) or a
 * cursor advanced past enrollment work that never committed (silently
 * skipping it forever).
 *
 * Every call site is expected to already be inside `withTenant`/
 * `withTenantTransaction` -- these functions issue plain, RLS-scoped SQL
 * against `flow_segment_sweep_checkpoint`, which carries the SAME
 * fail-closed `workspace_isolation` policy every other tenant-scoped table
 * in this codebase does (migration 0053's own header comment). A query
 * against this table with no workspace scope set raises rather than
 * returning zero rows -- by construction of that policy, not anything this
 * file does itself.
 */

/**
 * Returns the flow's stored resume cursor, or `null` when no checkpoint row
 * exists yet (first-ever sweep of this flow) OR a prior walk completed a
 * full pass and reset it (see `resetSweepCheckpoint` below) -- both cases
 * mean "start this walk from the beginning".
 */
export async function loadSweepCheckpoint(
  client: PoolClient,
  workspaceId: string,
  flowId: string
): Promise<string | null> {
  const { rows } = await client.query<{ cursor: string | null }>(
    `SELECT cursor FROM flow_segment_sweep_checkpoint WHERE workspace_id = $1 AND flow_id = $2`,
    [workspaceId, flowId]
  );
  return rows[0]?.cursor ?? null;
}

/**
 * Upserts the flow's checkpoint row so a subsequent `loadSweepCheckpoint`
 * call on the SAME client (or any later transaction) returns `lastContactId`.
 * Called at the end of every page that returned at least one row -- never
 * for a page that returned zero rows, which is `resetSweepCheckpoint`'s job
 * instead (a walk can be resumed to "one page further along" or "reset to
 * the start"; there is no third state).
 */
export async function advanceSweepCheckpoint(
  client: PoolClient,
  workspaceId: string,
  flowId: string,
  lastContactId: string
): Promise<void> {
  await client.query(
    `INSERT INTO flow_segment_sweep_checkpoint (workspace_id, flow_id, cursor)
     VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, flow_id) DO UPDATE SET cursor = $3, updated_at = now()`,
    [workspaceId, flowId, lastContactId]
  );
}

/**
 * Clears the flow's cursor back to `NULL`, so the NEXT walk re-starts from
 * the beginning of `contacts.id` order. Exists because this sweep is
 * PERPETUAL, unlike `recipient-snapshot.ts`'s `campaigns.snapshot_cursor`,
 * which is a one-shot freeze that is written once and never reset --
 * copying that permanent-cursor semantics here would silently and
 * permanently skip any contact whose id sorts behind the last cursor
 * position and who was inserted into the matching set between two ticks
 * (e.g. a bulk CSV-import property update, or a segment definition edit
 * that newly includes a previously-unmatched contact) -- the segment's
 * membership can change in ways no single event announces, and a
 * never-resetting cursor would make this walk blind to exactly that class
 * of change forever. Called when a page returns zero rows -- i.e. the walk
 * has reached the end of `contacts.id` order for this flow's current
 * matching set.
 */
export async function resetSweepCheckpoint(client: PoolClient, workspaceId: string, flowId: string): Promise<void> {
  await client.query(
    `INSERT INTO flow_segment_sweep_checkpoint (workspace_id, flow_id, cursor)
     VALUES ($1, $2, NULL)
     ON CONFLICT (workspace_id, flow_id) DO UPDATE SET cursor = NULL, updated_at = now()`,
    [workspaceId, flowId]
  );
}
