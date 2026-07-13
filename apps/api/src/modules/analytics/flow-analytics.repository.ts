import { getWorkspaceId, withTenantTransaction } from "../../middleware/tenant-context.js";

/**
 * One row per node_id, aggregated by node_id across ALL versions of a flow
 * (D-05, since flow_runs.flow_id spans every version pinned to it -- FLOW-07
 * immutability means an in-flight run keeps its original flow_version_id,
 * but flow_runs.flow_id is stable across republishes). Send-node fields are
 * only present (non-undefined) for node types that produced at least one
 * `sends` row.
 */
export interface FlowNodeAnalyticsRow {
  nodeId: string;
  nodeType: string;
  contactCount: number;
  sent?: number;
  delivered?: number;
  opened?: number;
  clicked?: number;
  bounced?: number;
}

/**
 * ANLT-02/D-02/D-05: per-node metrics for a flow's canvas badges + the
 * "Аналитика" comparison table tab. `contactCount` is
 * `COUNT(DISTINCT fr.contact_id)` over `flow_run_steps` joined to
 * `flow_runs` (Pitfall 4 -- NEVER a raw `COUNT(*)`, which would double-count
 * a contact that re-entered and passed through the same node twice).
 * Aggregation is scoped by `flow_runs.flow_id = $2` (not by any single
 * `flow_version_id`), so a node_id shared across two published versions of
 * the same flow -- including a node_id since removed from the live
 * definition -- is aggregated into ONE row (D-05).
 *
 * Send-node delivery counts are computed via a second query joining `sends`
 * on `(flow_run_id, node_id)`, scoped to the flow through the same
 * `flow_runs` join (a `sends` row's own `workspace_id` already matches via
 * RLS, but the join additionally guarantees the row belongs to a run of
 * THIS flow, not merely this workspace).
 */
export async function getFlowNodeAnalytics(flowId: string): Promise<FlowNodeAnalyticsRow[]> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();

    const { rows: nodeRows } = await client.query<{
      nodeId: string;
      nodeType: string;
      contactCount: string;
    }>(
      `SELECT
         frs.node_id AS "nodeId",
         -- A node_id's type is stable across versions in practice; take any one.
         (array_agg(frs.node_type))[1] AS "nodeType",
         COUNT(DISTINCT fr.contact_id) AS "contactCount"
       FROM flow_run_steps frs
       JOIN flow_runs fr ON fr.id = frs.flow_run_id
       WHERE frs.workspace_id = $1 AND fr.flow_id = $2
       GROUP BY frs.node_id`,
      [workspaceId, flowId]
    );

    const { rows: sendRows } = await client.query<{
      nodeId: string;
      sent: string;
      delivered: string;
      opened: string;
      clicked: string;
      bounced: string;
    }>(
      `SELECT
         s.node_id AS "nodeId",
         COUNT(*) FILTER (WHERE s.sent_at IS NOT NULL) AS sent,
         COUNT(*) FILTER (WHERE s.delivered_at IS NOT NULL) AS delivered,
         COUNT(*) FILTER (WHERE s.first_opened_at IS NOT NULL) AS opened,
         COUNT(*) FILTER (WHERE s.first_clicked_at IS NOT NULL) AS clicked,
         COUNT(*) FILTER (WHERE s.bounced_at IS NOT NULL) AS bounced
       FROM sends s
       JOIN flow_runs fr ON fr.id = s.flow_run_id
       WHERE s.workspace_id = $1 AND fr.flow_id = $2 AND s.node_id IS NOT NULL
       GROUP BY s.node_id`,
      [workspaceId, flowId]
    );

    const sendByNodeId = new Map(sendRows.map((row) => [row.nodeId, row]));

    return nodeRows.map((row) => {
      const send = sendByNodeId.get(row.nodeId);
      const result: FlowNodeAnalyticsRow = {
        nodeId: row.nodeId,
        nodeType: row.nodeType,
        contactCount: Number(row.contactCount),
      };
      if (send) {
        result.sent = Number(send.sent);
        result.delivered = Number(send.delivered);
        result.opened = Number(send.opened);
        result.clicked = Number(send.clicked);
        result.bounced = Number(send.bounced);
      }
      return result;
    });
  });
}
