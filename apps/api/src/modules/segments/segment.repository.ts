import type { PoolClient } from "pg";
import { getWorkspaceId, withTenantTransaction } from "../../middleware/tenant-context.js";
import { CONTACT_COLUMNS, type ContactRow } from "@mega-crm/contacts-core";
import { compileSegmentDefinition, type SegmentDefinition } from "@mega-crm/segments-core";

export interface SegmentRow {
  id: string;
  workspaceId: string;
  name: string;
  definition: SegmentDefinition;
  createdByUserId: string;
  memberCount: number | null;
  memberCountAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Column list shared by every read/write of `segments` that needs the full row shape. */
const SEGMENT_COLUMNS = `
  id,
  workspace_id as "workspaceId",
  name,
  definition,
  created_by_user_id as "createdByUserId",
  member_count as "memberCount",
  member_count_at as "memberCountAt",
  created_at as "createdAt",
  updated_at as "updatedAt"
`;

/**
 * D-03/D-14 (Phase 4): "segment is referenced by a campaign/flow, cannot
 * delete" -- `referenced_by_campaign` is thrown by `deleteSegment` below
 * whenever a non-canceled campaign still points at this segment;
 * `referenced_by_flow` remains reserved for Phase 6. Shaped like
 * ContactConflictError.
 */
export class SegmentConflictError extends Error {
  constructor(
    message: string,
    public readonly code: "referenced_by_campaign" | "referenced_by_flow"
  ) {
    super(message);
    this.name = "SegmentConflictError";
  }
}

export interface ListSegmentsQuery {
  page: number;
  pageSize: number;
}

export interface ListSegmentsResult {
  items: SegmentRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface SegmentMembersResult {
  items: ContactRow[];
  total: number;
}

/**
 * SEGM-01/02/03: exact count of contacts matching `def` (Pattern 2 -- one
 * compiled WHERE, three tails). `statementTimeoutMs`, when set, scopes a
 * `SET LOCAL statement_timeout` to this query only (D-08's DoS-bounding
 * escape hatch for the live-preview path -- see segments.routes.ts's
 * preview-count route).
 */
export async function countSegmentMembers(
  def: SegmentDefinition,
  opts?: { statementTimeoutMs?: number }
): Promise<number> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    if (opts?.statementTimeoutMs) {
      await client.query(`SELECT set_config('statement_timeout', $1, true)`, [
        String(opts.statementTimeoutMs),
      ]);
    }
    const { whereSql, params } = compileSegmentDefinition(def, workspaceId);
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*) FROM contacts c WHERE ${whereSql}`,
      params
    );
    return Number(rows[0]?.count ?? 0);
  });
}

/**
 * SEGM-03/D-12: paginated membership list for the segment detail page --
 * same compiled WHERE as countSegmentMembers/isContactInSegment. Stable
 * pagination tie-breaker (created_at DESC, id ASC) per RESEARCH.md Open
 * Question 3.
 */
export async function listSegmentMembers(
  def: SegmentDefinition,
  page: number,
  pageSize: number,
  opts?: { statementTimeoutMs?: number }
): Promise<SegmentMembersResult> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    if (opts?.statementTimeoutMs) {
      await client.query(`SELECT set_config('statement_timeout', $1, true)`, [
        String(opts.statementTimeoutMs),
      ]);
    }
    const { whereSql, params } = compileSegmentDefinition(def, workspaceId);

    const { rows: countRows } = await client.query<{ count: string }>(
      `SELECT count(*) FROM contacts c WHERE ${whereSql}`,
      params
    );

    const listParams = [...params, pageSize, (page - 1) * pageSize];
    const { rows } = await client.query<ContactRow>(
      `SELECT ${CONTACT_COLUMNS} FROM contacts c
       WHERE ${whereSql}
       ORDER BY c.created_at DESC, c.id ASC
       LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams
    );

    return { items: rows, total: Number(countRows[0]?.count ?? 0) };
  });
}

/**
 * SEGM-03/Phase-6: point-check contract flow triggers/exit conditions will
 * consume ("is contact X in segment?") -- same compiled WHERE + one more
 * predicate.
 */
export async function isContactInSegment(def: SegmentDefinition, contactId: string): Promise<boolean> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { whereSql, params } = compileSegmentDefinition(def, workspaceId);
    const pointCheckParams = [...params, contactId];
    const { rows } = await client.query(
      `SELECT 1 FROM contacts c WHERE ${whereSql} AND c.id = $${pointCheckParams.length} LIMIT 1`,
      pointCheckParams
    );
    return rows.length > 0;
  });
}

export interface CreateSegmentInput {
  name: string;
  definition: SegmentDefinition;
  createdByUserId: string;
}

