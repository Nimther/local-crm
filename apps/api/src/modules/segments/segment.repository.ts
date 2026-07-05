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
 * D-14/Phase-4/6 readiness: reserved for "segment is referenced by a
 * campaign/flow, cannot delete" once those consumers exist -- unused this
 * phase (deleteSegment is a free delete, D-14), shaped like ContactConflictError.
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
      await client.query(`SET LOCAL statement_timeout = ${Number(opts.statementTimeoutMs)}`);
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
  pageSize: number
): Promise<SegmentMembersResult> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
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

/** D-11: a freshly created segment gets an immediately-computed member_count/member_count_at. */
export async function createSegment(input: CreateSegmentInput): Promise<SegmentRow> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
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
 */
export async function updateSegment(id: string, patch: UpdateSegmentInput): Promise<SegmentRow | null> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
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

/** D-14: free delete this phase -- nothing references segments.id yet. */
export async function deleteSegment(id: string): Promise<boolean> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows } = await client.query(
      `DELETE FROM segments WHERE workspace_id = $1 AND id = $2 RETURNING id`,
      [workspaceId, id]
    );
    return rows.length > 0;
  });
}
