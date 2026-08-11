import { Worker, type Job, type ConnectionOptions } from "bullmq";
import type { PoolClient } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import type { FlowDefinition } from "@mega-crm/flows-core";
import { compileSegmentDefinition, type SegmentDefinition } from "@mega-crm/segments-core";
import {
  FLOW_TRIGGER_EVALUATOR_QUEUE,
  flowTriggerCheckJobSchema,
  type FlowTriggerCheckJob,
} from "@mega-crm/shared-schemas";
import { canEnterFlow } from "./flow-reentry.js";
import { enqueueFlowRunAdvance } from "./flow-queues.js";
import { resolveNextNodeId } from "./handlers/send-node.js";

interface LiveEventFlowRow {
  id: string;
  liveVersionId: string;
  reentryMode: string;
  reentryWindowDays: number | null;
}

/**
 * The shape both the event-driven segment re-check (this file) and the
 * periodic bulk sweep (`flow-segment-sweep.worker.ts`) need to route a
 * newly-matching contact through `enterSegmentTriggeredFlow` below --
 * exported so the sweep worker (which discovers flows via a cross-tenant
 * admin scan, a structurally different query) can build the same shape from
 * its own row and reuse this ONE entry primitive rather than duplicating it
 * (key_link: "same entry path as event triggers").
 */
