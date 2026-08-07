import type { FastifyInstance } from "fastify";
import { withTenant } from "../../middleware/tenant-context.js";
import { resolveWorkspaceMember } from "../tenancy/resolve-workspace-member.js";
import { getFlow } from "../flows/flow.repository.js";
import { getFlowNodeAnalytics, type FlowNodeAnalyticsRow } from "./flow-analytics.repository.js";

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
    const resolved = await resolveWorkspaceMember(request, reply, slug);
    if (!resolved) return;
    const workspace = resolved.workspace;

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
