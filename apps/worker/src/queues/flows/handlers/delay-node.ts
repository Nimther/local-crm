import type { PoolClient } from "pg";
import { computeNextWaitUntil, type FlowDefinition, type FlowDelayNode } from "@mega-crm/flows-core";
import { getWorkspaceSendSettings, resolveTimezone } from "@mega-crm/delivery-core";
import { flowRunAdvanceQueue } from "../flow-queues.js";
import { resolveNextNodeId } from "./send-node.js";

export interface DelayNodeCtx {
  client: PoolClient;
  workspaceId: string;
  flowRunId: string;
  contactId: string;
  node: FlowDelayNode;
  definition: FlowDefinition;
}

export interface DelayNodeResult {
  nextNodeId: string | null;
  nextWakeAt: Date;
}

async function loadContactTimezone(client: PoolClient, workspaceId: string, contactId: string): Promise<string | null> {
  const { rows } = await client.query<{ timezone: string | null }>(
    `SELECT timezone FROM contacts WHERE workspace_id = $1 AND id = $2`,
    [contactId, workspaceId]
  );
  return rows[0]?.timezone ?? null;
}

function computeFixedWake(now: Date, amount: number, unit: "minutes" | "hours" | "days"): Date {
  const msPerUnit = unit === "minutes" ? 60_000 : unit === "hours" ? 3_600_000 : 86_400_000;
  return new Date(now.getTime() + amount * msPerUnit);
}

/**
 * Delay-node handler (FLOW-05): computes a durable `next_wake_at` for both
 * delay kinds -- `fixed` (now + amount*unit, no timezone involved) and
 * `wait_until` (the next local time-of-day/day-of-week match, resolved in
 * the contact's timezone falling back to the workspace default, D-08). No
 * `setTimeout`/in-process timer anywhere -- Postgres's `next_wake_at` column
 * is the durable source of truth; the BullMQ delayed job enqueued here is
 * only the LOW-LATENCY wake path, with `flow-reconciliation.worker.ts`'s
 * 60s scan (06-05) as the durable backstop if it's ever lost.
 *
 * `jobId: flowRunId` -- the SAME deterministic id the reconciliation
 * worker's own nudge uses (`flow-queues.ts`) -- so a burst of redelivered
 * wake attempts for the SAME run can never stack up more than one pending
 * advance job, regardless of which mechanism (this handler or the
 * reconciliation scan) produced it.
 *
 * Does NOT write to `flow_runs`/`flow_run_steps` itself -- mirrors
 * `handlers/send-node.ts`'s `handleSendNode` contract: the caller
 * (`flow-run-advance.worker.ts`) performs that write, in the SAME
 * transaction, using the `nextNodeId`/`nextWakeAt` this function returns.
 */
export async function handleDelayNode(ctx: DelayNodeCtx): Promise<DelayNodeResult> {
  const { client, workspaceId, flowRunId, contactId, node, definition } = ctx;
  const now = new Date();

  let nextWakeAt: Date;
  if (node.delay.kind === "fixed") {
    nextWakeAt = computeFixedWake(now, node.delay.amount, node.delay.unit);
  } else {
    const contactTimezone = await loadContactTimezone(client, workspaceId, contactId);
    const settings = await getWorkspaceSendSettings(client, workspaceId);
    const timezone = resolveTimezone(contactTimezone, settings.defaultTimezone);
    nextWakeAt = computeNextWaitUntil(now, node.delay.timeOfDay, node.delay.dayOfWeek, timezone);
  }

  const nextNodeId = resolveNextNodeId(definition, node.id);

  await flowRunAdvanceQueue.add(
    "advance",
    { workspaceId, flowRunId },
    { jobId: flowRunId, delay: Math.max(0, nextWakeAt.getTime() - Date.now()) }
  );

  return { nextNodeId, nextWakeAt };
}
