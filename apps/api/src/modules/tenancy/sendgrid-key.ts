import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { connectSendgridKeySchema } from "@mega-crm/shared-schemas";
import { requirePermission, toFetchHeaders } from "../../middleware/role-guard.js";
import { requireVerifiedEmail } from "../auth/verification-gate.js";
import { withTenant } from "../../middleware/tenant-context.js";
import { encryptTenantSecret, decryptTenantSecret } from "@mega-crm/kms";
import { env } from "../../env.js";
import { validateTenantSendGridKey } from "./sendgrid-client.js";
import { getKey, upsertKey, updateKeyStatus } from "./sendgrid-key.repository.js";
import { findActiveWorkspaceBySlug } from "./workspace-lookup.js";
import { getCallerRoles } from "./member-roles.js";
import { provisionEventWebhook } from "../webhooks/sendgrid-webhook-provision.js";
import {
  getWebhookEndpointByWorkspace,
  upsertWebhookEndpoint,
} from "../webhooks/webhook-endpoint.repository.js";
import { webhookWarningFor, WEBHOOK_PROVISION_FAILED_WARNING } from "../webhooks/webhook-warning-copy.js";

const INVALID_KEY_ERROR =
  "SendGrid отклонил ключ: он недействителен или отозван. Проверьте ключ в настройках SendGrid и вставьте его заново.";
const MISSING_SCOPE_ERROR =
  "Ключ действителен, но не имеет права mail.send. Создайте в SendGrid ключ с доступом Mail Send и подключите его.";

function errorCopyFor(reason: "invalid" | "missing_scope"): string {
  return reason === "missing_scope" ? MISSING_SCOPE_ERROR : INVALID_KEY_ERROR;
}

/**
 * D-01/D-02/D-05: best-effort provisioning of the platform's own Event
 * Webhook, called AFTER the SendGrid key itself has already been
 * successfully connected/rechecked -- MUST be invoked from inside the same
 * `withTenant(...)` scope that just wrote the key, and MUST NEVER throw
 * (any exception here is caught by `provisionEventWebhook` itself; this
 * wrapper adds a second layer so a bug in the endpoint-repository writes
 * still cannot fail the key connect, D-01 fallback). Returns a non-fatal
 * warning string to surface to the caller, or `undefined` on success.
 */
async function provisionWebhookBestEffort(
  workspaceId: string,
  apiKey: string,
  webhookScopePresent: boolean
): Promise<string | undefined> {
  try {
    const existing = await getWebhookEndpointByWorkspace();

    if (!webhookScopePresent) {
      // 05-09: the key already lacks the webhook-management scope -- skip
      // the doomed CREATE/PATCH call and persist a deterministic reason
      // instead of attempting (and silently failing) it.
      const pathToken = existing?.pathToken ?? randomBytes(32).toString("base64url");
      await upsertWebhookEndpoint({
        pathToken,
        sendgridWebhookId: existing?.sendgridWebhookId ?? null,
        publicKey: existing?.publicKey ?? null,
        provisionStatus: "error",
        provisionError: "missing_scope",
      });
      return webhookWarningFor("missing_scope");
    }

    const pathToken = existing?.pathToken ?? randomBytes(32).toString("base64url");
    const callbackUrl = `${env.PUBLIC_APP_URL}/webhooks/sendgrid/${pathToken}`;

    const result = await provisionEventWebhook(
      apiKey,
      callbackUrl,
      workspaceId,
      existing?.sendgridWebhookId ?? undefined
    );

    if ("error" in result) {
      await upsertWebhookEndpoint({
        pathToken,
        sendgridWebhookId: result.webhookId ?? existing?.sendgridWebhookId ?? null,
        publicKey: existing?.publicKey ?? null,
        provisionStatus: "error",
        provisionError: result.error,
      });
      return webhookWarningFor(result.error);
    }

    await upsertWebhookEndpoint({
      pathToken,
      sendgridWebhookId: result.id,
      publicKey: result.publicKey,
      provisionStatus: "active",
      provisionError: null,
    });
    return undefined;
  } catch {
    // Defense-in-depth (D-01): provisioning must never fail the key connect.
    return WEBHOOK_PROVISION_FAILED_WARNING;
  }
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
  /**
   * GET status (D-22, CR-01): masked key + badge state, gated to workspace
   * members -- no live SendGrid call. getCallerRoles throws for an
   * unauthenticated caller, an unknown slug, and a non-member alike
   * (better-auth's getActiveMemberRole); ANY throw here maps to the SAME 404
   * a nonexistent workspace returns, so the route cannot be used as a
   * workspace-enumeration oracle (T-01-06/T-01-07/T-01-11).
   */
  fastify.get("/api/workspaces/:slug/sendgrid-key", async (request, reply) => {
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

      const webhookWarning = await withTenant(workspace.id, async () => {
        await upsertKey({
          ciphertext: encrypted.ciphertext,
          encryptedDek: encrypted.encryptedDek,
          iv: encrypted.iv,
          authTag: encrypted.authTag,
          keyMask,
          status: "active",
        });
        // D-01/D-02: best-effort, non-blocking -- a webhook provisioning
        // failure never turns this successful key connect into a failure.
        return provisionWebhookBestEffort(workspace.id, parsed.data.apiKey, validation.webhookScopePresent);
      });

      return reply.send({
        connected: true,
        keyMask,
        status: "active",
        verifiedSenders: validation.verifiedSenders,
        ...(webhookWarning ? { webhookWarning } : {}),
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

      const webhookWarning = await withTenant(workspace.id, async () => {
        await updateKeyStatus(status);
        // D-01/D-02: only provision against a key that just re-validated as
        // active -- an invalid/revoked key has nothing live to provision
        // against, and the 422 branch below never reaches this warning.
        return status === "active"
          ? provisionWebhookBestEffort(workspace.id, plaintext, validation.valid ? validation.webhookScopePresent : false)
          : undefined;
      });

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
        ...(webhookWarning ? { webhookWarning } : {}),
      });
    }
  );
}
