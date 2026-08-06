import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { toFetchHeaders } from "../../middleware/role-guard.js";
import { withTenant } from "../../middleware/tenant-context.js";
import { findActiveWorkspaceBySlug, type ActiveWorkspace } from "../tenancy/workspace-lookup.js";
import { getCallerRoles } from "../tenancy/member-roles.js";
import { getFlow } from "../flows/flow.repository.js";
import { getFlowNodeAnalytics, type FlowNodeAnalyticsRow } from "./flow-analytics.repository.js";

/**
 * Resolves `:slug` to a workspace AND confirms the caller is a member --
 * copied verbatim from timeline.routes.ts's `resolveWorkspaceMember` (not
 * exported there) so every analytics route gets the identical
 * workspace-enumeration-safe 404 behavior.
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

function toFlowNodeAnalyticsResponse(row: FlowNodeAnalyticsRow) {
  return {
    nodeId: row.nodeId,
    nodeType: row.nodeType,
    contactCount: row.contactCount,
    ...(row.sent !== undefined
      ? {
          sent: row.sent,
          delivered: row.delivered,
          opened: row.opened,
          clicked: row.clicked,
          bounced: row.bounced,
        }
      : {}),
  };
}

/**
 * ANLT-02: per-flow-step metrics behind the canvas node badges and the
 * "Аналитика" comparison table tab. Ordinary workspace membership is
 * sufficient (analytics is readable by every role including Member).
 *
 * T-07-04-01 (IDOR): mirrors flows.routes.ts's `getFlow(id)` existence-check
 * pattern -- an explicit lookup 404s a foreign-workspace flow id (never an
 * empty 200), on top of RLS on flow_run_steps/flow_runs/sends underneath.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin contract: app.register() resolves the returned promise, and the declared Promise<void> is part of that signature -- dropping async would change it, not simplify it
export async function registerFlowAnalyticsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/workspaces/:slug/flows/:id/analytics", async (request, reply) => {
    const { slug, id } = request.params as { slug: string; id: string };
    const workspace = await resolveWorkspaceMember(request, reply, slug);
    if (!workspace) return;

    const body = await withTenant(workspace.id, async () => {
      const flow = await getFlow(id);
      if (!flow) return null;
      return getFlowNodeAnalytics(id);
    });
    if (!body) {
      return reply.code(404).send({ error: "Flow not found" });
    }
    return reply.send(body.map(toFlowNodeAnalyticsResponse));
  });
}
