import type { FastifyInstance } from "fastify";
import { findWebhookEndpointByToken } from "./webhook-endpoint.repository.js";
import { verifyWebhookSignature } from "./signature-verify.js";
import { enqueueWebhookBatch } from "./enqueue.js";

/**
 * Public SendGrid Event Webhook receiver (WBHK-01, D-14/D-16). Registered
 * top-level (no session, no workspace `:slug` prefix, no auth preHandler) --
 * SendGrid's own delivery infrastructure must be able to reach this with
 * zero platform context beyond the per-tenant `:pathToken` URL segment.
 *
 * Threat model (T-05-01/T-05-02/T-05-03):
 * - Unknown `pathToken` -> generic 404 BEFORE any signature attempt -- no
 *   distinction from "valid token, bad signature" beyond this point avoids
 *   leaking which tokens are provisioned (no enumeration oracle).
 * - The `application/json` content-type parser is overridden to capture the
 *   RAW request body as a `Buffer` -- scoped to THIS route module only
 *   (Fastify plugin encapsulation, mirrors unsubscribe.routes.ts's
 *   `application/x-www-form-urlencoded` override) -- Fastify's default
 *   JSON parser NEVER touches this route, so the ECDSA signature (computed
 *   by SendGrid over the exact raw bytes) can be verified before anything
 *   parses/mutates the body (CLAUDE.md "What NOT to Use": parsing the
 *   webhook body before signature verification is explicitly forbidden).
 * - Invalid/missing signature -> 400, DROP: no `JSON.parse`, no enqueue --
 *   fails closed. A bad signature and a technically-valid-but-corrupt
 *   payload are indistinguishable to the caller.
 * - Only after a valid signature does the raw body get `JSON.parse`d and
 *   the ENTIRE verified batch enqueued as one job (RESEARCH.md Pattern 2:
 *   ack-fast, never per-event) -- all real processing (dedup insert into
 *   `send_events`) happens asynchronously in apps/worker.
 */
export async function registerWebhookRoutes(fastify: FastifyInstance): Promise<void> {
  // Scoped to this route module only (Fastify plugin encapsulation) --
  // registerWebhookRoutes is a plain async function (not fastify-plugin),
  // so this override cannot weaken body parsing for any other route
  // (/api/auth/*, contacts, campaigns, segments all keep Fastify's default
  // JSON parser/validator pipeline).
  fastify.addContentTypeParser(
    "application/json",
    { parseAs: "buffer", bodyLimit: 1_000_000 },
    (_request, body, done) => {
      done(null, body);
    }
  );

  fastify.post("/webhooks/sendgrid/:pathToken", async (request, reply) => {
    const { pathToken } = request.params as { pathToken: string };

    const endpoint = await findWebhookEndpointByToken(pathToken);
    if (!endpoint || !endpoint.publicKey) {
      // Generic 404 -- covers both "no such pathToken" and "provisioned but
      // no public key yet" identically, so neither state is distinguishable
      // from the outside (T-05-03).
      return reply.code(404).send();
    }

    const rawBody = request.body as Buffer;
    const signature = request.headers["x-twilio-email-event-webhook-signature"] as string | undefined;
    const timestamp = request.headers["x-twilio-email-event-webhook-timestamp"] as string | undefined;

    const isValid = verifyWebhookSignature(endpoint.publicKey, rawBody, signature, timestamp);
    if (!isValid) {
      // Fail closed (T-05-01): no JSON.parse, no enqueue.
      return reply.code(400).send();
    }

    let events: unknown[];
    try {
      const parsed: unknown = JSON.parse(rawBody.toString("utf8"));
      events = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      // Should never happen for a genuine SendGrid request (the signature
      // covers the exact raw bytes, so a signature-valid body is
      // well-formed JSON by construction) -- defensive-only fail-closed
      // path, still no enqueue.
      return reply.code(400).send();
    }

    await enqueueWebhookBatch(endpoint.workspaceId, events);

    // Ack fast (RESEARCH.md Pattern 2) -- all real processing happens in
    // apps/worker/src/queues/webhook-events.worker.ts.
    return reply.code(200).send();
  });
}
