import type { FastifyInstance } from "fastify";
import { workspaceSendSettingsSchema } from "@mega-crm/shared-schemas";
import { getWorkspaceSendSettings, isValidIanaTimezone, upsertWorkspaceSendSettings } from "@mega-crm/delivery-core";
import { requirePermission, toFetchHeaders } from "../../middleware/role-guard.js";
import { getWorkspaceId, withTenant, withTenantTransaction } from "../../middleware/tenant-context.js";
import { findActiveWorkspaceBySlug } from "../tenancy/workspace-lookup.js";
import { getCallerRoles } from "../tenancy/member-roles.js";

/**
 * D-13: per-workspace frequency cap + optional RPS override, PLUS
 * (06-07/D-08/D-09) the workspace default timezone + quiet-hours window.
 * GET is ordinary-member level (read-only); PUT is Owner/Admin-only
 * (`requirePermission("campaign", "launch")`, same gate as launch/schedule
 * per UI-SPEC) since it governs every future send's throttle/cap/timing.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin contract: app.register() resolves the returned promise, and the declared Promise<void> is part of that signature -- dropping async would change it, not simplify it
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

      // T-06-07-01: an invalid IANA zone must never be stored -- the schema
      // above only checks non-empty string format; the actual
      // Intl.supportedValuesOf allowlist check happens here (server-only).
      if (parsed.data.defaultTimezone && !isValidIanaTimezone(parsed.data.defaultTimezone)) {
        return reply.code(400).send({
          error: `"${parsed.data.defaultTimezone}" is not a valid IANA timezone`,
          code: "invalid_timezone",
        });
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
            defaultTimezone: parsed.data.defaultTimezone ?? null,
            quietHoursStart: parsed.data.quietHoursStart ?? null,
            quietHoursEnd: parsed.data.quietHoursEnd ?? null,
            quietHoursEnabled: parsed.data.quietHoursEnabled,
          })
        )
      );
      return reply.send(settings);
    }
  );
}
