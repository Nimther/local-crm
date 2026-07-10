import type { PoolClient } from "pg";
import { getWorkspaceId, withTenantTransaction } from "../../middleware/tenant-context.js";

export type FlowRunStatus = "waiting" | "advancing" | "completed" | "exited" | "ejected";

/** D-06/D-07/FLOW-01: the only two statuses that count as "in flight". */
const ACTIVE_STATUSES: readonly FlowRunStatus[] = ["waiting", "advancing"];

export interface FlowRunRow {
  id: string;
  workspaceId: string;
  flowId: string;
  flowVersionId: string;
  contactId: string;
  status: FlowRunStatus;
  currentNodeId: string | null;
  nextWakeAt: Date | null;
  enteredAt: Date;
  lastEntryAt: Date;
  exitedAt: Date | null;
  exitReason: string | null;
  contactEmail: string | null;
  contactFirstName: string | null;
  contactLastName: string | null;
  /** true when this run is pinned (flow_version_id) to a version other than the flow's current live_version_id -- FLOW-07 immutability made visible (D-21). */
  onOldVersion: boolean;
}

/** Column list for a `flow_runs fr` row joined to its owning `flows f` (for the on-old-version comparison) and its `contacts c` (for display). */
const FLOW_RUN_COLUMNS = `
  fr.id,
  fr.workspace_id as "workspaceId",
  fr.flow_id as "flowId",
  fr.flow_version_id as "flowVersionId",
  fr.contact_id as "contactId",
  fr.status,
  fr.current_node_id as "currentNodeId",
  fr.next_wake_at as "nextWakeAt",
  fr.entered_at as "enteredAt",
  fr.last_entry_at as "lastEntryAt",
  fr.exited_at as "exitedAt",
  fr.exit_reason as "exitReason",
  c.email as "contactEmail",
  c.first_name as "contactFirstName",
  c.last_name as "contactLastName",
  (fr.flow_version_id <> f.live_version_id) as "onOldVersion"
`;

export interface FlowRunCounts {
  active: number;
  onOldVersions: number;
}

/** Shared by getRunCounts/listRuns so both read the same aggregate inside one transaction/client. */
async function queryRunCounts(client: PoolClient, workspaceId: string, flowId: string): Promise<FlowRunCounts> {
  const { rows } = await client.query<{ active: string; onOldVersions: string }>(
    `SELECT
       count(*) FILTER (WHERE fr.status IN ('waiting','advancing')) as active,
       count(*) FILTER (WHERE fr.status IN ('waiting','advancing') AND fr.flow_version_id <> f.live_version_id) as "onOldVersions"
     FROM flow_runs fr
     JOIN flows f ON f.id = fr.flow_id AND f.workspace_id = fr.workspace_id
     WHERE fr.workspace_id = $1 AND fr.flow_id = $2`,
    [workspaceId, flowId]
  );
  return {
    active: Number(rows[0]?.active ?? 0),
    onOldVersions: Number(rows[0]?.onOldVersions ?? 0),
  };
}

/**
 * D-21/FLOW-07: "N in flow (M on old versions)" -- active = runs currently
 * `waiting`/`advancing`; onOldVersions = the subset of those pinned
 * (flow_version_id) to a version other than the flow's current
 * live_version_id. A run's pin never migrates (FLOW-06/FLOW-07), so this
 * count is the visible cost of that immutability guarantee.
 */
export async function getRunCounts(flowId: string): Promise<FlowRunCounts> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    return queryRunCounts(client, workspaceId, flowId);
  });
}

export interface ListRunsQuery {
  page: number;
  pageSize: number;
  status?: FlowRunStatus;
}

export interface ListRunsResult {
  items: FlowRunRow[];
  total: number;
  page: number;
  pageSize: number;
  counts: FlowRunCounts;
}

/** Paginated run list joined to contact display fields, optionally filtered by status, alongside the same getRunCounts aggregate (read-model for the flow detail page, FLOW-07). */
export async function listRuns(flowId: string, query: ListRunsQuery): Promise<ListRunsResult> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const statusClause = query.status ? `AND fr.status = $3` : "";
    const countParams: unknown[] = query.status ? [workspaceId, flowId, query.status] : [workspaceId, flowId];
    const { rows: countRows } = await client.query<{ count: string }>(
      `SELECT count(*) FROM flow_runs fr WHERE fr.workspace_id = $1 AND fr.flow_id = $2 ${statusClause}`,
      countParams
    );

    const limit = query.pageSize;
    const offset = (query.page - 1) * query.pageSize;
    const listParams: unknown[] = query.status
      ? [workspaceId, flowId, query.status, limit, offset]
      : [workspaceId, flowId, limit, offset];
    const limitPlaceholder = query.status ? "$4" : "$3";
    const offsetPlaceholder = query.status ? "$5" : "$4";

    const { rows } = await client.query<FlowRunRow>(
      `SELECT ${FLOW_RUN_COLUMNS}
       FROM flow_runs fr
       JOIN flows f ON f.id = fr.flow_id AND f.workspace_id = fr.workspace_id
       LEFT JOIN contacts c ON c.id = fr.contact_id AND c.workspace_id = fr.workspace_id
       WHERE fr.workspace_id = $1 AND fr.flow_id = $2 ${statusClause}
       ORDER BY fr.entered_at DESC
       LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`,
      listParams
    );

    const counts = await queryRunCounts(client, workspaceId, flowId);

    return {
      items: rows,
      total: Number(countRows[0]?.count ?? 0),
      page: query.page,
      pageSize: query.pageSize,
      counts,
    };
  });
}

export interface EjectRunsInput {
  runIds?: string[];
  contactIds?: string[];
}

/**
 * D-21: marks matching ACTIVE runs (waiting/advancing) 'ejected' -- single
 * via runIds, bulk via contactIds (either or both may be provided; a run
 * matches if its id OR its contact_id is in the corresponding array).
 * Terminal -- never re-points flow_version_id (FLOW-07: no version
 * migration on eject). The contact may re-enter later if the trigger fires
 * again (D-06 re-entry rules apply as normal).
 */
export async function ejectRuns(flowId: string, input: EjectRunsInput): Promise<number> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const runIds = input.runIds ?? [];
    const contactIds = input.contactIds ?? [];
    const { rows } = await client.query<{ id: string }>(
      `UPDATE flow_runs
       SET status = 'ejected', exit_reason = 'ejected', exited_at = now()
       WHERE workspace_id = $1 AND flow_id = $2 AND status IN ('waiting','advancing')
         AND (id = ANY($3::uuid[]) OR contact_id = ANY($4::uuid[]))
       RETURNING id`,
      [workspaceId, flowId, runIds, contactIds]
    );
    return rows.length;
  });
}

/** D-22 delete-guard primitive: count of currently-active (waiting/advancing) runs for a flow. */
export async function activeRunCount(flowId: string): Promise<number> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*) FROM flow_runs WHERE workspace_id = $1 AND flow_id = $2 AND status = ANY($3::flow_run_status[])`,
      [workspaceId, flowId, ACTIVE_STATUSES]
    );
    return Number(rows[0]?.count ?? 0);
  });
}