/**
 * D-11: a freshly created segment gets an immediately-computed
 * member_count/member_count_at. `statementTimeoutMs`, when set, scopes a
 * `set_config('statement_timeout', ...)` to this transaction (WR-03/T-03-04:
 * the same evaluation-DoS bound preview-count already had, extended to
 * saves).
 */
export async function createSegment(
  input: CreateSegmentInput,
  opts?: { statementTimeoutMs?: number }
): Promise<SegmentRow> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    if (opts?.statementTimeoutMs) {
      await client.query(`SELECT set_config('statement_timeout', $1, true)`, [
        String(opts.statementTimeoutMs),
      ]);
    }
    const { rows } = await client.query<SegmentRow>(
      `INSERT INTO segments (workspace_id, name, definition, created_by_user_id)
       VALUES ($1, $2, $3, $4)
       RETURNING ${SEGMENT_COLUMNS}`,
      [workspaceId, input.name, input.definition, input.createdByUserId]
    );
    const created = rows[0];

    const { whereSql, params } = compileSegmentDefinition(input.definition, workspaceId);
    const { rows: countRows } = await client.query<{ count: string }>(
      `SELECT count(*) FROM contacts c WHERE ${whereSql}`,
      params
    );
    const memberCount = Number(countRows[0]?.count ?? 0);

    const { rows: updatedRows } = await client.query<SegmentRow>(
      `UPDATE segments SET member_count = $2, member_count_at = now()
       WHERE id = $1
       RETURNING ${SEGMENT_COLUMNS}`,
      [created.id, memberCount]
    );
    return updatedRows[0];
  });
}

/** D-10/D-11: paginated segment list (name, member count, freshness timestamp, created/updated). */
export async function listSegments(query: ListSegmentsQuery): Promise<ListSegmentsResult> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows: countRows } = await client.query<{ count: string }>(
      `SELECT count(*) FROM segments WHERE workspace_id = $1`,
      [workspaceId]
    );
    const { rows } = await client.query<SegmentRow>(
      `SELECT ${SEGMENT_COLUMNS} FROM segments
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

export async function getSegment(id: string): Promise<SegmentRow | null> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows } = await client.query<SegmentRow>(
      `SELECT ${SEGMENT_COLUMNS} FROM segments WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, id]
    );
    return rows[0] ?? null;
  });
}

export interface UpdateSegmentInput {
  name?: string;
  definition?: SegmentDefinition;
}

/**
 * D-13/D-14: rename and/or redefine -- redefining recomputes member_count
 * (D-11) in the same transaction since the membership set changed.
 * `statementTimeoutMs`, when set, scopes a `set_config('statement_timeout', ...)`
 * to this transaction (WR-03/T-03-04).
 */
