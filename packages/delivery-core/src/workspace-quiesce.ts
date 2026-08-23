import type { PoolClient } from "pg";

/**
 * The exclusion-reason literal `recordExcluded`/`recordFlowExcluded` write
 * when a dispatch-time quiesce check refuses a job for a workspace whose
 * `organization."deletedAt"` has been set (PRG-06, D-01/D-03). `sends.
 * exclusion_reason` is a plain `text` column, not an enum -- adding this
 * literal needs no migration.
 */
export const WORKSPACE_DELETED_EXCLUSION_REASON = "workspace_deleted";

/**
 * The single shared, fail-closed dispatch-time quiesce lookup (PRG-06, SC1,
 * T-22-02-01/03/04) -- every send-dispatch path (campaign, flow, test-send)
 * and the campaign-kickoff fan-out guard call this ONE function before doing
 * anything else that could result in mail leaving this process, so "is this
 * workspace deleted" can never drift between call sites the way a
 * hand-rolled second query would risk.
 *
 * Reads `organization."deletedAt"` FRESH on every call -- the column is the
 * quoted camelCase better-auth `additionalFields` column
 * (`packages/db/src/schema/auth.ts`), not a snake_case one. Callers must
 * never cache this result across jobs: the whole point of this dispatch-time
 * check (as opposed to the discovery-query fix elsewhere in this phase) is
 * catching a workspace deleted AFTER a job was already enqueued -- a job
 * enqueued at 11:59:58 must still be refused by a 12:00:00 soft delete.
 *
 * Fail-closed by construction (T-22-02-03): returns `true` (refuse) both
 * when `deletedAt` is non-null AND when the `organization` row cannot be
 * found at all. A missing row should not normally happen for a workspace
 * with live send jobs in flight, but treating "not found" as "not deleted"
 * would be exactly backwards for a gate whose entire job is refusing to send
 * when it cannot prove the workspace is still live.
 *
 * Deliberately does NOT join `purge_records`: quiesce begins the instant
 * `organization.deletedAt` is set, long before any purge record exists (the
 * physical purge worker elsewhere in this phase runs on its own
 * retention-day delay after soft delete). Joining `purge_records` here would
 * let mail keep flowing for the entire quiesce-to-purge window this phase
 * exists to close.
 */
export async function isWorkspaceSoftDeleted(client: PoolClient, workspaceId: string): Promise<boolean> {
  const { rows } = await client.query<{ deletedAt: Date | null }>(
    `SELECT "deletedAt" FROM organization WHERE id = $1`,
    [workspaceId]
  );
  const row = rows[0];
  if (!row) {
    return true;
  }
  return row.deletedAt !== null;
}
