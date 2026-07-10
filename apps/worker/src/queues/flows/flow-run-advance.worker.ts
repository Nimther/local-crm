import { Worker, type Job, type ConnectionOptions } from "bullmq";
import type { PoolClient } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import type { FlowDefinition } from "@mega-crm/flows-core";
import type { FlowExitCondition } from "@mega-crm/shared-schemas";
import { FLOW_RUN_ADVANCE_QUEUE, flowRunAdvanceJobSchema, type FlowRunAdvanceJob } from "@mega-crm/shared-schemas";
import { evaluateExitConditions } from "./flow-exit-conditions.js";
import { handleSendNode } from "./handlers/send-node.js";
import { handleExitNode } from "./handlers/exit-node.js";
import { handleDelayNode } from "./handlers/delay-node.js";
import { handleBranchNode } from "./handlers/branch-node.js";

interface FlowRunAdvanceRow {
  id: string;
  workspaceId: string;
  flowId: string;
  flowVersionId: string;
  contactId: string;
  status: string;
  currentNodeId: string | null;
  nextWakeAt: Date | null;
  enteredAt: Date;
  flowStatus: string;
  exitConditions: FlowExitCondition[];
  quietHoursMode: "inherit" | "override" | "disabled";
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
}

/**
 * Queue-as-doorbell (T-06-05-01): re-reads the flow_runs row (joined to its
 * parent flow's status/exit_conditions) FOR UPDATE OF fr SKIP LOCKED --
 * `FOR UPDATE OF fr` locks ONLY the flow_runs row, not the joined flows row,
 * since this is the only row a wake nudge ever mutates. A row already
 * locked by a concurrent tick is skipped (returns null), never blocked on.
 */
async function loadDueFlowRun(client: PoolClient, workspaceId: string, flowRunId: string): Promise<FlowRunAdvanceRow | null> {
  const { rows } = await client.query<FlowRunAdvanceRow>(
    `SELECT
       fr.id,
       fr.workspace_id as "workspaceId",
       fr.flow_id as "flowId",
       fr.flow_version_id as "flowVersionId",
       fr.contact_id as "contactId",
       fr.status,
       fr.current_node_id as "currentNodeId",
       fr.next_wake_at as "nextWakeAt",
       fr.entered_at as "enteredAt",
       f.status as "flowStatus",
       f.exit_conditions as "exitConditions",
       f.quiet_hours_mode as "quietHoursMode",
       f.quiet_hours_start as "quietHoursStart",
       f.quiet_hours_end as "quietHoursEnd"
     FROM flow_runs fr
     JOIN flows f ON f.id = fr.flow_id
     WHERE fr.id = $1 AND fr.workspace_id = $2
     FOR UPDATE OF fr SKIP LOCKED`,
    [flowRunId, workspaceId]
  );
  return rows[0] ?? null;
}

/**
 * FLOW-06/FLOW-07: reads the run's PINNED definition -- joined via
 * `flow_version_id`, never `flows.live_version_id` -- inside the SAME
 * transaction as the row lock above, so the definition a node is resolved
 * against can never drift mid-advance even if the flow is re-published
 * concurrently.
 */
async function loadPinnedDefinition(
  client: PoolClient,
  workspaceId: string,
  flowVersionId: string
): Promise<FlowDefinition> {
  const { rows } = await client.query<{ definition: FlowDefinition }>(
    `SELECT definition FROM flow_versions WHERE id = $1 AND workspace_id = $2`,
    [flowVersionId, workspaceId]
  );
  const definition = rows[0]?.definition;
  if (!definition) {
    throw new Error(`flow-run-advance: pinned flow_version ${flowVersionId} not found in workspace ${workspaceId}`);
  }
  return definition;
}

async function appendFlowRunStep(
  client: PoolClient,
  params: { workspaceId: string; flowRunId: string; nodeId: string; nodeType: string; outcome: string }
): Promise<void> {
  const { workspaceId, flowRunId, nodeId, nodeType, outcome } = params;
  await client.query(
    `INSERT INTO flow_run_steps (workspace_id, flow_run_id, node_id, node_type, outcome)
     VALUES ($1, $2, $3, $4, $5)`,
    [workspaceId, flowRunId, nodeId, nodeType, outcome]
  );
}

