import type { PoolClient } from "pg";
import {
  validateFlowDefinition,
  type FlowDefinition,
  type FlowTriggerNode,
  type FlowValidationError,
} from "@mega-crm/flows-core";
import type { FlowExitCondition, FlowQuietHoursMode, FlowReentryMode } from "@mega-crm/shared-schemas";
import { getWorkspaceId, withTenantTransaction } from "../../middleware/tenant-context.js";
import { snapshotDraftToVersion } from "./flow-version.repository.js";

export type FlowStatus = "draft" | "live" | "paused";

export interface FlowRow {
  id: string;
  workspaceId: string;
  name: string;
  status: FlowStatus;
  triggerType: string | null;
  triggerEventName: string | null;
  triggerSegmentId: string | null;
  draftVersionId: string | null;
  liveVersionId: string | null;
  reentryMode: FlowReentryMode;
  reentryWindowDays: number | null;
  quietHoursMode: FlowQuietHoursMode;
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
  exitConditions: FlowExitCondition[];
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Column list shared by every read/write of `flows` that needs the full row shape. */
const FLOW_COLUMNS = `
  id,
  workspace_id as "workspaceId",
  name,
  status,
  trigger_type as "triggerType",
  trigger_event_name as "triggerEventName",
  trigger_segment_id as "triggerSegmentId",
  draft_version_id as "draftVersionId",
  live_version_id as "liveVersionId",
  reentry_mode as "reentryMode",
  reentry_window_days as "reentryWindowDays",
  quiet_hours_mode as "quietHoursMode",
  quiet_hours_start as "quietHoursStart",
  quiet_hours_end as "quietHoursEnd",
  exit_conditions as "exitConditions",
  created_by_user_id as "createdByUserId",
  created_at as "createdAt",
  updated_at as "updatedAt"
`;

/**
 * D-06/D-18/D-22/D-17: thrown by every state-transition/mutation function
 * below when the requested change is not legal from the flow's current
 * status (`illegal_transition`), the draft definition fails server-side
 * publish validation (`incomplete` -- `details` carries the D-17 hard-error
 * list), or the flow id does not resolve within the caller's workspace
 * (`not_found`). Mirrors campaign.repository.ts's `CampaignStateError` shape.
 */
export class FlowStateError extends Error {
  constructor(
    message: string,
    public readonly code: "illegal_transition" | "incomplete" | "not_found",
    public readonly details?: FlowValidationError[]
  ) {
    super(message);
    this.name = "FlowStateError";
  }
}

const EMPTY_DEFINITION: FlowDefinition = { nodes: [], edges: [] };

/** Next sequential version_number for a flow's flow_versions rows (draft or published). */
async function nextVersionNumber(client: PoolClient, workspaceId: string, flowId: string): Promise<number> {
  const { rows } = await client.query<{ max: string | null }>(
    `SELECT max(version_number) as max FROM flow_versions WHERE workspace_id = $1 AND flow_id = $2`,
    [workspaceId, flowId]
  );
  return Number(rows[0]?.max ?? 0) + 1;
}

/** Extracts the (at most one, by convention) trigger node from a definition, mirroring it onto the flows row's own trigger_* columns for the engine/D-24 restrict-delete check to query without parsing jsonb. */
function extractTriggerColumns(definition: FlowDefinition): {
  triggerType: string | null;
  triggerEventName: string | null;
  triggerSegmentId: string | null;
} {
  const trigger = definition.nodes.find(
    (node): node is FlowTriggerNode => node.type === "trigger"
  );
  if (!trigger) {
    return { triggerType: null, triggerEventName: null, triggerSegmentId: null };
  }
  return {
    triggerType: trigger.triggerType,
    triggerEventName: trigger.eventName ?? null,
    triggerSegmentId: trigger.segmentId ?? null,
  };
}

export interface CreateFlowInput {
  name: string;
  createdByUserId: string;
}

/**
 * FLOW-01/D-20: creates a draft flow with a single, immediately-created
 * working draft flow_versions row (version_number 1, empty nodes/edges,
 * published_at null) -- draft_version_id points at it from the start.
 */
export async function createFlow(input: CreateFlowInput): Promise<FlowRow> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows: flowRows } = await client.query<FlowRow>(
      `INSERT INTO flows (workspace_id, name, created_by_user_id, quiet_hours_mode)
       VALUES ($1, $2, $3, 'workspace_default')
       RETURNING ${FLOW_COLUMNS}`,
      [workspaceId, input.name, input.createdByUserId]
    );
    const flow = flowRows[0];

    const { rows: versionRows } = await client.query<{ id: string }>(
      `INSERT INTO flow_versions (workspace_id, flow_id, version_number, definition, published_at)
       VALUES ($1, $2, 1, $3, NULL)
       RETURNING id`,
      [workspaceId, flow.id, EMPTY_DEFINITION]
    );

    const { rows: updated } = await client.query<FlowRow>(
      `UPDATE flows SET draft_version_id = $2, updated_at = now()
       WHERE workspace_id = $1 AND id = $3
       RETURNING ${FLOW_COLUMNS}`,
      [workspaceId, versionRows[0].id, flow.id]
    );
    return updated[0];
  });
}

