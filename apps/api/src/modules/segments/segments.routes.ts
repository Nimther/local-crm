import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createSegmentSchema,
  updateSegmentSchema,
  segmentListQuerySchema,
  segmentMembersQuerySchema,
  previewCountSchema,
} from "@mega-crm/shared-schemas";
import type { ContactRow } from "@mega-crm/contacts-core";
import { auth } from "../auth/auth.js";
import { toFetchHeaders } from "../../middleware/role-guard.js";
import { withTenant } from "../../middleware/tenant-context.js";
import { findActiveWorkspaceBySlug, type ActiveWorkspace } from "../tenancy/workspace-lookup.js";
import { getCallerRoles } from "../tenancy/member-roles.js";
import {
  countSegmentMembers,
  createSegment,
  deleteSegment,
  getSegment,
  listSegmentMembers,
  listSegments,
  updateSegment,
  type SegmentRow,
} from "./segment.repository.js";
import { listObservedEventNames } from "./event-names.repository.js";

/**
 * SEGM-04's DoS-bounding statement_timeout (D-08's "timeout -> hint to
 * narrow conditions" escape hatch, T-03-04). Scoped to preview-count only --
 * this is the one call mode where a client can submit an arbitrary
 * (unsaved) definition and force a re-evaluation on every keystroke.
 */
const PREVIEW_COUNT_STATEMENT_TIMEOUT_MS = 2000;

/** Postgres error code for a statement canceled due to statement_timeout. */
const QUERY_CANCELED_ERROR_CODE = "57014";

function toContactResponse(row: ContactRow) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    externalId: row.externalId,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    phone: row.phone,
    city: row.city,
    country: row.country,
    tags: row.tags,
    properties: row.properties,
    subscriptionStatus: row.subscriptionStatus,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toSegmentResponse(row: SegmentRow) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    definition: row.definition,
    createdByUserId: row.createdByUserId,
    memberCount: row.memberCount,
    memberCountAt: row.memberCountAt ? row.memberCountAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Resolves `:slug` to a workspace AND confirms the caller is a member --
 * ANY throw from getCallerRoles (unauthenticated, unknown slug, non-member)
 * maps to the SAME 404 a nonexistent workspace returns, so segment routes
 * cannot be used as a workspace-enumeration oracle (V4, matching
 * contacts.routes.ts's precedent -- segment management is ordinary-member
 * level, not an elevated-role action).
 */
async function resolveWorkspaceMember(
  request: FastifyRequest,
  reply: FastifyReply,
  slug: string
): Promise<ActiveWorkspace | null> {
  const workspace = await findActiveWorkspaceBySlug(slug);
  if (!workspace) {
    await reply.code(404).send({ error: "Workspace not found" });
    return null;
  }

  try {
    await getCallerRoles(toFetchHeaders(request), slug);
  } catch {
    await reply.code(404).send({ error: "Workspace not found" });
    return null;
  }

  return workspace;
}

/**
 * Session-authed segment CRUD + evaluation (SEGM-01..04). Ordinary
 * workspace membership is sufficient -- segment management is not an
 * elevated-role action, matching contacts.
 */
export async function registerSegmentsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/workspaces/:slug/segments", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const parsed = segmentListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const workspace = await resolveWorkspaceMember(request, reply, slug);
    if (!workspace) return;

    const result = await withTenant(workspace.id, () => listSegments(parsed.data));
    return reply.send({
      items: result.items.map(toSegmentResponse),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    });
  });

  fastify.post("/api/workspaces/:slug/segments", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const parsed = createSegmentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const workspace = await resolveWorkspaceMember(request, reply, slug);
    if (!workspace) return;

    const session = await auth.api.getSession({ headers: toFetchHeaders(request) });
    if (!session) {
      return reply.code(401).send({ error: "Not authenticated" });
    }

    const created = await withTenant(workspace.id, () =>
      createSegment({ name: parsed.data.name, definition: parsed.data.definition, createdByUserId: session.user.id })
    );
    return reply.code(201).send(toSegmentResponse(created));
  });

  fastify.get("/api/workspaces/:slug/segments/event-names", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const workspace = await resolveWorkspaceMember(request, reply, slug);
    if (!workspace) return;

    const names = await withTenant(workspace.id, () => listObservedEventNames());
    return reply.send({ names });
  });

  // SEGM-04: live-preview count for an UNSAVED definition -- not a persisted
  // resource. Statement-timeout-guarded (D-08/T-03-04): a pathological
  // definition degrades to `{ degraded: true }` instead of blocking the pool.
  fastify.post("/api/workspaces/:slug/segments/preview-count", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const parsed = previewCountSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const workspace = await resolveWorkspaceMember(request, reply, slug);
    if (!workspace) return;

    try {
      const count = await withTenant(workspace.id, () =>
        countSegmentMembers(parsed.data.definition, { statementTimeoutMs: PREVIEW_COUNT_STATEMENT_TIMEOUT_MS })
      );
      return reply.send({ count });
    } catch (err) {
      const pgCode = (err as { code?: string } | undefined)?.code;
      if (pgCode === QUERY_CANCELED_ERROR_CODE) {
        return reply.send({ degraded: true });
      }
      throw err;
    }
  });

  fastify.get("/api/workspaces/:slug/segments/:id", async (request, reply) => {
    const { slug, id } = request.params as { slug: string; id: string };
    const workspace = await resolveWorkspaceMember(request, reply, slug);
    if (!workspace) return;

    const segment = await withTenant(workspace.id, () => getSegment(id));
    if (!segment) {
      return reply.code(404).send({ error: "Segment not found" });
    }
    return reply.send(toSegmentResponse(segment));
  });

  // D-12: paginated membership list for the segment detail page -- members
  // are contacts, so the response reuses the contacts-shaped mapping.
  fastify.get("/api/workspaces/:slug/segments/:id/members", async (request, reply) => {
    const { slug, id } = request.params as { slug: string; id: string };
    const parsed = segmentMembersQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const workspace = await resolveWorkspaceMember(request, reply, slug);
    if (!workspace) return;

    const segment = await withTenant(workspace.id, () => getSegment(id));
    if (!segment) {
      return reply.code(404).send({ error: "Segment not found" });
    }

    const { page, pageSize } = parsed.data;
    const { items, total } = await withTenant(workspace.id, () =>
      listSegmentMembers(segment.definition, page, pageSize)
    );
    return reply.send({
      items: items.map(toContactResponse),
      total,
      page,
      pageSize,
    });
  });

  fastify.patch("/api/workspaces/:slug/segments/:id", async (request, reply) => {
    const { slug, id } = request.params as { slug: string; id: string };
    const parsed = updateSegmentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const workspace = await resolveWorkspaceMember(request, reply, slug);
    if (!workspace) return;

    const updated = await withTenant(workspace.id, () => updateSegment(id, parsed.data));
    if (!updated) {
      return reply.code(404).send({ error: "Segment not found" });
    }
    return reply.send(toSegmentResponse(updated));
  });

  fastify.delete("/api/workspaces/:slug/segments/:id", async (request, reply) => {
    const { slug, id } = request.params as { slug: string; id: string };
    const workspace = await resolveWorkspaceMember(request, reply, slug);
    if (!workspace) return;

    const deleted = await withTenant(workspace.id, () => deleteSegment(id));
    if (!deleted) {
      return reply.code(404).send({ error: "Segment not found" });
    }
    return reply.send({ deleted: true });
  });
}
