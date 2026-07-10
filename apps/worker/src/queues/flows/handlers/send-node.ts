import type { FlowDefinition, FlowNode } from "@mega-crm/flows-core";
import { emailTriggeredQueue } from "../flow-queues.js";

export interface SendNodeCtx {
  workspaceId: string;
  flowRunId: string;
  contactId: string;
  node: FlowNode;
  definition: FlowDefinition;
}

/**
 * Resolves the single outgoing edge from `nodeId` (send/exit nodes have at
 * most one outgoing edge -- only branch nodes, out of this plan's scope,
 * fan out via `sourceHandle`). Returns `null` if the node is a dead end
 * (no outgoing edge) -- a defensive fallback path-end, not the normal way a
 * run terminates (that's an explicit `exit` node).
 */
export function resolveNextNodeId(definition: FlowDefinition, nodeId: string): string | null {
  const edge = definition.edges.find((candidate) => candidate.source === nodeId);
  return edge?.target ?? null;
}

/**
 * Send-node handler (FLOW-01/FLOW-07): enqueues a `kind: 'flow'` job onto
 * the SAME `EMAIL_TRIGGERED_QUEUE` `email-triggered.worker.ts` already
 * consumes -- no forked send lane, no second rate limiter, no second
 * pre-send gate (all of that lives in `flow-send.ts`/`send-dispatch.ts`,
 * 06-03). `jobId: \`${flowRunId}-${node.id}\`` is deterministic so a
 * redelivered advance for the SAME node can never double-enqueue the send.
 * Does NOT write to `flow_runs`/`flow_run_steps` itself -- the caller
 * (`flow-run-advance.worker.ts`) performs that write, in the SAME
 * transaction, using the `nextNodeId` this function returns.
 */
export async function handleSendNode(ctx: SendNodeCtx): Promise<{ nextNodeId: string | null }> {
  const { workspaceId, flowRunId, contactId, node, definition } = ctx;

  await emailTriggeredQueue.add(
    "send",
    { workspaceId, kind: "flow", flowRunId, nodeId: node.id, contactId },
    { jobId: `${flowRunId}-${node.id}` }
  );

  return { nextNodeId: resolveNextNodeId(definition, node.id) };
}
