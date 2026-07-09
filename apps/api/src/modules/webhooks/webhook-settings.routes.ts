import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { WebhookHealthResponse } from "@mega-crm/shared-schemas";
import { decryptTenantSecret } from "@mega-crm/kms";
import { requirePermission, toFetchHeaders } from "../../middleware/role-guard.js";
import { withTenant } from "../../middleware/tenant-context.js";
import { env } from "../../env.js";
import { findActiveWorkspaceBySlug } from "../tenancy/workspace-lookup.js";
import { getCallerRoles } from "../tenancy/member-roles.js";
import { getKey } from "../tenancy/sendgrid-key.repository.js";
import { provisionEventWebhook } from "./sendgrid-webhook-provision.js";
import { getWebhookEndpointByWorkspace, upsertWebhookEndpoint } from "./webhook-endpoint.repository.js";

/**
 * Authenticated webhook health + reconnect surface (D-03, WBHK-01) --
 * ordinary session-gated JSON routes, structurally SEPARATE from
 * `webhooks.routes.ts`'s raw-body public receiver so that route's
 * `application/json` buffer-parser override stays scoped to only its own
 * module (Fastify plugin encapsulation).
 */
export async function registerWebhookSettingsRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET health (D-03): member-readable, mirrors the sendgrid-key GET status
   * anti-enumeration pattern -- ANY throw from `getCallerRoles` (unknown
   * slug, unauthenticated caller, non-member) maps to the SAME 404 a
   * nonexistent workspace returns (no enumeration oracle, T-05-03). Never
   * returns the `pathToken` or `publicKey`.
   */
  fastify.get("/api/workspaces/:slug/webhook-health", async (request, reply) => {
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

    const endpoint = await withTenant(workspace.id, () => getWebhookEndpointByWorkspace());

    const body: WebhookHealthResponse = endpoint
      ? {
          connected: endpoint.provisionStatus === "active",
          provisionStatus: endpoint.provisionStatus as WebhookHealthResponse["provisionStatus"],
          lastEventAt: endpoint.lastEventAt ? endpoint.lastEventAt.toISOString() : null,
        }
      : { connected: false, provisionStatus: "pending", lastEventAt: null };

    return reply.send(body);
  });

  /**
   * POST reconnect (D-02 "Переподключить" / D-03): same authority as
   * sendgrid-key recheck (`requirePermission("sendgridKey","update")`) since
   * it decrypts and uses the tenant's live key. Reuses the stored pathToken
   * + sendgridWebhookId so this PATCHes the platform's own webhook in place
   * rather than accumulating a duplicate (D-05, Pitfall 4).
   */
  fastify.post(
    "/api/workspaces/:slug/webhook-reconnect",
    { preHandler: requirePermission("sendgridKey", "update") },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const workspace = await findActiveWorkspaceBySlug(slug);
      if (!workspace) {
        return reply.code(404).send({ error: "Workspace not found" });
      }

      const body: WebhookHealthResponse | null = await withTenant(workspace.id, async () => {
        const keyRow = await getKey();
        if (!keyRow) {
          return null;
        }

        const plaintext = await decryptTenantSecret(workspace.id, {
          ciphertext: keyRow.ciphertext,
          encryptedDek: keyRow.encryptedDek,
          iv: keyRow.iv,
          authTag: keyRow.authTag,
        });

        const existing = await getWebhookEndpointByWorkspace();
        const pathToken = existing?.pathToken ?? randomBytes(32).toString("base64url");
        const callbackUrl = `${env.PUBLIC_APP_URL}/webhooks/sendgrid/${pathToken}`;

        const result = await provisionEventWebhook(
          plaintext,
          callbackUrl,
          workspace.id,
          existing?.sendgridWebhookId ?? undefined
        );

        if ("error" in result) {
          await upsertWebhookEndpoint({
            pathToken,
            sendgridWebhookId: existing?.sendgridWebhookId ?? null,
            publicKey: existing?.publicKey ?? null,
            provisionStatus: "error",
          });
          return { connected: false, provisionStatus: "error", lastEventAt: existing?.lastEventAt?.toISOString() ?? null };
        }

        await upsertWebhookEndpoint({
          pathToken,
          sendgridWebhookId: result.id,
          publicKey: result.publicKey,
          provisionStatus: "active",
        });
        return { connected: true, provisionStatus: "active", lastEventAt: existing?.lastEventAt?.toISOString() ?? null };
      });

      if (!body) {
        return reply.code(404).send({ error: "SendGrid key not connected" });
      }

      return reply.send(body);
    }
  );
}
