import type { FastifyInstance } from "fastify";
import { findWebhookEndpointByToken } from "./webhook-endpoint.repository.js";
import { verifyWebhookSignature, isWebhookTimestampFresh } from "./signature-verify.js";
import { enqueueWebhookBatch } from "./enqueue.js";
import { env } from "../../env.js";

/**
 * Public SendGrid Event Webhook receiver (WBHK-01, D-14/D-16). Registered
 * top-level (no session, no workspace `:slug` prefix, no auth preHandler) --
 * SendGrid's own delivery infrastructure must be able to reach this with
 * zero platform context beyond the per-tenant `:pathToken` URL segment.
 *
 * Threat model (T-05-01/T-05-02/T-05-03, T-10-11-01..06):
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
 * - Invalid/missing signature, a STALE or FUTURE-dated signature timestamp
 *   (older/newer than `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS`, default 600s,
 *   T-10-11-01/02), and a malformed/missing timestamp header (T-10-11-03)
 *   are ALL indistinguishable to the caller -> the same 400, DROP: no
 *   `JSON.parse`, no enqueue -- fails closed. `isWebhookTimestampFresh`
 *   composes WITH `verifyWebhookSignature`, never replaces it (T-10-11-04)
 *   -- a fresh timestamp cannot substitute for a valid signature. Note:
 *   this bounds ONLY the header timestamp the signature is computed over
 *   (T-10-11-06) -- each event's OWN `timestamp` field inside the batch
 *   body is a structurally different value (RESEARCH.md Pitfall 6) and is
 *   deliberately untouched here (Phase 13's CMP-05 territory).
 * - Only after a valid signature AND a fresh timestamp does the raw body
 *   get `JSON.parse`d and the ENTIRE verified batch enqueued as one job
 *   (RESEARCH.md Pattern 2: ack-fast, never per-event) -- all real
 *   processing (dedup insert into `send_events`) happens asynchronously in
 *   apps/worker.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin contract: app.register() resolves the returned promise, and the declared Promise<void> is part of that signature -- dropping async would change it, not simplify it
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

  fastify.post(
    "/webhooks/sendgrid/:pathToken",
    {
      // SEC-11/T-10-12-02: this route had NO rate-limit config before this
      // plan, and `global: false` on the app-root registration (server.ts)
      // means "no config" is the same as "not limited at all" -- adding
      // this block is what makes the webhook surface limited in the first
      // place, not merely what tunes an existing limit.
      //
      // It gets its OWN bucket (a distinct child store, keyed by this
      // route's method+URL -- see @fastify/rate-limit's RedisStore.child())
      // rather than sharing config.rateLimit with any session-authenticated
      // route, so a flood on this PUBLIC, unauthenticated-until-signature-
      // verified surface cannot consume the allowance the invite-accept or
      // contacts/events ingest routes depend on, and vice versa.
      //
      // Sizing: SendGrid's Event Webhook batches multiple events into one
      // POST rather than posting per-event, and documents batching by size
      // (not a fixed interval) -- so the number to size against is "how
      // often can one POST land," not "how many events per second." A
      // single tenant mid-broadcast, with opens/clicks arriving in a burst
      // right after send, could plausibly produce a new batch every couple
      // of seconds; 100 requests / 10 seconds (10/s sustained) is an order
      // of magnitude above that, which is the headroom this number is
      // trying to buy. If this ever fires against genuine SendGrid traffic,
      // that is a signal the assumption above was wrong, not that the
      // limit is merely "a bit low."
      config: { rateLimit: { max: 100, timeWindow: "10 seconds" } },
    },
    async (request, reply) => {
      const { pathToken } = request.params as { pathToken: string };

      const endpoint = await findWebhookEndpointByToken(pathToken);
      if (!endpoint || !endpoint.publicKey) {
        // Generic 404 -- covers both "no such pathToken" and "provisioned but
        // no public key yet" identically, so neither state is distinguishable
        // from the outside (T-05-03).
        return reply.code(404).send();
      }

      const rawBody = request.body as Buffer;
      const signature = request.headers["x-twilio-email-event-webhook-signature"] as
        | string
        | undefined;
      const timestamp = request.headers["x-twilio-email-event-webhook-timestamp"] as
        | string
        | undefined;

      const isValid = verifyWebhookSignature(endpoint.publicKey, rawBody, signature, timestamp);
      const isFresh = isWebhookTimestampFresh(timestamp, env.WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS);
      if (!isValid || !isFresh) {
        // Fail closed (T-05-01, T-10-11-01..04): a bad signature and a
        // stale/future/malformed/missing timestamp all take this SAME
        // return -- no JSON.parse, no enqueue, no distinguishing message.
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
    }
  );
}