export interface ListFlowsQuery {
  page: number;
  pageSize: number;
}

export interface ListFlowsResult {
  items: FlowRow[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listFlows(query: ListFlowsQuery): Promise<ListFlowsResult> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows: countRows } = await client.query<{ count: string }>(
      `SELECT count(*) FROM flows WHERE workspace_id = $1`,
      [workspaceId]
    );
    const { rows } = await client.query<FlowRow>(
      `SELECT ${FLOW_COLUMNS} FROM flows
       WHERE workspace_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [workspaceId, query.pageSize, (query.page - 1) * query.pageSize]
    );
    return {
      items: rows,
      total: Number(countRows[0]?.count ?? 0),
      page: query.page,
      pageSize: query.pageSize,
    };
  });
}

export async function getFlow(id: string): Promise<FlowRow | null> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows } = await client.query<FlowRow>(
      `SELECT ${FLOW_COLUMNS} FROM flows WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, id]
    );
    return rows[0] ?? null;
  });
}

export interface UpdateFlowDraftInput {
  name?: string;
  definition?: FlowDefinition;
  reentryMode?: FlowReentryMode;
  reentryWindowDays?: number;
  quietHoursMode?: FlowQuietHoursMode;
  quietHoursStart?: number;
  quietHoursEnd?: number;
  exitConditions?: FlowExitCondition[];
}

/**
 * D-20: a flow always has AT MOST one working (unpublished) draft at a time.
 * A brand-new flow already has one (createFlow). A live/paused flow whose
 * prior draft was just published has `draft_version_id = NULL` (publishFlow
 * clears it, see below) -- the FIRST edit after publish lazily creates a
 * fresh flow_versions row copied from the live definition, then applies the
 * patch on top of it. `definition` changes also re-sync the flows row's own
 * trigger_* columns (extractTriggerColumns) so D-24's restrict-delete check
 * can query them directly without parsing jsonb.
 */
