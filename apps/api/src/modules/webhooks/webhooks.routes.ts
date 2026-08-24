import type { FastifyInstance } from "fastify";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { writeIngressJournal } from "@mega-crm/db/src/webhooks/ingress-journal.js";
import { findWebhookEndpointByToken } from "./webhook-endpoint.repository.js";
import { verifyWebhookSignature, isWebhookTimestampFresh } from "./signature-verify.js";
import { enqueueWebhookBatch } from "./enqueue.js";
import { env } from "../../env.js";
import { logger } from "../../logger.js";
import { isWorkspaceSoftDeletedById } from "../tenancy/workspace-lookup.js";

/**
 * Phase 16 (D-09): the fixed, greppable marker the capture log line below
 * carries in its message -- plan 16-04's operator extracts the capture with
 * a `docker compose logs | grep` on exactly this literal, so it must stay
 * stable (recorded verbatim in 16-03-SUMMARY.md).
 */
export const WEBHOOK_RAW_CAPTURE_LOG_MARKER = "UAT16_WEBHOOK_RAW_CAPTURE";

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
 * - Phase 13 (CMP-08, D-05, plan 13-01): between "parse" and "enqueue" above,
 *   the verified batch is now journaled -- `writeIngressJournal` runs inside
 *   `withTenant`/`withTenantTransaction` and its returned id is forwarded to
 *   `enqueueWebhookBatch`. This is the sole ordering this plan enforces: the
 *   journal write sits strictly AFTER verification (T-13-01-01 -- an
 *   unverified payload must never be journaled) and strictly BEFORE the
 *   BullMQ enqueue, and the enqueue call itself sits OUTSIDE the journal's
 *   own transaction (after it has already committed) -- enqueuing from
 *   inside the transaction risks a worker claiming the job and calling
 *   `markIngestionComplete` before the journal row is even visible to it,
 *   and a later rollback of an already-enqueued job would violate "a
 *   journal-write failure enqueues nothing". If `writeIngressJournal` throws,
 *   the request fails closed with a 500 and `enqueueWebhookBatch` is never
 *   called -- the journal is a precondition for accepting the delivery, and
 *   SendGrid's own ~24h retry window is the recovery path, not a fallback
 *   enqueue-without-journal path.
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

      // Phase 22 (PRG-06, D-04): a soft-deleted workspace's endpoint is
      // dropped as the SAME bare 404 as an unknown pathToken -- not a
      // distinguishable body, code or header. This surface is anonymous and
      // unauthenticated (unlike apiKeyAuth's 403 above), so any response
      // difference would turn it into a workspace-state oracle for anyone
      // holding a guessed token (T-05-03's existing no-enumeration
      // discipline). The check consumes ONLY `endpoint.workspaceId`, which
      // the token lookup already produced -- no body read, no parse, and no
      // re-ordering relative to `verifyWebhookSignature` below for any live
      // workspace: this branch runs strictly BEFORE signature verification
      // is even reached, so the raw bytes are still untouched for every
      // request that gets here. A later reader must not "fix" this by moving
      // the check after verification -- the check is deliberately placed
      // ahead of it, at zero cost to the raw-body-untouched rule, because a
      // deleted workspace's key material deserves no signature-verification
      // work at all.
      //
      // Deliberate consequence (recorded here, not accidental): late
      // delivery evidence for mail sent before the delete is discarded
      // rather than journalled -- the drop happens BEFORE the journal write,
      // never after it. `ingress_journal` exists to prove delivery
      // accountability for a tenant that no longer has standing to receive
      // it; full quiesce over evidence completion is the trade CONTEXT.md's
      // D-04 made knowingly.
      if (await isWorkspaceSoftDeletedById(endpoint.workspaceId)) {
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

      // Phase 16 (D-09): raw-payload capture -- strictly AFTER both gates
      // above have passed (never earlier "to catch everything just in
      // case", T-16-12) and strictly BEFORE the JSON.parse below (so the
      // captured bytes are always the exact, already-verified wire bytes,
      // never a re-serialised/parsed form -- `ingress_journal` stores the
      // latter and therefore cannot be UAT-03's replay source, RESEARCH.md
      // Pattern 3). Read directly from `process.env`, NOT through
      // `apps/api/src/env.ts`'s frozen zod-parsed `env` object -- see
      // 16-03-SUMMARY.md for the placement decision (a UAT-session-scoped
      // toggle must be flippable within a single running process, matching
      // this file's own request-time read pattern rather than a boot-time
      // schema value). Scoped by an EXACT workspace-id match (never a
      // prefix/list/boolean, T-16-11) and default-off; an empty string
      // counts as absent. Adds no branch that changes any response an
      // external caller can observe (T-16-13) -- every codepath after this
      // block runs identically whether or not the capture fired.
      const captureWorkspaceId = process.env.WEBHOOK_RAW_CAPTURE_WORKSPACE_ID;
      if (
        captureWorkspaceId &&
        captureWorkspaceId.length > 0 &&
        captureWorkspaceId === endpoint.workspaceId
      ) {
        // Field names deliberately avoid every REDACTION_RULES.keyRules name
        // (packages/redaction/src/rules.ts) -- `rawBodyBase64`,
        // `signatureHeaderValue`, `timestampHeaderValue` match none of
        // `token`/`secret`/`email`/etc, so Pino's `PINO_REDACT_OPTIONS`
        // field-path redaction never touches this line and the base64
        // payload survives fully decodable for UAT-03's byte-exact replay.
        // Pino's `redact` option is a PATH-based mechanism only (no
        // value-pattern matching on a structured log call, unlike
        // `scrub()`'s freeform-payload walk), so this finding does not
        // depend on the base64 encoding itself -- it is a consequence of the
        // chosen field names, recorded here and in 16-03-SUMMARY.md.
        logger.info(
          {
            rawBodyBase64: rawBody.toString("base64"),
            signatureHeaderValue: signature,
            timestampHeaderValue: timestamp,
            workspaceId: endpoint.workspaceId,
          },
          `${WEBHOOK_RAW_CAPTURE_LOG_MARKER} verified raw webhook payload captured for the configured UAT capture workspace`
        );
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

      // Phase 13 (CMP-08, D-05): journal the verified batch BEFORE enqueue.
      // A journal-write failure fails the request closed (500) -- no
      // enqueue -- rather than falling through to enqueue-without-journal,
      // which would silently reintroduce the exact unreplayable-loss gap
      // this table exists to close. SendGrid's own retry window recovers a
      // 5xx the same way it recovers any other transient failure.
      let journalId: string;
      try {
        journalId = await withTenant(endpoint.workspaceId, () =>
          withTenantTransaction((client) => writeIngressJournal(client, endpoint.workspaceId, events))
        );
      } catch {
        return reply.code(500).send();
      }

      await enqueueWebhookBatch(endpoint.workspaceId, events, journalId);

      // Ack fast (RESEARCH.md Pattern 2) -- all real processing happens in
      // apps/worker/src/queues/webhook-events.worker.ts.
      return reply.code(200).send();
    }
  );
}
