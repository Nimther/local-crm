import type { FastifyInstance } from "fastify";
import { connectSendgridKeySchema } from "@mega-crm/shared-schemas";
import { requirePermission } from "../../middleware/role-guard.js";
import { requireVerifiedEmail } from "../auth/verification-gate.js";
import { withTenant } from "../../middleware/tenant-context.js";
import { encryptTenantSecret, decryptTenantSecret } from "../../kms/client.js";
import { validateTenantSendGridKey } from "./sendgrid-client.js";
import { getKey, upsertKey, updateKeyStatus } from "./sendgrid-key.repository.js";
import { findActiveWorkspaceBySlug } from "./workspace-lookup.js";

const INVALID_KEY_ERROR =
  "SendGrid отклонил ключ: он недействителен или отозван. Проверьте ключ в настройках SendGrid и вставьте его заново.";
const MISSING_SCOPE_ERROR =
  "Ключ действителен, но не имеет права mail.send. Создайте в SendGrid ключ с доступом Mail Send и подключите его.";

function errorCopyFor(reason: "invalid" | "missing_scope"): string {
  return reason === "missing_scope" ? MISSING_SCOPE_ERROR : INVALID_KEY_ERROR;
}

/** D-22: mask shape `SG.aB3x…k9Qz` -- first chars (up to 6) + ellipsis + last 4. */
function maskKey(apiKey: string): string {
  const prefixLen = Math.min(6, apiKey.length);
  const prefix = apiKey.slice(0, prefixLen);
  const suffix = apiKey.slice(-4);
  return `${prefix}…${suffix}`;
}

/**
 * SendGrid key connect + recheck (TENANT-04, D-02/D-19/D-21/D-22). The
 * plaintext key crosses the wire exactly once (this POST body, over TLS)
 * and is never persisted -- only its envelope-encrypted form (via
 * kms/client.ts) and its display mask are stored.
 */
export async function registerSendgridKeyRoutes(fastify: FastifyInstance): Promise<void> {
  /** GET status (D-22): masked key + badge state, visible to any workspace member -- no live SendGrid call. */
  fastify.get("/api/workspaces/:slug/sendgrid-key", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const workspace = await findActiveWorkspaceBySlug(slug);
    if (!workspace) {
      return reply.code(404).send({ error: "Workspace not found" });
    }

    const row = await withTenant(workspace.id, () => getKey());
    if (!row) {
      return reply.send({ connected: false });
    }

    return reply.send({
      connected: true,
      keyMask: row.keyMask,
      status: row.status,
      lastCheckedAt: row.lastCheckedAt ? row.lastCheckedAt.toISOString() : null,
    });
  });

  /** POST connect (D-19/D-02/D-21): role gate THEN verified-email gate, then live-validate, encrypt, and store. */
  fastify.post(
    "/api/workspaces/:slug/sendgrid-key",
    { preHandler: [requirePermission("sendgridKey", "update"), requireVerifiedEmail] },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const parsed = connectSendgridKeySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }

      const workspace = await findActiveWorkspaceBySlug(slug);
      if (!workspace) {
        return reply.code(404).send({ error: "Workspace not found" });
      }

      const validation = await validateTenantSendGridKey(parsed.data.apiKey);
      if (!validation.valid) {
        return reply.code(422).send({ error: errorCopyFor(validation.reason) });
      }

      const encrypted = await encryptTenantSecret(workspace.id, parsed.data.apiKey);
      const keyMask = maskKey(parsed.data.apiKey);

      await withTenant(workspace.id, () =>
        upsertKey({
          ciphertext: encrypted.ciphertext,
          encryptedDek: encrypted.encryptedDek,
          iv: encrypted.iv,
          authTag: encrypted.authTag,
          keyMask,
          status: "active",
        })
      );

      return reply.send({
        connected: true,
        keyMask,
        status: "active",
        verifiedSenders: validation.verifiedSenders,
      });
    }
  );

  /** POST recheck (D-22 "Проверить сейчас"): same role gate as connect (also touches the decrypted key material live). */
  fastify.post(
    "/api/workspaces/:slug/sendgrid-key/recheck",
    { preHandler: requirePermission("sendgridKey", "update") },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const workspace = await findActiveWorkspaceBySlug(slug);
      if (!workspace) {
        return reply.code(404).send({ error: "Workspace not found" });
      }

      const row = await withTenant(workspace.id, () => getKey());
      if (!row) {
        return reply.code(404).send({ error: "SendGrid key not connected" });
      }

      const plaintext = await decryptTenantSecret(workspace.id, {
        ciphertext: row.ciphertext,
        encryptedDek: row.encryptedDek,
        iv: row.iv,
        authTag: row.authTag,
      });

      const validation = await validateTenantSendGridKey(plaintext);
      const status = validation.valid ? "active" : "error";
      await withTenant(workspace.id, () => updateKeyStatus(status));

      if (!validation.valid) {
        return reply.code(422).send({
          connected: true,
          keyMask: row.keyMask,
          status: "error",
          error: errorCopyFor(validation.reason),
        });
      }

      return reply.send({
        connected: true,
        keyMask: row.keyMask,
        status: "active",
        verifiedSenders: validation.verifiedSenders,
      });
    }
  );
}
