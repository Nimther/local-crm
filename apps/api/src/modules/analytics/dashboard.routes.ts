import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "../../middleware/tenant-context.js";
import { resolveWorkspaceMember } from "../tenancy/resolve-workspace-member.js";
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
 * ANLT-04/D-08: the workspace summary dashboard's sole read route. Ordinary
 * workspace membership is sufficient (analytics is readable by every role
 * including Member, per RESEARCH.md V4 -- no elevated-role check).
 *
 * T-07-07-01 (IDOR/info-disclosure): `resolveWorkspaceMember` + `withTenant`
 * scope every read (rollup + contacts + campaigns/flows mini-lists) to the
 * caller's own workspace under RLS.
 *
 * Phase 15 (OPS-18, D-12, plan 15-12): the response now also carries
 * `dataAsOf`/`lagMinutes` (`@mega-crm/shared-schemas`'s
 * `WorkspaceDashboardFreshness`, computed in `dashboard.repository.ts`) --
 * the honest "data as of" timestamp and staleness signal plan 15-15's
 * frontend renders. No new route/schema wiring needed here: the response is
 * still a single unvalidated JSON body (this route has never had an output
 * schema), so the two fields simply flow through `reply.send(result)`.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin contract: app.register() resolves the returned promise, and the declared Promise<void> is part of that signature -- dropping async would change it, not simplify it
export async function registerDashboardRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/workspaces/:slug/dashboard", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const parsed = dashboardQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const resolved = await resolveWorkspaceMember(request, reply, slug);
    if (!resolved) return;
    const workspace = resolved.workspace;

    const result = await withTenant(workspace.id, () => getWorkspaceDashboard(parsed.data.period));
    return reply.send(result);
  });
}