export interface LiveSegmentFlowRow {
  id: string;
  liveVersionId: string;
  triggerSegmentId: string;
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
 * the same edge lookup. Exported so `flow-enroll-existing.worker.ts` (Task 3)
 * reuses the SAME entry-node resolution rather than duplicating it.
 */
export async function loadEntryNodeId(
  client: PoolClient,
  workspaceId: string,
  flowVersionId: string
): Promise<string | null> {
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
 * Live, segment-triggered flows (D-02) in this workspace -- the counterpart
 * to `loadLiveEventTriggeredFlows` for the event-trigger half above.
 */
async function loadLiveSegmentTriggeredFlows(client: PoolClient, workspaceId: string): Promise<LiveSegmentFlowRow[]> {
  const { rows } = await client.query<LiveSegmentFlowRow>(
    `SELECT id, live_version_id as "liveVersionId", trigger_segment_id as "triggerSegmentId",
            reentry_mode as "reentryMode", reentry_window_days as "reentryWindowDays"
     FROM flows
     WHERE workspace_id = $1
       AND status = 'live'
       AND trigger_type = 'segment'
       AND trigger_segment_id IS NOT NULL
       AND live_version_id IS NOT NULL`,
    [workspaceId]
  );
  return rows;
}

async function isContactInSegmentDef(
  client: PoolClient,
  workspaceId: string,
  segmentId: string,
  contactId: string
): Promise<boolean> {
  const { rows } = await client.query<{ definition: SegmentDefinition }>(
    `SELECT definition FROM segments WHERE id = $1 AND workspace_id = $2`,
    [segmentId, workspaceId]
  );
  const definition = rows[0]?.definition;
  if (!definition) return false; // D-24 restrict-delete should prevent this; defensive no-op

  const { whereSql, params } = compileSegmentDefinition(definition, workspaceId);
  const pointCheckParams = [...params, contactId];
  const { rows: matchRows } = await client.query(
    `SELECT 1 FROM contacts c WHERE ${whereSql} AND c.id = $${pointCheckParams.length} LIMIT 1`,
    pointCheckParams
  );
  return matchRows.length > 0;
}

async function hasSeenSnapshot(
  client: PoolClient,
  workspaceId: string,
  flowId: string,
  contactId: string
): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM flow_segment_membership_snapshot WHERE workspace_id = $1 AND flow_id = $2 AND contact_id = $3 LIMIT 1`,
    [workspaceId, flowId, contactId]
  );
  return rows.length > 0;
}

async function markSeen(client: PoolClient, workspaceId: string, flowId: string, contactId: string): Promise<void> {
  await client.query(
    `INSERT INTO flow_segment_membership_snapshot (workspace_id, flow_id, contact_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, flow_id, contact_id) DO NOTHING`,
    [workspaceId, flowId, contactId]
  );
}

/**
 * D-02/D-04: the ONE entry primitive both the event-driven segment re-check
 * (below) and the periodic bulk sweep (`flow-segment-sweep.worker.ts`) route
 * a newly-matching contact through -- the SAME `canEnterFlow` + version-
 * pinned `flow_runs` INSERT + advance-enqueue path the event trigger uses
 * (key_link: "same entry path as event triggers"). Always marks the
 * membership snapshot "seen" afterward, regardless of `canEnterFlow`'s
 * decision (an active-run/reentry-window denial still means this contact's
 * CURRENT segment-entry has been considered -- it must not be re-attempted
 * on every subsequent event/sweep tick).
 */
export async function enterSegmentTriggeredFlow(
  client: PoolClient,
  workspaceId: string,
  flow: LiveSegmentFlowRow,
  contactId: string
): Promise<void> {
  const decision = await canEnterFlow(client, {
    workspaceId,
    flowId: flow.id,
    contactId,
    reentryMode: flow.reentryMode,
    reentryWindowDays: flow.reentryWindowDays,
  });

  if (decision.allowed) {
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
    if (flowRunId) {
      await enqueueFlowRunAdvance({ workspaceId, flowRunId });
    }
  }

  await markSeen(client, workspaceId, flow.id, contactId);
}

/**
 * D-02a: the event-driven half of the segment-entry hybrid -- every event
 * ingestion upserts the contact (properties, potentially subscription
 * status), so the SAME flow-trigger-check job that already runs the
 * event-match branch above ALSO doubles as the "contact changed" signal for
 * segment-triggered flows. v1 path: no separate hook exists yet on contact
 * PATCH/CSV import (documented discretion item, RESEARCH.md) -- event-
 * ingestion coverage plus the periodic bulk sweep (`flow-segment-sweep.worker.ts`,
 * the D-02b time-based safety net) together close the gap for contact
 * changes with no accompanying event.
 */
async function checkSegmentEntryForContact(client: PoolClient, workspaceId: string, contactId: string): Promise<void> {
  const segmentFlows = await loadLiveSegmentTriggeredFlows(client, workspaceId);
  for (const flow of segmentFlows) {
    const alreadySeen = await hasSeenSnapshot(client, workspaceId, flow.id, contactId);
    if (alreadySeen) continue; // already considered for this flow -- entry is one-shot per D-02's snapshot semantics

    const isMember = await isContactInSegmentDef(client, workspaceId, flow.triggerSegmentId, contactId);
    if (!isMember) continue; // not (yet) in-segment -- nothing to do on this check

    await enterSegmentTriggeredFlow(client, workspaceId, flow, contactId);
  }
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
 *
 * D-02: ALWAYS also runs the segment-entry event-driven re-check
 * (`checkSegmentEntryForContact`) regardless of whether `eventName` is
 * present -- every flow-trigger-check job represents a contact that just
 * changed (an ingested event upserts the contact), so the same job doubles
 * as D-02a's "contact changed" signal for segment-triggered flows.
 */
export async function processFlowTriggerCheck(data: FlowTriggerCheckJob): Promise<void> {
  const { workspaceId, contactId, eventName } = flowTriggerCheckJobSchema.parse(data);

  await withTenant(workspaceId, () =>
    withTenantTransaction(async (client) => {
      // Phase 10 (SEC-16, T-10-14-03): re-verify the contact belongs to
      // THIS workspace before any flow entry -- job.data's `contactId` is
      // never trusted as already scoped to `workspaceId` (Pattern 2, same
      // discipline as every other job handler in this codebase). Without
      // this, a misrouted/hostile job payload naming a contact id from a
      // DIFFERENT workspace could still create a `flow_runs` row here:
      // `flow_runs.contact_id`'s FK targets `contacts(id)` alone (not a
      // composite `(workspace_id, id)` key), so the foreign key alone does
      // not reject a cross-workspace reference, and neither `canEnterFlow`
      // nor the INSERT below ever re-reads the contact's own row to compare
      // workspace ids. Discovered by negative-cross-tenant-jobs.test.ts
      // (plan 10-14).
      const { rows: contactRows } = await client.query<{ id: string }>(
        `SELECT id FROM contacts WHERE id = $1 AND workspace_id = $2`,
        [contactId, workspaceId]
      );
      if (contactRows.length === 0) return;

      if (eventName) {
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

          await enqueueFlowRunAdvance({ workspaceId, flowRunId });
        }
      }

      await checkSegmentEntryForContact(client, workspaceId, contactId);
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
