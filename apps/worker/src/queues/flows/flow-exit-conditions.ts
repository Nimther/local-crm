import type { PoolClient } from "pg";
import { compileSegmentDefinition, type SegmentDefinition } from "@mega-crm/segments-core";
import type { FlowExitCondition } from "@mega-crm/shared-schemas";

/**
 * The minimal flow_runs fields evaluateExitConditions needs -- callers pass
 * these straight from the row they already loaded under `FOR UPDATE`
 * (flow-run-advance.worker.ts), never a second read.
 */
export interface ExitConditionFlowRun {
  contactId: string;
  enteredAt: Date;
}

/**
 * D-15's segment-membership half of the union: loads the segment's own
 * `definition` and re-runs the SAME `compileSegmentDefinition` point-check
 * shape `apps/api/src/modules/segments/segment.repository.ts`'s
 * `isContactInSegment` uses -- NOT imported directly, since that repository
 * lives in apps/api and apps/worker has no dependency path to apps/api's
 * source (mirrors the 02-06 `@mega-crm/contacts-core` extraction precedent:
 * shared SQL-generation logic lives in a shared package -- `@mega-crm/
 * segments-core`'s `compileSegmentDefinition` -- and is called from both
 * sides, never reimplemented ad hoc).
 */
async function evaluateSegmentExitCondition(
  client: PoolClient,
  workspaceId: string,
  condition: Extract<FlowExitCondition, { type: "segment" }>,
  contactId: string
): Promise<boolean> {
  const { rows } = await client.query<{ definition: SegmentDefinition }>(
    `SELECT definition FROM segments WHERE id = $1 AND workspace_id = $2`,
    [condition.segmentId, workspaceId]
  );
  const definition = rows[0]?.definition;
  if (!definition) {
    // The referenced segment no longer exists (should be prevented by D-24's
    // restrict-delete, but fails closed here regardless) -- "not in segment"
    // is vacuously true, "in segment" is vacuously false.
    return condition.mode === "not_in";
  }

  const { whereSql, params } = compileSegmentDefinition(definition, workspaceId);
  const pointCheckParams = [...params, contactId];
  const { rows: matchRows } = await client.query(
    `SELECT 1 FROM contacts c WHERE ${whereSql} AND c.id = $${pointCheckParams.length} LIMIT 1`,
    pointCheckParams
  );
  const isInSegment = matchRows.length > 0;
  return condition.mode === "in" ? isInSegment : !isInSegment;
}

/**
 * D-15's event half of the union: "has {eventName} occurred since this run
 * entered?" -- a plain `events.occurred_at > enteredAt` check, scoped to the
 * SAME contact/workspace (events' own RLS + the explicit workspace_id/
 * contact_id predicates below double-enforce tenant isolation, matching
 * every other events query in this codebase).
 */
async function evaluateEventExitCondition(
  client: PoolClient,
  workspaceId: string,
  condition: Extract<FlowExitCondition, { type: "event" }>,
  flowRun: ExitConditionFlowRun
): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM events
     WHERE workspace_id = $1 AND contact_id = $2 AND name = $3 AND occurred_at > $4
     LIMIT 1`,
    [workspaceId, flowRun.contactId, condition.eventName, flowRun.enteredAt]
  );
  return rows.length > 0;
}

/**
 * FLOW-03/D-14/D-15: evaluates a flow's `exit_conditions` array (persisted
 * on the `flows` row, read by the caller from the SAME `FOR UPDATE`-locked
 * join as the run itself) at a step boundary -- returns `true` the moment
 * ANY configured condition is satisfied (first-match short-circuit; the
 * flow-level exit conditions are an OR, not an AND, across all configured
 * entries). Called BEFORE any node-handler dispatch in
 * flow-run-advance.worker.ts so D-14 ("exit before send") holds structurally
 * -- a satisfied exit condition short-circuits the entire step, and no send
 * node handler ever runs in the same call.
 */
export async function evaluateExitConditions(
  client: PoolClient,
  params: { workspaceId: string; flowRun: ExitConditionFlowRun; exitConditions: FlowExitCondition[] }
): Promise<boolean> {
  const { workspaceId, flowRun, exitConditions } = params;

  for (const condition of exitConditions) {
    if (condition.type === "segment") {
      if (await evaluateSegmentExitCondition(client, workspaceId, condition, flowRun.contactId)) {
        return true;
      }
    } else if (condition.type === "event") {
      if (await evaluateEventExitCondition(client, workspaceId, condition, flowRun)) {
        return true;
      }
    }
  }

  return false;
}
