import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { toFetchHeaders } from "../../middleware/role-guard.js";
import { withTenant } from "../../middleware/tenant-context.js";
import { findActiveWorkspaceBySlug, type ActiveWorkspace } from "../tenancy/workspace-lookup.js";
import { getCallerRoles } from "../tenancy/member-roles.js";
import { getWorkspaceDashboard, type DashboardPeriod } from "./dashboard.repository.js";

/** D-08: closed set of period presets -- validated against the query-string literal, then transformed to the numeric period the repository expects. Any other value 400s. */
const dashboardQuerySchema = z.object({
  period: z
    .enum(["7", "30", "90"])
    .optional()
    .default("30")
    .transform((value): DashboardPeriod => Number(value) as DashboardPeriod),
});

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

/**
 * ANLT-04/D-08: the workspace summary dashboard's sole read route. Ordinary
 * workspace membership is sufficient (analytics is readable by every role
 * including Member, per RESEARCH.md V4 -- no elevated-role check).
 *
 * T-07-07-01 (IDOR/info-disclosure): `resolveWorkspaceMember` + `withTenant`
 * scope every read (rollup + contacts + campaigns/flows mini-lists) to the
 * caller's own workspace under RLS.
 */
export async function registerDashboardRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/workspaces/:slug/dashboard", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const parsed = dashboardQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const workspace = await resolveWorkspaceMember(request, reply, slug);
    if (!workspace) return;

    const result = await withTenant(workspace.id, () => getWorkspaceDashboard(parsed.data.period));
    return reply.send(result);
  });
}
