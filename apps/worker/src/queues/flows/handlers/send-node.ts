import type { PoolClient } from "pg";
import type { FlowDefinition, FlowSendNode } from "@mega-crm/flows-core";
import {
  getWorkspaceSendSettings,
  isInsideQuietHours,
  nextQuietWindowEnd,
  resolveTimezone,
  type QuietHoursWindow,
} from "@mega-crm/delivery-core";
import { emailTriggeredQueue, enqueueFlowRunAdvance } from "../flow-queues.js";

/** D-08/D-09: a flow's own quiet-hours mode + (when `'override'`) its own window. */
export interface FlowQuietHoursConfig {
  quietHoursMode: "inherit" | "override" | "disabled";
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
}

export interface SendNodeCtx {
  client: PoolClient;
  workspaceId: string;
  flowRunId: string;
  contactId: string;
  node: FlowSendNode;
  definition: FlowDefinition;
  flow: FlowQuietHoursConfig;
}

export type SendNodeResult =
  | { outcome: "enqueued"; nextNodeId: string | null }
  | { outcome: "deferred_quiet_hours"; nextWakeAt: Date };

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

async function loadContactTimezone(client: PoolClient, workspaceId: string, contactId: string): Promise<string | null> {
  const { rows } = await client.query<{ timezone: string | null }>(
    `SELECT timezone FROM contacts WHERE workspace_id = $1 AND id = $2`,
    [contactId, workspaceId]
  );
  return rows[0]?.timezone ?? null;
}

/**
 * Resolves the EFFECTIVE quiet-hours window for this send (D-08/D-09):
 * `'disabled'` -> no gate at all; `'override'` -> the flow's own
 * start/end (defensively no-gate if either is somehow unset); `'inherit'`
 * -> the workspace default window, only when the workspace has
 * `quiet_hours_enabled` AND both bounds are set. Returns `null` when no
 * gate applies.
 */
async function resolveQuietHoursWindow(
  client: PoolClient,
  workspaceId: string,
  contactId: string,
  flow: FlowQuietHoursConfig
): Promise<QuietHoursWindow | null> {
  if (flow.quietHoursMode === "disabled") return null;

  const settings = await getWorkspaceSendSettings(client, workspaceId);

  let startMinutes: number | null;
  let endMinutes: number | null;
  if (flow.quietHoursMode === "override") {
    startMinutes = flow.quietHoursStart;
    endMinutes = flow.quietHoursEnd;
  } else {
    if (!settings.quietHoursEnabled) return null;
    startMinutes = settings.quietHoursStart;
    endMinutes = settings.quietHoursEnd;
  }

  if (startMinutes === null || endMinutes === null) return null; // defensive: no window configured yet

  // T-06-07-01: a corrupted/invalid stored contact timezone must never
  // reach Intl construction unvalidated -- resolveTimezone already
  // validates both inputs, but wrap the whole zone-aware computation
  // defensively anyway so a future Intl edge case can never crash a
  // worker mid-dispatch.
  try {
    const contactTimezone = await loadContactTimezone(client, workspaceId, contactId);
    const timezone = resolveTimezone(contactTimezone, settings.defaultTimezone);
    return { startMinutes, endMinutes, timezone };
  } catch {
    return { startMinutes, endMinutes, timezone: "UTC" };
  }
}

/**
 * Send-node handler (FLOW-01/FLOW-05/FLOW-07). At DISPATCH time (this call
 * -- not when an earlier delay/wait step was scheduled, Pitfall 4/D-14),
 * resolves the effective quiet-hours window and checks it via
 * `isInsideQuietHours`:
 *  - Inside the window: DEFER. No send job is ever enqueued. Returns
 *    `{ outcome: 'deferred_quiet_hours', nextWakeAt }` where `nextWakeAt`
 *    is `nextQuietWindowEnd` -- D-10: this is the ONLY time value used, no
 *    jitter/stagger is added on top (deferred sends smoothed only by the
 *    existing per-tenant token bucket + triggered lane). A BullMQ delayed
 *    advance nudge is enqueued here via `enqueueFlowRunAdvance` (CR-01,
 *    06-12 -- unique-per-wake jobId, not a reused `flowRunId`) so the run
 *    wakes back up right at the window end.
 *  - Outside the window (or no gate applies): enqueues a `kind: 'flow'`
 *    job onto the SAME `EMAIL_TRIGGERED_QUEUE` `email-triggered.worker.ts`
 *    already consumes -- no forked send lane, no second rate limiter, no
 *    second pre-send gate (all of that lives in `flow-send.ts`/
 *    `send-dispatch.ts`, 06-03). `jobId: \`${flowRunId}-${node.id}\`` is
 *    deterministic so a redelivered advance for the SAME node can never
 *    double-enqueue the send.
 *
 * Does NOT write to `flow_runs`/`flow_run_steps` itself in either branch --
 * the caller (`flow-run-advance.worker.ts`) performs that write, in the
 * SAME transaction, using the result this function returns.
 */
export async function handleSendNode(ctx: SendNodeCtx): Promise<SendNodeResult> {
  const { client, workspaceId, flowRunId, contactId, node, definition, flow } = ctx;

  const window = await resolveQuietHoursWindow(client, workspaceId, contactId, flow);
  if (window) {
    const now = new Date();
    if (isInsideQuietHours(now, window)) {
      const nextWakeAt = nextQuietWindowEnd(now, window);
      await enqueueFlowRunAdvance(
        { workspaceId, flowRunId },
        { delay: Math.max(0, nextWakeAt.getTime() - Date.now()) }
      );
      return { outcome: "deferred_quiet_hours", nextWakeAt };
    }
  }

  await emailTriggeredQueue.add(
    "send",
    { workspaceId, kind: "flow", flowRunId, nodeId: node.id, contactId },
    { jobId: `${flowRunId}-${node.id}` }
  );

  return { outcome: "enqueued", nextNodeId: resolveNextNodeId(definition, node.id) };
}
