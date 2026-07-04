import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { lookupApiKeyById } from "./api-keys.repository.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by apiKeyAuth once a presented key is verified -- the workspace the caller is scoped to. */
    apiKeyWorkspaceId?: string;
  }
}

export interface GeneratedApiKey {
  /** The full secret, shown to the caller exactly once (D-22) -- never persisted. */
  fullKey: string;
  /** Non-secret, indexed lookup prefix -- this IS `workspace_api_keys.id`. */
  id: string;
  /** SHA-256 hex digest of the secret -- the only form persisted. */
  secretHash: string;
  /** Display mask (prefix + last 4 of the secret) for the management UI list (D-22). */
  keyMask: string;
}

/**
 * Generates a new workspace API key (Pattern 3, D-21/D-22/D-23): `id` is a
 * non-secret 8-byte hex lookup prefix, `secret` is 256 bits of entropy
 * (base64url), and `fullKey` (`mcrm_<id>.<secret>`) is returned to the
 * caller exactly once -- only `secretHash` (SHA-256, not bcrypt/argon2: the
 * secret is already high-entropy, see 02-RESEARCH.md Alternatives
 * Considered) and `keyMask` are ever stored.
 */
export function generateApiKey(): GeneratedApiKey {
  const id = randomBytes(8).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  const fullKey = `mcrm_${id}.${secret}`;
  const secretHash = createHash("sha256").update(secret).digest("hex");
  const keyMask = `mcrm_${id.slice(0, 4)}…${secret.slice(-4)}`;
  return { fullKey, id, secretHash, keyMask };
}

/**
 * T-02-03-02: every failure path returns this exact same body -- missing
 * header, malformed token, unknown id, wrong secret, and revoked key must
 * all be indistinguishable to the caller so the endpoint cannot be used to
 * enumerate valid key ids.
 */
const UNAUTHORIZED_BODY = { error: "Invalid or missing API key" };

/**
 * onRequest hook (Pattern 3): resolves `workspace_id` from a presented
 * `Authorization: Bearer mcrm_<id>.<secret>` header -- the auth mechanism
 * for the Contacts API (CONT-03) and Event API (EVNT-01), distinct from
 * better-auth's session cookies. Registered as `onRequest` (not
 * `preHandler`) so it runs BEFORE Fastify parses the request body
 * (02-RESEARCH.md Pitfall 3) -- important once this guards routes that
 * accept ~1000-event batches.
 *
 * Compares the provided secret's hash against the stored hash with
 * `crypto.timingSafeEqual` (T-02-03-01: no plain `===` on secret material).
 */
export async function apiKeyAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = request.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  const [prefix, secret] = token?.split(".") ?? [];
  const id = prefix?.startsWith("mcrm_") ? prefix.slice("mcrm_".length) : undefined;

  if (!id || !secret) {
    await reply.code(401).send(UNAUTHORIZED_BODY);
    return;
  }

  const row = await lookupApiKeyById(id);
  if (!row || row.revokedAt) {
    await reply.code(401).send(UNAUTHORIZED_BODY);
    return;
  }

  const providedHash = Buffer.from(createHash("sha256").update(secret).digest("hex"));
  const storedHash = Buffer.from(row.secretHash);
  if (providedHash.length !== storedHash.length || !timingSafeEqual(providedHash, storedHash)) {
    await reply.code(401).send(UNAUTHORIZED_BODY);
    return;
  }

  request.apiKeyWorkspaceId = row.workspaceId;
}
