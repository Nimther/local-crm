import type { FastifyInstance } from "fastify";
import { workspaceSendSettingsSchema } from "@mega-crm/shared-schemas";
import { getWorkspaceSendSettings, upsertWorkspaceSendSettings } from "@mega-crm/delivery-core";
import { requirePermission, toFetchHeaders } from "../../middleware/role-guard.js";
import { getWorkspaceId, withTenant, withTenantTransaction } from "../../middleware/tenant-context.js";
import { findActiveWorkspaceBySlug } from "../tenancy/workspace-lookup.js";
import { getCallerRoles } from "../tenancy/member-roles.js";

/**
 * D-13: per-workspace frequency cap + optional RPS override. GET is
 * ordinary-member level (read-only); PUT is Owner/Admin-only
 * (`requirePermission("campaign", "launch")`, same gate as launch/schedule
 * per UI-SPEC) since it governs every future send's throttle/cap.
 */
export async function registerSendSettingsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/workspaces/:slug/send-settings", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const workspace = await findActiveWorkspaceBySlug(slug);
    if (!workspace) {
      return reply.code(404).send({ error: "Workspace not found" });
    }

    try {
      await getCallerRoles(toFetchHeaders(request), slug);
    } catch {
      return reply.code(404).send({ error: "Workspace not found" });
    }

    const settings = await withTenant(workspace.id, () =>
      withTenantTransaction((client) => getWorkspaceSendSettings(client, getWorkspaceId()))
    );
    return reply.send(settings);
  });

  fastify.put(
    "/api/workspaces/:slug/send-settings",
    { preHandler: requirePermission("campaign", "launch") },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const parsed = workspaceSendSettingsSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }

      const workspace = await findActiveWorkspaceBySlug(slug);
      if (!workspace) {
        return reply.code(404).send({ error: "Workspace not found" });
      }

      const settings = await withTenant(workspace.id, () =>
        withTenantTransaction((client) =>
          upsertWorkspaceSendSettings(client, getWorkspaceId(), {
            frequencyCap: parsed.data.frequencyCap,
            frequencyWindowHours: parsed.data.frequencyWindowHours,
            rpsLimit: parsed.data.rpsLimit ?? null,
          })
        )
      );
      return reply.send(settings);
    }
  );
}