export async function updateFlowDraft(id: string, patch: UpdateFlowDraftInput): Promise<FlowRow> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows } = await client.query<FlowRow>(
      `SELECT ${FLOW_COLUMNS} FROM flows WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
      [workspaceId, id]
    );
    const existing = rows[0];
    if (!existing) {
      throw new FlowStateError("Flow not found", "not_found");
    }

    let draftVersionId = existing.draftVersionId;
    if (!draftVersionId) {
      // D-20: no working draft yet (live/paused flow, never edited since
      // publish) -- auto-create one from the live version's definition.
      const { rows: liveRows } = await client.query<{ definition: FlowDefinition }>(
        `SELECT definition FROM flow_versions WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, existing.liveVersionId]
      );
      const liveDefinition = liveRows[0]?.definition ?? EMPTY_DEFINITION;
      const versionNumber = await nextVersionNumber(client, workspaceId, id);
      const { rows: created } = await client.query<{ id: string }>(
        `INSERT INTO flow_versions (workspace_id, flow_id, version_number, definition, published_at)
         VALUES ($1, $2, $3, $4, NULL)
         RETURNING id`,
        [workspaceId, id, versionNumber, liveDefinition]
      );
      draftVersionId = created[0].id;
    }

    if (patch.definition !== undefined) {
      await client.query(
        `UPDATE flow_versions SET definition = $3 WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, draftVersionId, patch.definition]
      );
    }

    const triggerColumns =
      patch.definition !== undefined ? extractTriggerColumns(patch.definition) : null;

    const nextName = patch.name !== undefined ? patch.name : existing.name;
    const nextReentryMode = patch.reentryMode !== undefined ? patch.reentryMode : existing.reentryMode;
    const nextReentryWindowDays =
      patch.reentryWindowDays !== undefined ? patch.reentryWindowDays : existing.reentryWindowDays;
    const nextQuietHoursMode = patch.quietHoursMode !== undefined ? patch.quietHoursMode : existing.quietHoursMode;
    const nextQuietHoursStart =
      patch.quietHoursStart !== undefined ? patch.quietHoursStart : existing.quietHoursStart;
    const nextQuietHoursEnd = patch.quietHoursEnd !== undefined ? patch.quietHoursEnd : existing.quietHoursEnd;
    const nextExitConditions = patch.exitConditions !== undefined ? patch.exitConditions : existing.exitConditions;
    const nextTriggerType = triggerColumns ? triggerColumns.triggerType : existing.triggerType;
    const nextTriggerEventName = triggerColumns ? triggerColumns.triggerEventName : existing.triggerEventName;
    const nextTriggerSegmentId = triggerColumns ? triggerColumns.triggerSegmentId : existing.triggerSegmentId;

    const { rows: updated } = await client.query<FlowRow>(
      `UPDATE flows SET
         name = $3,
         draft_version_id = $4,
         reentry_mode = $5,
         reentry_window_days = $6,
         quiet_hours_mode = $7,
         quiet_hours_start = $8,
         quiet_hours_end = $9,
         exit_conditions = $10,
         trigger_type = $11,
         trigger_event_name = $12,
         trigger_segment_id = $13,
         updated_at = now()
       WHERE workspace_id = $1 AND id = $2
       RETURNING ${FLOW_COLUMNS}`,
      [
        workspaceId,
        id,
        nextName,
        draftVersionId,
        nextReentryMode,
        nextReentryWindowDays,
        nextQuietHoursMode,
        nextQuietHoursStart,
        nextQuietHoursEnd,
        nextExitConditions,
        nextTriggerType,
        nextTriggerEventName,
        nextTriggerSegmentId,
      ]
    );
    return updated[0];
  });
}

/**
 * FLOW-06/FLOW-07/D-17/Pitfall-3: re-runs validateFlowDefinition server-side
 * inside this transaction (NEVER trusts a client isValid flag) -- any D-17
 * hard error throws `incomplete` with the error list attached, and nothing
 * is written. On success: the current draft flow_versions row is stamped
 * `published_at = now()` (making it immutable from this point on -- FLOW-07),
 * flows.live_version_id is repointed at it, status becomes 'live', and
 * draft_version_id is cleared to NULL (D-20: the next edit lazily creates a
 * fresh working draft via updateFlowDraft, rather than eagerly allocating an
 * unused draft row here).
 */
export async function publishFlow(id: string): Promise<FlowRow> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows } = await client.query<FlowRow>(
      `SELECT ${FLOW_COLUMNS} FROM flows WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
      [workspaceId, id]
    );
    const existing = rows[0];
    if (!existing) {
      throw new FlowStateError("Flow not found", "not_found");
    }
    if (!existing.draftVersionId) {
      throw new FlowStateError("No draft changes to publish", "illegal_transition");
    }

    const { rows: draftRows } = await client.query<{ definition: FlowDefinition }>(
      `SELECT definition FROM flow_versions WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, existing.draftVersionId]
    );
    const definition = draftRows[0]?.definition ?? EMPTY_DEFINITION;

    const errors = validateFlowDefinition(definition);
    if (errors.length > 0) {
      throw new FlowStateError("Flow definition is incomplete", "incomplete", errors);
    }

    await snapshotDraftToVersion(client, existing.draftVersionId);

    const { rows: updated } = await client.query<FlowRow>(
      `UPDATE flows SET
         live_version_id = $3,
         draft_version_id = NULL,
         status = 'live',
         updated_at = now()
       WHERE workspace_id = $1 AND id = $2
       RETURNING ${FLOW_COLUMNS}`,
      [workspaceId, id, existing.draftVersionId]
    );
    return updated[0];
  });
}

/** D-18/D-22: live -> paused (stops new enrollments; in-flight runs continue). */
export async function pauseFlow(id: string): Promise<FlowRow> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows } = await client.query<FlowRow>(
      `SELECT ${FLOW_COLUMNS} FROM flows WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
      [workspaceId, id]
    );
    const existing = rows[0];
    if (!existing) {
      throw new FlowStateError("Flow not found", "not_found");
    }
    if (existing.status !== "live") {
      throw new FlowStateError("Only a live flow can be paused", "illegal_transition");
    }

    const { rows: updated } = await client.query<FlowRow>(
      `UPDATE flows SET status = 'paused', updated_at = now()
       WHERE workspace_id = $1 AND id = $2
       RETURNING ${FLOW_COLUMNS}`,
      [workspaceId, id]
    );
    return updated[0];
  });
}

