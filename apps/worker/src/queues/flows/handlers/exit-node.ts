import type { PoolClient } from "pg";

export interface ExitNodeCtx {
  client: PoolClient;
  workspaceId: string;
  flowRunId: string;
}

/**
 * Exit-node handler (FLOW-01): reaching an explicit `exit` node on the
 * canvas graph marks the run's path terminal. Distinct from the
 * exit-CONDITION path (`flow-exit-conditions.ts`, `exitReason:
 * 'exit_condition'`) -- this is a graph-structural end, `exitReason:
 * 'reached_exit'`. Writes directly via the caller's already-open
 * transaction `client` (the SAME transaction `flow-run-advance.worker.ts`
 * re-read the run's row under `FOR UPDATE` in) so this write and the
 * `flow_run_steps` append the caller performs afterward commit atomically
 * together.
 */
export async function handleExitNode(ctx: ExitNodeCtx): Promise<void> {
  const { client, workspaceId, flowRunId } = ctx;
  await client.query(
    `UPDATE flow_runs
     SET status = 'completed', exited_at = now(), exit_reason = 'reached_exit'
     WHERE id = $1 AND workspace_id = $2`,
    [flowRunId, workspaceId]
  );
}
