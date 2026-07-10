import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createFlowSchema, flowListQuerySchema, updateFlowDraftSchema } from "@mega-crm/shared-schemas";
import type { FlowDefinition } from "@mega-crm/flows-core";
import { auth } from "../auth/auth.js";
import { requirePermission, toFetchHeaders } from "../../middleware/role-guard.js";
import { withTenant } from "../../middleware/tenant-context.js";
import { findActiveWorkspaceBySlug, type ActiveWorkspace } from "../tenancy/workspace-lookup.js";
import { getCallerRoles } from "../tenancy/member-roles.js";
import {
  FlowStateError,
  createFlow,
  duplicateFlow,
  getFlow,
  listFlows,
  pauseFlow,
  publishFlow,
  resumeFlow,
  updateFlowDraft,
  type FlowRow,
} from "./flow.repository.js";
import { getPinnedVersion } from "./flow-version.repository.js";
import { shapeFlowValidationFields } from "./flow-validation.js";

/**
 * Maps a FlowStateError to its HTTP status (D-06/D-18/D-17): `not_found`->404,
 * `illegal_transition`->409 (locked state machine rejected the transition),
 * `incomplete`->422 with the D-17 hard-error `fields` breakdown (only ever
 * thrown by publishFlow). Returns `null` for any other error so the caller
 * re-throws (never swallows an unrelated bug) -- mirrors
 * campaigns.routes.ts's `mapCampaignStateError`.
 */
function mapFlowStateError(err: unknown): { code: number; body: Record<string, unknown> } | null {
  if (!(err instanceof FlowStateError)) return null;
  if (err.code === "not_found") {
    return { code: 404, body: { error: "Flow not found" } };
  }
  if (err.code === "illegal_transition") {
    return { code: 409, body: { error: err.message } };
  }
  return {
    code: 422,
    body: { error: err.message, fields: err.details ? shapeFlowValidationFields(err.details) : {} },
  };
}