/** D-18/D-22: paused -> live (resumes new enrollments). */
export async function resumeFlow(id: string): Promise<FlowRow> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows } = await client.query<FlowRow>(
      `SELECT ${FLOW_COLUMNS} FROM flows WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
      [workspaceId, id]
    );
    const existing = rows[0];
    if (!existing) {
      throw new FlowStateError("Flow not found", "not_found");
    }
    if (existing.status !== "paused") {
      throw new FlowStateError("Only a paused flow can be resumed", "illegal_transition");
    }

    const { rows: updated } = await client.query<FlowRow>(
      `UPDATE flows SET status = 'live', updated_at = now()
       WHERE workspace_id = $1 AND id = $2
       RETURNING ${FLOW_COLUMNS}`,
      [workspaceId, id]
    );
    return updated[0];
  });
}

/**
 * D-11-style duplicate: copies name/config/trigger fields AND the source's
 * current editable definition (its own draft if it has one, else its live
 * definition) into a brand-new 'draft' flow with a fresh version-1 row.
 * Does not affect the source flow's state.
 */
export async function duplicateFlow(id: string, createdByUserId: string): Promise<FlowRow> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows } = await client.query<FlowRow>(
      `SELECT ${FLOW_COLUMNS} FROM flows WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, id]
    );
    const existing = rows[0];
    if (!existing) {
      throw new FlowStateError("Flow not found", "not_found");
    }

    const sourceVersionId = existing.draftVersionId ?? existing.liveVersionId;
    let definition: FlowDefinition = EMPTY_DEFINITION;
    if (sourceVersionId) {
      const { rows: versionRows } = await client.query<{ definition: FlowDefinition }>(
        `SELECT definition FROM flow_versions WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, sourceVersionId]
      );
      definition = versionRows[0]?.definition ?? EMPTY_DEFINITION;
    }

    const { rows: created } = await client.query<FlowRow>(
      `INSERT INTO flows (
         workspace_id, name, created_by_user_id,
         trigger_type, trigger_event_name, trigger_segment_id,
         reentry_mode, reentry_window_days,
         quiet_hours_mode, quiet_hours_start, quiet_hours_end,
         exit_conditions
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING ${FLOW_COLUMNS}`,
      [
        workspaceId,
        existing.name,
        createdByUserId,
        existing.triggerType,
        existing.triggerEventName,
        existing.triggerSegmentId,
        existing.reentryMode,
        existing.reentryWindowDays,
        existing.quietHoursMode,
        existing.quietHoursStart,
        existing.quietHoursEnd,
        existing.exitConditions,
      ]
    );
    const flow = created[0];

    const { rows: versionRows } = await client.query<{ id: string }>(
      `INSERT INTO flow_versions (workspace_id, flow_id, version_number, definition, published_at)
       VALUES ($1, $2, 1, $3, NULL)
       RETURNING id`,
      [workspaceId, flow.id, definition]
    );

    const { rows: updated } = await client.query<FlowRow>(
      `UPDATE flows SET draft_version_id = $2, updated_at = now()
       WHERE workspace_id = $1 AND id = $3
       RETURNING ${FLOW_COLUMNS}`,
      [workspaceId, versionRows[0].id, flow.id]
    );
    return updated[0];
  });
}
