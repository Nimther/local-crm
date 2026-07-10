import type { FlowDefinition, FlowEdge } from "./flow-definition-schema.js";

/**
 * D-17: the v1 publish-time hard errors. `messages` deliberately do NOT
 * exist here: these codes are keys/identifiers only, the UI (06-11) maps
 * them to Russian copy. This does NOT do dead-branch/orphan-node linting
 * (that is FLOW-V2-02, out of scope for v1) -- `cycle_detected`/`no_entry`
 * (06-17/CR-01/WR-02) are scoped to nodes reachable from the trigger, same
 * as `branch_missing_exit`, so an unreachable/orphan cycle or dead node
 * still does not block publish.
 */
export type FlowValidationErrorCode =
  | "no_trigger"
  | "empty_send"
  | "branch_missing_exit"
  | "cycle_detected"
  | "no_entry";

export interface FlowValidationError {
  code: FlowValidationErrorCode;
  nodeId?: string;
}

/**
 * A pure, DB-free walk over a parsed FlowDefinition (T-06-02-01): the
 * client canvas calls this for instant feedback, and 06-04's publish route
 * re-runs the SAME function server-side inside the publish transaction --
 * never trusting a client-reported isValid flag (Pitfall 3).
 *
 * Checks, in order:
 * 1. no_trigger -- exactly one trigger node must exist.
 * 2. empty_send -- every send node needs a non-empty templateId AND
 *    (fromSenderId OR fromEmail).
 * 3. branch_missing_exit -- for every branch node reachable from the
 *    trigger, BOTH its "yes" and "no" edges must eventually reach an exit
 *    node along every terminal path.
 *
 * Deliberately does NOT flag orphan/dead nodes or unreachable branches that
 * otherwise satisfy checks 1-3 (D-17, no v2 linting in v1) -- only branch
 * nodes reachable from the trigger are walked for check 3.
 */
export function validateFlowDefinition(def: FlowDefinition): FlowValidationError[] {
  const errors: FlowValidationError[] = [];

  const nodesById = new Map(def.nodes.map((node) => [node.id, node]));
  const edgesBySource = new Map<string, FlowEdge[]>();
  for (const edge of def.edges) {
    const list = edgesBySource.get(edge.source) ?? [];
    list.push(edge);
    edgesBySource.set(edge.source, list);
  }

  const triggerNodes = def.nodes.filter((node) => node.type === "trigger");
  if (triggerNodes.length !== 1) {
    errors.push({ code: "no_trigger" });
  }

  for (const node of def.nodes) {
    if (node.type !== "send") continue;
    const hasTemplate = Boolean(node.templateId && node.templateId.trim().length > 0);
    const hasSender = Boolean(node.fromSenderId || node.fromEmail);
    if (!hasTemplate || !hasSender) {
      errors.push({ code: "empty_send", nodeId: node.id });
    }
  }

  if (triggerNodes.length === 1) {
    const triggerId = triggerNodes[0].id;
    const reachable = collectReachable(triggerId, edgesBySource);

    // no_entry (WR-02): the trigger must lead somewhere -- otherwise an
    // enrolled run would be created with current_node_id = NULL.
    if ((edgesBySource.get(triggerId) ?? []).length === 0) {
      errors.push({ code: "no_entry" });
    }

    // cycle_detected (CR-01): DFS with a recursion-stack from the trigger,
    // scoped to nodes reachable from it (D-17 -- an unreachable/orphan cycle
    // does not block publish).
    const cycleNodeId = findCycleReachableFrom(triggerId, edgesBySource);
    if (cycleNodeId) {
      errors.push({ code: "cycle_detected", nodeId: cycleNodeId });
    }

    for (const node of def.nodes) {
      if (node.type === "branch" && reachable.has(node.id)) {
        if (!pathReachesExit(node.id, nodesById, edgesBySource, new Set())) {
          errors.push({ code: "branch_missing_exit", nodeId: node.id });
        }
      }
    }
  }

  return errors;
}

/**
 * DFS from `startId` over the raw edge graph using a recursion stack (the
 * set of nodes on the CURRENT DFS path, distinct from the global `visited`
 * set). Reaching a node already on the recursion stack means a back-edge --
 * a cycle -- exists reachable from `startId`. Returns the offending node id,
 * or undefined if no cycle is reachable.
 */
function findCycleReachableFrom(startId: string, edgesBySource: Map<string, FlowEdge[]>): string | undefined {
  const visited = new Set<string>();
  const onStack = new Set<string>();

  function dfs(nodeId: string): string | undefined {
    visited.add(nodeId);
    onStack.add(nodeId);

    for (const edge of edgesBySource.get(nodeId) ?? []) {
      if (onStack.has(edge.target)) {
        return edge.target;
      }
      if (!visited.has(edge.target)) {
        const found = dfs(edge.target);
        if (found) return found;
      }
    }

    onStack.delete(nodeId);
    return undefined;
  }

  return dfs(startId);
}

/** BFS over raw edges (regardless of node type) from a starting node id. */
function collectReachable(startId: string, edgesBySource: Map<string, FlowEdge[]>): Set<string> {
  const visited = new Set<string>([startId]);
  const queue = [startId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const edge of edgesBySource.get(current) ?? []) {
      if (!visited.has(edge.target)) {
        visited.add(edge.target);
        queue.push(edge.target);
      }
    }
  }
  return visited;
}

/**
 * Do ALL terminal paths forward from `nodeId` end in an exit node? A branch
 * node requires BOTH its "yes" and "no" edges to be present and to
 * themselves recursively reach exit (D-13). Any other node type follows its
 * (normally single) outgoing edge(s); a dead end that is not itself an exit
 * node fails. `visited` guards against cycles -- a node revisited within the
 * same walk is treated as already-satisfied rather than looping forever.
 */
function pathReachesExit(
  nodeId: string,
  nodesById: Map<string, FlowDefinition["nodes"][number]>,
  edgesBySource: Map<string, FlowEdge[]>,
  visited: Set<string>
): boolean {
  if (visited.has(nodeId)) return true;
  visited.add(nodeId);

  const node = nodesById.get(nodeId);
  if (!node) return true;
  if (node.type === "exit") return true;

  const outgoing = edgesBySource.get(nodeId) ?? [];

  if (node.type === "branch") {
    const yesEdge = outgoing.find((edge) => edge.sourceHandle === "yes");
    const noEdge = outgoing.find((edge) => edge.sourceHandle === "no");
    if (!yesEdge || !noEdge) return false;
    return (
      pathReachesExit(yesEdge.target, nodesById, edgesBySource, visited) &&
      pathReachesExit(noEdge.target, nodesById, edgesBySource, visited)
    );
  }

  if (outgoing.length === 0) return false;
  return outgoing.every((edge) => pathReachesExit(edge.target, nodesById, edgesBySource, visited));
}
