import { Worker, type Job, type ConnectionOptions } from "bullmq";
import type { PoolClient } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import type { FlowDefinition } from "@mega-crm/flows-core";
import {
  FLOW_TRIGGER_EVALUATOR_QUEUE,
  flowTriggerCheckJobSchema,
  type FlowTriggerCheckJob,
} from "@mega-crm/shared-schemas";
import { canEnterFlow } from "./flow-reentry.js";
import { flowRunAdvanceQueue } from "./flow-queues.js";
import { resolveNextNodeId } from "./handlers/send-node.js";

interface LiveEventFlowRow {
  id: string;
  liveVersionId: string;
  reentryMode: string;
  reentryWindowDays: number | null;
}

/**
 * Live, event-triggered flows whose `trigger_event_name` matches this job's
 * `eventName` (D-01: name-only matching, no property predicate). Only flows
 * with a `live_version_id` set can actually be entered.
 */
async function loadLiveEventTriggeredFlows(
  client: PoolClient,
  workspaceId: string,
  eventName: string
): Promise<LiveEventFlowRow[]> {
  const { rows } = await client.query<LiveEventFlowRow>(
    `SELECT id, live_version_id as "liveVersionId", reentry_mode as "reentryMode", reentry_window_days as "reentryWindowDays"
     FROM flows
     WHERE workspace_id = $1
       AND status = 'live'
       AND trigger_type = 'event'
       AND trigger_event_name = $2
       AND live_version_id IS NOT NULL`,
    [workspaceId, eventName]
  );
  return rows;
}

/**
 * Resolves the node a brand-new run should start at: the single node
 * downstream of the flow's `trigger` node in its PINNED (live) definition.
 * Reuses `handlers/send-node.ts`'s `resolveNextNodeId` (trigger nodes, like
 * send nodes, have at most one outgoing edge) rather than re-implementing
 * the same edge lookup.
 */
async function loadEntryNodeId(client: PoolClient, workspaceId: string, flowVersionId: string): Promise<string | null> {
  const { rows } = await client.query<{ definition: FlowDefinition }>(
    `SELECT definition FROM flow_versions WHERE id = $1 AND workspace_id = $2`,
    [flowVersionId, workspaceId]
  );
  const definition = rows[0]?.definition;
  if (!definition) return null;
  const triggerNode = definition.nodes.find((node) => node.type === "trigger");
  if (!triggerNode) return null;
  return resolveNextNodeId(definition, triggerNode.id);
}

/**
 * The flow-trigger-evaluator job handler (FLOW-02/FLOW-04, D-01/D-05/D-06/
 * D-07): re-derives `workspaceId` from `data` (Pattern 2, never ambient).
 * For an event-driven check (`eventName` present -- the segment-trigger half
 * of D-02's hybrid is out of this plan's scope, 06-08), matches the event
 * name against every live event-triggered flow in the workspace, applies
 * `canEnterFlow`'s re-entry decision (FLOW-04/D-06/D-07) per matching flow,
 * and for each allowed entry INSERTs a `flow_runs` row PINNED to
 * `flows.live_version_id` (FLOW-06/FLOW-07 -- never re-pointed later) with
 * `current_node_id` set to the node just past the trigger, then enqueues an
 * advance job so `flow-run-advance.worker.ts` (06-05) picks it up
 * immediately (no need to wait for the 60s reconciliation backstop).
 *
 * The INSERT's `ON CONFLICT (workspace_id, flow_id, contact_id) WHERE status
 * IN ('waiting','advancing') DO NOTHING` targets the EXACT SAME partial
 * unique index (`flow_runs_one_active_per_contact`, migration 0026)
 * `canEnterFlow`'s active-run pre-check already consulted -- this is the
 * DB-level concurrency backstop (T-06-06-01/D-07): two concurrent triggers
 * for the same contact x flow can each pass the pre-check's SELECT, but only
 * one INSERT can ever actually land; the loser's `RETURNING id` returns no
 * row and this handler simply skips enqueuing an advance for it.
 *
 * Exported standalone (not only as a Worker's inline processor), mirroring
 * every other worker's exported-processor convention in this codebase, so
 * `flow-trigger-evaluator.test.ts` (Task 3) can invoke it directly.
 */
export async function processFlowTriggerCheck(data: FlowTriggerCheckJob): Promise<void> {
  const { workspaceId, contactId, eventName } = flowTriggerCheckJobSchema.parse(data);
  if (!eventName) return; // segment-trigger/contact-change re-check is out of this plan's scope (06-08)

  await withTenant(workspaceId, () =>
    withTenantTransaction(async (client) => {
      const matchingFlows = await loadLiveEventTriggeredFlows(client, workspaceId, eventName);

      for (const flow of matchingFlows) {
        const decision = await canEnterFlow(client, {
          workspaceId,
          flowId: flow.id,
          contactId,
          reentryMode: flow.reentryMode,
          reentryWindowDays: flow.reentryWindowDays,
        });
        if (!decision.allowed) continue;

        const entryNodeId = await loadEntryNodeId(client, workspaceId, flow.liveVersionId);

        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO flow_runs
             (workspace_id, flow_id, flow_version_id, contact_id, status, current_node_id, next_wake_at, entered_at, last_entry_at)
           VALUES ($1, $2, $3, $4, 'waiting', $5, now(), now(), now())
           ON CONFLICT (workspace_id, flow_id, contact_id) WHERE status IN ('waiting', 'advancing') DO NOTHING
           RETURNING id`,
          [workspaceId, flow.id, flow.liveVersionId, contactId, entryNodeId]
        );

        const flowRunId = rows[0]?.id;
        if (!flowRunId) continue; // the one-active-run index caught a concurrent duplicate trigger

        await flowRunAdvanceQueue.add("advance", { workspaceId, flowRunId }, { jobId: flowRunId });
      }
    })
  );
}

/** Registered in apps/worker/src/server.ts's buildWorker() (Task 2). */
export function createFlowTriggerEvaluatorWorker(connection: ConnectionOptions): Worker<FlowTriggerCheckJob> {
  return new Worker<FlowTriggerCheckJob>(
    FLOW_TRIGGER_EVALUATOR_QUEUE,
    async (job: Job<FlowTriggerCheckJob>) => {
      await processFlowTriggerCheck(job.data);
    },
    { connection }
  );
}