async function toFlowResponse(row: FlowRow) {
  // Best-current-editable-definition contract: the working draft if one
  // exists, else the live published definition, else an empty graph (a
  // brand-new flow always has a draft, so this only matters transiently).
  const versionId = row.draftVersionId ?? row.liveVersionId;
  let definition: FlowDefinition = { nodes: [], edges: [] };
  if (versionId) {
    const version = await getPinnedVersion(versionId);
    if (version) definition = version.definition;
  }

  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    status: row.status,
    triggerType: row.triggerType,
    triggerEventName: row.triggerEventName,
    triggerSegmentId: row.triggerSegmentId,
    draftVersionId: row.draftVersionId,
    liveVersionId: row.liveVersionId,
    reentryMode: row.reentryMode,
    reentryWindowDays: row.reentryWindowDays,
    quietHoursMode: row.quietHoursMode,
    quietHoursStart: row.quietHoursStart,
    quietHoursEnd: row.quietHoursEnd,
    exitConditions: row.exitConditions,
    definition,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Resolves `:slug` to a workspace AND confirms the caller is a member --
 * ANY throw from getCallerRoles (unauthenticated, unknown slug, non-member)
 * maps to the SAME 404 a nonexistent workspace returns, so flow routes
 * cannot be used as a workspace-enumeration oracle (mirrors
 * campaigns.routes.ts's resolveWorkspaceMember exactly).
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
 * Flow lifecycle API (FLOW-01/FLOW-04/FLOW-05/FLOW-06/FLOW-07). Ordinary
 * workspace membership is sufficient for create/list/read/draft-update and
 * duplicate -- publish/pause/resume are Owner/Admin-only (D-23) via
 * `requirePermission("flow", "publish")`, the sole action reserved on the
 * `flow` resource (01-01).
 */
export async function registerFlowsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/workspaces/:slug/flows", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const parsed = flowListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const workspace = await resolveWorkspaceMember(request, reply, slug);
    if (!workspace) return;

    const result = await withTenant(workspace.id, () => listFlows(parsed.data));
    return reply.send({
      items: await Promise.all(result.items.map(toFlowResponse)),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    });
  });

  fastify.post("/api/workspaces/:slug/flows", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const parsed = createFlowSchema.safeParse(request.body);
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
      createFlow({ name: parsed.data.name, createdByUserId: session.user.id })
    );
    return reply.code(201).send(await toFlowResponse(created));
  });

  fastify.get("/api/workspaces/:slug/flows/:id", async (request, reply) => {
    const { slug, id } = request.params as { slug: string; id: string };
    const workspace = await resolveWorkspaceMember(request, reply, slug);
    if (!workspace) return;

    const flow = await withTenant(workspace.id, () => getFlow(id));
    if (!flow) {
      return reply.code(404).send({ error: "Flow not found" });
    }
    return reply.send(await toFlowResponse(flow));
  });

  fastify.patch("/api/workspaces/:slug/flows/:id", async (request, reply) => {
    const { slug, id } = request.params as { slug: string; id: string };
    const parsed = updateFlowDraftSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const workspace = await resolveWorkspaceMember(request, reply, slug);
    if (!workspace) return;

    try {
      const updated = await withTenant(workspace.id, () => updateFlowDraft(id, parsed.data));
      return reply.send(await toFlowResponse(updated));
    } catch (err) {
      const mapped = mapFlowStateError(err);
      if (mapped) return reply.code(mapped.code).send(mapped.body);
      throw err;
    }
  });

  // D-23: publish/pause/resume are Owner/Admin-only.
  fastify.post(
    "/api/workspaces/:slug/flows/:id/publish",
    { preHandler: requirePermission("flow", "publish") },
    async (request, reply) => {
      const { slug, id } = request.params as { slug: string; id: string };
      const workspace = await findActiveWorkspaceBySlug(slug);
      if (!workspace) {
        return reply.code(404).send({ error: "Workspace not found" });
      }

      try {
        const published = await withTenant(workspace.id, () => publishFlow(id));
        return reply.send(await toFlowResponse(published));
      } catch (err) {
        const mapped = mapFlowStateError(err);
        if (mapped) return reply.code(mapped.code).send(mapped.body);
        throw err;
      }
    }
  );

  fastify.post(
    "/api/workspaces/:slug/flows/:id/pause",
    { preHandler: requirePermission("flow", "publish") },
    async (request, reply) => {
      const { slug, id } = request.params as { slug: string; id: string };
      const workspace = await findActiveWorkspaceBySlug(slug);
      if (!workspace) {
        return reply.code(404).send({ error: "Workspace not found" });
      }

      try {
        const paused = await withTenant(workspace.id, () => pauseFlow(id));
        return reply.send(await toFlowResponse(paused));
      } catch (err) {
        const mapped = mapFlowStateError(err);
        if (mapped) return reply.code(mapped.code).send(mapped.body);
        throw err;
      }
    }
  );

  fastify.post(
    "/api/workspaces/:slug/flows/:id/resume",
    { preHandler: requirePermission("flow", "publish") },
    async (request, reply) => {
      const { slug, id } = request.params as { slug: string; id: string };
      const workspace = await findActiveWorkspaceBySlug(slug);
      if (!workspace) {
        return reply.code(404).send({ error: "Workspace not found" });
      }

      try {
        const resumed = await withTenant(workspace.id, () => resumeFlow(id));
        return reply.send(await toFlowResponse(resumed));
      } catch (err) {
        const mapped = mapFlowStateError(err);
        if (mapped) return reply.code(mapped.code).send(mapped.body);
        throw err;
      }
    }
  );

  // D-23: duplicate stays Member-allowed (unlike campaigns' launch-gated
  // duplicate) -- it only ever produces a new 'draft' flow, never affects a
  // live/paused flow's state.
  fastify.post("/api/workspaces/:slug/flows/:id/duplicate", async (request, reply) => {
    const { slug, id } = request.params as { slug: string; id: string };
    const workspace = await resolveWorkspaceMember(request, reply, slug);
    if (!workspace) return;

    const session = await auth.api.getSession({ headers: toFetchHeaders(request) });
    if (!session) {
      return reply.code(401).send({ error: "Not authenticated" });
    }

    try {
      const duplicated = await withTenant(workspace.id, () => duplicateFlow(id, session.user.id));
      return reply.code(201).send(await toFlowResponse(duplicated));
    } catch (err) {
      const mapped = mapFlowStateError(err);
      if (mapped) return reply.code(mapped.code).send(mapped.body);
      throw err;
    }
  });
}
