import type { FastifyInstance } from "fastify";
import { createApiKeySchema } from "@mega-crm/shared-schemas";
import { requirePermission } from "../../middleware/role-guard.js";
import { withTenant } from "../../middleware/tenant-context.js";
import { findActiveWorkspaceBySlug } from "../tenancy/workspace-lookup.js";
import { generateApiKey } from "./api-key-auth.js";
import { createApiKey, listApiKeys, revokeApiKey, type ApiKeyListItemRow } from "./api-keys.repository.js";

function toListItem(row: ApiKeyListItemRow) {
  return {
    id: row.id,
    name: row.name,
    keyMask: row.keyMask,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
  };
}

/**
 * Owner/Admin-gated management of workspace API keys (D-21) -- the
 * credential every server-to-server call to the Contacts/Event API (built
 * in 02-04/02-06) will present. Session-authed, distinct from the runtime
 * `apiKeyAuth` hook these keys are verified by (api-key-auth.ts).
 */
// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin contract: app.register() resolves the returned promise, and the declared Promise<void> is part of that signature -- dropping async would change it, not simplify it
export async function registerApiKeyRoutes(fastify: FastifyInstance): Promise<void> {
  /** GET list -- masked keys only, never the secret or its hash (D-22). */
  fastify.get(
    "/api/workspaces/:slug/api-keys",
    { preHandler: [requirePermission("apiKeys", "create")] },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const workspace = await findActiveWorkspaceBySlug(slug);
      if (!workspace) {
        return reply.code(404).send({ error: "Workspace not found" });
      }

      const rows = await withTenant(workspace.id, () => listApiKeys());
      return reply.send(rows.map(toListItem));
    }
  );

  /** POST create -- generates the key, stores only hash+mask, returns the full secret exactly once (D-21/D-22). */
  fastify.post(
    "/api/workspaces/:slug/api-keys",
    { preHandler: [requirePermission("apiKeys", "create")] },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const parsed = createApiKeySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }

      const workspace = await findActiveWorkspaceBySlug(slug);
      if (!workspace) {
        return reply.code(404).send({ error: "Workspace not found" });
      }

      const generated = generateApiKey();
      const row = await withTenant(workspace.id, () =>
        createApiKey({
          id: generated.id,
          name: parsed.data.name,
          secretHash: generated.secretHash,
          keyMask: generated.keyMask,
        })
      );

      return reply.send({ ...toListItem(row), fullKey: generated.fullKey });
    }
  );

  /** POST revoke -- same 404-non-enumeration shape as sendgrid-key.ts for an unknown id (D-21). */
  fastify.post(
    "/api/workspaces/:slug/api-keys/:id/revoke",
    { preHandler: [requirePermission("apiKeys", "revoke")] },
    async (request, reply) => {
      const { slug, id } = request.params as { slug: string; id: string };
      const workspace = await findActiveWorkspaceBySlug(slug);
      if (!workspace) {
        return reply.code(404).send({ error: "Workspace not found" });
      }

      const revoked = await withTenant(workspace.id, () => revokeApiKey(id));
      if (!revoked) {
        return reply.code(404).send({ error: "API key not found" });
      }

      return reply.send({ revoked: true });
    }
  );
}