/**
 * The flow engine's core state-machine step executor (FLOW-01/FLOW-03/
 * FLOW-06/FLOW-07). Exported standalone (not only as a Worker's inline
 * processor) so it can be invoked directly in tests, mirroring
 * `processCampaignKickoffJob`/`processSendJob`'s exported-processor
 * convention. `workspaceId` is always re-derived from `data` (Pattern 2),
 * never ambient state.
 *
 * Every advance re-reads the run's CURRENT database state -- it never trusts
 * the BullMQ payload as the source of truth for what to do (queue-as-
 * doorbell, T-06-05-01): a stale/duplicate wake nudge for a run that has
 * already moved on (or gone terminal) silently no-ops. Three guards, in
 * order, before any node handler ever runs:
 *   1. `status` must still be `waiting`/`advancing` -- a `completed`/
 *      `exited`/`ejected` run's redelivered nudge no-ops.
 *   2. `next_wake_at` must not be in the future -- a nudge that arrives
 *      early (should not happen, but never trusted) no-ops.
 *   3. The PARENT FLOW must not be `paused` (D-18) -- the run is left
 *      exactly as-is (still `waiting`, `next_wake_at` untouched) so the
 *      very next tick after the flow resumes picks it back up with no
 *      separate "on resume" code path (D-19).
 *
 * D-14: exit conditions (`evaluateExitConditions`) are evaluated BEFORE any
 * node-handler dispatch -- a satisfied condition short-circuits the entire
 * step (`status: 'exited'`) and no send node handler ever runs in the same
 * call, structurally guaranteeing "exit before send".
 *
 * Node dispatch + the resulting `current_node_id` advance (or terminal
 * transition) + the `flow_run_steps` append all happen in the ONE
 * transaction this function opens (Pitfall 1 idempotency) -- a crash after
 * COMMIT can only ever redeliver a nudge that the guards above safely no-op.
 *
 * `send`/`exit`/`delay`/`branch` node types are all handled -- any other
 * node type at `current_node_id` throws, surfacing a data-integrity error
 * rather than silently stalling the run.
 */
