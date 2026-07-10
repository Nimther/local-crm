import type { PoolClient } from "pg";
import type { FlowDefinition } from "@mega-crm/flows-core";
import { getWorkspaceId, withTenantTransaction } from "../../middleware/tenant-context.js";

export interface FlowVersionRow {
  id: string;
  workspaceId: string;
  flowId: string;
  versionNumber: number;
  definition: FlowDefinition;
  publishedAt: Date | null;
  createdAt: Date;
}

const FLOW_VERSION_COLUMNS = `
  id,
  workspace_id as "workspaceId",
  flow_id as "flowId",
  version_number as "versionNumber",
  definition,
  published_at as "publishedAt",
  created_at as "createdAt"
`;

/**
 * FLOW-07: stamps `published_at = now()` on the given (currently-draft)
 * flow_versions row, making it immutable from this point on -- ANY further
 * edit must target a different (new) row. Takes an already-open `client` so
 * callers (publishFlow) can run this as one step of a larger atomic
 * transaction rather than opening a second, separate transaction/connection.
 */
export async function snapshotDraftToVersion(client: PoolClient, versionId: string): Promise<FlowVersionRow> {
  const workspaceId = getWorkspaceId();
  const { rows } = await client.query<FlowVersionRow>(
    `UPDATE flow_versions SET published_at = now()
     WHERE workspace_id = $1 AND id = $2
     RETURNING ${FLOW_VERSION_COLUMNS}`,
    [workspaceId, versionId]
  );
  return rows[0];
}

/**
 * FLOW-06/FLOW-07: reads an immutable version snapshot by id -- the read
 * contract the engine (flow_runs.flow_version_id pin) and the canvas
 * (viewing a past published version) both consume. Returns `null` if the
 * version does not exist within the caller's workspace.
 */
export async function getPinnedVersion(flowVersionId: string): Promise<FlowVersionRow | null> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows } = await client.query<FlowVersionRow>(
      `SELECT ${FLOW_VERSION_COLUMNS} FROM flow_versions WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, flowVersionId]
    );
    return rows[0] ?? null;
  });
}
