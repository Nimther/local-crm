import type { PoolClient } from "pg";
import { compileSegmentDefinition, type SegmentDefinition } from "@mega-crm/segments-core";
import type { FlowDefinition, FlowBranchNode } from "@mega-crm/flows-core";

export interface BranchNodeCtx {
  client: PoolClient;
  workspaceId: string;
  contactId: string;
  node: FlowBranchNode;
  definition: FlowDefinition;
}

export interface BranchNodeResult {
  branch: "yes" | "no";
  nextNodeId: string | null;
}

/**
 * D-13: resolves the branch node's outgoing edge whose `sourceHandle`
 * matches the resolved branch ("yes"/"no") -- a branch node's two logical
 * paths are expressed via `sourceHandle`, never a node-level field (see
 * flow-definition-schema.ts).
 */
function resolveBranchNextNodeId(definition: FlowDefinition, nodeId: string, branch: "yes" | "no"): string | null {
  const edge = definition.edges.find((candidate) => candidate.source === nodeId && candidate.sourceHandle === branch);
  return edge?.target ?? null;
}

/**
 * D-12: point-check "is contact in segment" -- the SAME compiled-WHERE
 * primitive `apps/api/src/modules/segments/segment.repository.ts`'s
 * `isContactInSegment` wraps. Not imported directly: apps/worker has no
 * dependency path to apps/api's source (02-06 precedent, already applied by
 * `flow-exit-conditions.ts` for the exit-condition segment check) -- calls
 * `@mega-crm/segments-core`'s `compileSegmentDefinition` directly instead of
 * reimplementing segment SQL a second time.
 */
async function isContactInSegmentPointCheck(
  client: PoolClient,
  workspaceId: string,
  def: SegmentDefinition,
  contactId: string
): Promise<boolean> {
  const { whereSql, params } = compileSegmentDefinition(def, workspaceId);
  const pointCheckParams = [...params, contactId];
  const { rows } = await client.query(
    `SELECT 1 FROM contacts c WHERE ${whereSql} AND c.id = $${pointCheckParams.length} LIMIT 1`,
    pointCheckParams
  );
  return rows.length > 0;
}

/**
 * Binary branch-node handler (FLOW-03/D-12/D-13): resolves the branch
 * node's referenced segment definition (by id, evaluated on-the-fly --
 * segments are never materialized), routes to the 'yes' outgoing edge when
 * the contact currently matches the segment, else 'no'. ONLY segment
 * membership is consulted (no inline condition, no email-engagement check --
 * those are v2). Does NOT write to `flow_runs`/`flow_run_steps` itself --
 * mirrors `handlers/send-node.ts`/`handlers/delay-node.ts`'s contract: the
 * caller (`flow-run-advance.worker.ts`) performs that write, in the SAME
 * transaction, using the result this function returns.
 */
export async function handleBranchNode(ctx: BranchNodeCtx): Promise<BranchNodeResult> {
  const { client, workspaceId, contactId, node, definition } = ctx;

  const { rows } = await client.query<{ definition: SegmentDefinition }>(
    `SELECT definition FROM segments WHERE id = $1 AND workspace_id = $2`,
    [node.segmentId, workspaceId]
  );
  const segmentDefinition = rows[0]?.definition;

  // A branch referencing a deleted/missing segment fails closed to "no" --
  // D-24's restrict-delete FK should prevent this, but a missing segment is
  // never silently treated as a match.
  const isInSegment = segmentDefinition
    ? await isContactInSegmentPointCheck(client, workspaceId, segmentDefinition, contactId)
    : false;

  const branch: "yes" | "no" = isInSegment ? "yes" : "no";
  return { branch, nextNodeId: resolveBranchNextNodeId(definition, node.id, branch) };
}