export async function updateSegment(
  id: string,
  patch: UpdateSegmentInput,
  opts?: { statementTimeoutMs?: number }
): Promise<SegmentRow | null> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    if (opts?.statementTimeoutMs) {
      await client.query(`SELECT set_config('statement_timeout', $1, true)`, [
        String(opts.statementTimeoutMs),
      ]);
    }
    const { rows: existingRows } = await client.query<SegmentRow>(
      `SELECT ${SEGMENT_COLUMNS} FROM segments WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
      [workspaceId, id]
    );
    const existing = existingRows[0];
    if (!existing) return null;

    const nextName = patch.name !== undefined ? patch.name : existing.name;
    const nextDefinition = patch.definition !== undefined ? patch.definition : existing.definition;

    let memberCount = existing.memberCount;
    const recomputeCount = patch.definition !== undefined;
    if (recomputeCount) {
      const { whereSql, params } = compileSegmentDefinition(nextDefinition, workspaceId);
      const { rows: countRows } = await client.query<{ count: string }>(
        `SELECT count(*) FROM contacts c WHERE ${whereSql}`,
        params
      );
      memberCount = Number(countRows[0]?.count ?? 0);
    }

    const { rows } = await client.query<SegmentRow>(
      `UPDATE segments SET
         name = $3,
         definition = $4,
         member_count = $5,
         member_count_at = ${recomputeCount ? "now()" : "member_count_at"},
         updated_at = now()
       WHERE workspace_id = $1 AND id = $2
       RETURNING ${SEGMENT_COLUMNS}`,
      [workspaceId, id, nextName, nextDefinition, memberCount]
    );
    return rows[0];
  });
}

/**
 * D-24 (Phase 6): does any flow reference this segment -- via its
 * dedicated `trigger_segment_id` column, a flow-level exit condition
 * (`flows.exit_conditions` jsonb array, D-15), or a branch/trigger node
 * inside ANY of its `flow_versions` rows (draft or published; a branch
 * condition can reference a segment without that flow ever having been
 * published)? Returns the first referencing flow's name, or `null`. Used
 * both as the app-level pre-check AND to disambiguate a DB-level 23503
 * (only `trigger_segment_id` is a real FK -- exit_conditions/branch
 * references inside jsonb are not DB-enforceable).
 */
async function findReferencingFlowName(
  client: PoolClient,
  workspaceId: string,
  segmentId: string
): Promise<string | null> {
  const { rows: directRows } = await client.query<{ name: string }>(
    `SELECT f.name FROM flows f
     WHERE f.workspace_id = $1
       AND (
         f.trigger_segment_id = $2
         OR EXISTS (
           SELECT 1 FROM jsonb_array_elements(COALESCE(f.exit_conditions, '[]'::jsonb)) AS ec
           WHERE (ec->>'segmentId') = $2::text
         )
       )
     LIMIT 1`,
    [workspaceId, segmentId]
  );
  if (directRows.length > 0) return directRows[0].name;

  const { rows: versionRows } = await client.query<{ name: string }>(
    `SELECT f.name FROM flow_versions fv
     JOIN flows f ON f.id = fv.flow_id
     WHERE fv.workspace_id = $1
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(COALESCE(fv.definition->'nodes', '[]'::jsonb)) AS node
         WHERE (node->>'segmentId') = $2::text
       )
     LIMIT 1`,
    [workspaceId, segmentId]
  );
  return versionRows[0]?.name ?? null;
}

/**
 * D-03/D-14 (Phase 4)/D-24 (Phase 6): blocks deleting a segment still
 * referenced by a non-canceled campaign OR by any flow (trigger, branch, or
 * exit condition) -- pre-checked in the same transaction as the delete so
 * there is no TOCTOU gap between the check and the DELETE. The DB's
 * `campaigns.segment_id`/`flows.trigger_segment_id` FKs are ON DELETE
 * RESTRICT as a backstop (T-04-01-03), but this app-level check produces
 * the actionable `SegmentConflictError` the route needs to return a clear
 * 409, rather than surfacing a raw FK-violation 500.
 */
export async function deleteSegment(id: string): Promise<boolean> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();

    const { rows: referencing } = await client.query<{ name: string }>(
      `SELECT name FROM campaigns WHERE workspace_id = $1 AND segment_id = $2 AND status != 'canceled' LIMIT 1`,
      [workspaceId, id]
    );
    if (referencing.length > 0) {
      throw new SegmentConflictError(
        `Segment is referenced by campaign "${referencing[0].name}"`,
        "referenced_by_campaign"
      );
    }

    const referencingFlowName = await findReferencingFlowName(client, workspaceId, id);
    if (referencingFlowName) {
      throw new SegmentConflictError(
        `Segment is referenced by flow "${referencingFlowName}"`,
        "referenced_by_flow"
      );
    }

    // 06-20/WR-01: a SAVEPOINT wraps the DELETE so that if it trips the DB's
    // FK RESTRICT (23503), the catch below can ROLLBACK TO SAVEPOINT and
    // restore a live transaction before re-querying. Without this, the
    // failed DELETE aborts the whole transaction and any subsequent query
    // (the flow re-check below) fails with a raw postgres 25P02
    // ("current transaction is aborted"), which propagates instead of the
    // intended SegmentConflictError -- surfacing an opaque 500 rather than
    // an actionable 409.
    await client.query("SAVEPOINT seg_delete");
    try {
      const { rows } = await client.query(
        `DELETE FROM segments WHERE workspace_id = $1 AND id = $2 RETURNING id`,
        [workspaceId, id]
      );
      return rows.length > 0;
    } catch (err) {
      // Rule-1 fix: a CANCELED campaign still carries campaigns.segment_id
      // (RESTRICT, not SET NULL -- 04-01's T-04-01-03 backstop preserves a
      // canceled campaign's audience reference for Phase 7 history), so the
      // pre-check above (which only screens non-canceled references) can
      // pass while the DELETE below still trips the DB's unconditional FK
      // constraint. Without this, that case surfaced as a raw 500
      // (postgres 23503) instead of the same actionable conflict error.
      if ((err as { code?: string } | undefined)?.code === "23503") {
        // 06-20/WR-01: restore a live transaction before re-querying -- see
        // the SAVEPOINT comment above.
        await client.query("ROLLBACK TO SAVEPOINT seg_delete");
        // D-24: disambiguate which FK actually fired -- flows.trigger_segment_id
        // is ALSO an unconditional RESTRICT FK (no status-based exemption the
        // way campaigns' canceled state has), so re-check for a flow reference
        // first and default to it when present, matching this function's own
        // pre-check ordering (Rule-3 fix, mirrors the 04-05 campaign backstop).
        const flowName = await findReferencingFlowName(client, workspaceId, id);
        if (flowName) {
          throw new SegmentConflictError(
            `Segment is referenced by flow "${flowName}"`,
            "referenced_by_flow"
          );
        }
        throw new SegmentConflictError(
          "Segment is referenced by a campaign (including canceled campaigns, which retain their audience reference for history)",
          "referenced_by_campaign"
        );
      }
      throw err;
    }
  });
}