export async function processFlowRunAdvance(data: FlowRunAdvanceJob): Promise<void> {
  const { workspaceId, flowRunId } = flowRunAdvanceJobSchema.parse(data);

  await withTenant(workspaceId, () =>
    withTenantTransaction(async (client) => {
      const run = await loadDueFlowRun(client, workspaceId, flowRunId);
      if (!run) return; // not found, or a concurrent tick already holds its lock

      if (run.status !== "waiting" && run.status !== "advancing") return; // stale nudge: already terminal
      if (run.nextWakeAt !== null && new Date(run.nextWakeAt).getTime() > Date.now()) return; // not yet due
      if (run.flowStatus === "paused") return; // D-18: freeze in place, resumes on its own next tick (D-19)
      if (!run.currentNodeId) return; // nothing to resolve yet -- out of this plan's scope

      const definition = await loadPinnedDefinition(client, workspaceId, run.flowVersionId);
      const node = definition.nodes.find((candidate) => candidate.id === run.currentNodeId);
      if (!node) {
        throw new Error(
          `flow-run-advance: current_node_id ${run.currentNodeId} not found in pinned definition for flow_run ${flowRunId}`
        );
      }

      // D-14: exit conditions are evaluated BEFORE any node-handler dispatch.
      const exitSatisfied = await evaluateExitConditions(client, {
        workspaceId,
        flowRun: { contactId: run.contactId, enteredAt: run.enteredAt },
        exitConditions: run.exitConditions ?? [],
      });
      if (exitSatisfied) {
        await client.query(
          `UPDATE flow_runs SET status = 'exited', exited_at = now(), exit_reason = 'exit_condition' WHERE id = $1 AND workspace_id = $2`,
          [flowRunId, workspaceId]
        );
        await appendFlowRunStep(client, {
          workspaceId,
          flowRunId,
          nodeId: run.currentNodeId,
          nodeType: node.type,
          outcome: "exit_condition_satisfied",
        });
        return;
      }

      if (node.type === "send") {
        const result = await handleSendNode({
          client,
          workspaceId,
          flowRunId,
          contactId: run.contactId,
          node,
          definition,
          flow: {
            quietHoursMode: run.quietHoursMode,
            quietHoursStart: run.quietHoursStart,
            quietHoursEnd: run.quietHoursEnd,
          },
        });

        if (result.outcome === "deferred_quiet_hours") {
          // D-14/Pitfall 4: checked at DISPATCH time, not schedule time --
          // no send job was enqueued. D-10: `nextWakeAt` is
          // `nextQuietWindowEnd` with NO added jitter/stagger; the deferred
          // burst that releases together at the window end is smoothed
          // only by the existing per-tenant token bucket + triggered lane.
          await client.query(
            `UPDATE flow_runs SET next_wake_at = $2, status = 'waiting' WHERE id = $1 AND workspace_id = $3`,
            [flowRunId, result.nextWakeAt, workspaceId]
          );
          await appendFlowRunStep(client, {
            workspaceId,
            flowRunId,
            nodeId: run.currentNodeId,
            nodeType: "send",
            outcome: "deferred_quiet_hours",
          });
          return;
        }

        if (result.nextNodeId) {
          await client.query(
            `UPDATE flow_runs SET current_node_id = $2, next_wake_at = now(), status = 'waiting' WHERE id = $1 AND workspace_id = $3`,
            [flowRunId, result.nextNodeId, workspaceId]
          );
        } else {
          // Defensive dead-end fallback (no outgoing edge) -- a publish-time
          // validated definition should never reach this, but a run must
          // never be left stalled indefinitely if it does.
          await client.query(
            `UPDATE flow_runs SET status = 'completed', exited_at = now(), exit_reason = 'reached_exit' WHERE id = $1 AND workspace_id = $2`,
            [flowRunId, workspaceId]
          );
        }

        await appendFlowRunStep(client, {
          workspaceId,
          flowRunId,
          nodeId: run.currentNodeId,
          nodeType: "send",
          outcome: "enqueued",
        });
        return;
      }

      if (node.type === "delay") {
        const { nextNodeId, nextWakeAt } = await handleDelayNode({
          client,
          workspaceId,
          flowRunId,
          contactId: run.contactId,
          node,
          definition,
        });

        if (nextNodeId) {
          await client.query(
            `UPDATE flow_runs SET current_node_id = $2, next_wake_at = $3, status = 'waiting' WHERE id = $1 AND workspace_id = $4`,
            [flowRunId, nextNodeId, nextWakeAt, workspaceId]
          );
        } else {
          // Defensive dead-end fallback (no outgoing edge after a delay) --
          // mirrors the send-node dead-end fallback above.
          await client.query(
            `UPDATE flow_runs SET status = 'completed', exited_at = now(), exit_reason = 'reached_exit' WHERE id = $1 AND workspace_id = $2`,
            [flowRunId, workspaceId]
          );
        }

        await appendFlowRunStep(client, {
          workspaceId,
          flowRunId,
          nodeId: run.currentNodeId,
          nodeType: "delay",
          outcome: "waiting",
        });
        return;
      }

      if (node.type === "branch") {
        const { branch, nextNodeId } = await handleBranchNode({
          client,
          workspaceId,
          contactId: run.contactId,
          node,
          definition,
        });

        if (nextNodeId) {
          await client.query(
            `UPDATE flow_runs SET current_node_id = $2, next_wake_at = now(), status = 'waiting' WHERE id = $1 AND workspace_id = $3`,
            [flowRunId, nextNodeId, workspaceId]
          );
        } else {
          // Defensive dead-end fallback (no outgoing edge for this branch) --
          // mirrors the send/delay-node dead-end fallbacks above.
          await client.query(
            `UPDATE flow_runs SET status = 'completed', exited_at = now(), exit_reason = 'reached_exit' WHERE id = $1 AND workspace_id = $2`,
            [flowRunId, workspaceId]
          );
        }

        await appendFlowRunStep(client, {
          workspaceId,
          flowRunId,
          nodeId: run.currentNodeId,
          nodeType: "branch",
          outcome: branch === "yes" ? "branched_yes" : "branched_no",
        });
        return;
      }

      if (node.type === "exit") {
        await handleExitNode({ client, workspaceId, flowRunId });
        await appendFlowRunStep(client, {
          workspaceId,
          flowRunId,
          nodeId: run.currentNodeId,
          nodeType: "exit",
          outcome: "completed",
        });
        return;
      }

      throw new Error(
        `flow-run-advance: unsupported node type "${node.type}" for node ${node.id} (flow_run ${flowRunId})`
      );
    })
  );
}

/** Registered in apps/worker/src/server.ts's buildWorker() (Task 2). */
export function createFlowRunAdvanceWorker(connection: ConnectionOptions): Worker<FlowRunAdvanceJob> {
  return new Worker<FlowRunAdvanceJob>(
    FLOW_RUN_ADVANCE_QUEUE,
    async (job: Job<FlowRunAdvanceJob>) => {
      await processFlowRunAdvance(job.data);
    },
    { connection }
  );
}
