import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eventEnvelopeSchema, MAX_EVENT_BATCH_SIZE, type EventIngestResultItem } from "@mega-crm/shared-schemas";
import { apiKeyAuth } from "../api-keys/api-key-auth.js";
import { eventsIngestQueue } from "./events-queue.js";

/**
 * EVNT-01/EVNT-03: API-key-authed event ingestion. This route ONLY
 * authenticates (onRequest: apiKeyAuth) and shape-validates the envelope
 * before enqueueing -- the contact upsert (EVNT-02) + event-row write
 * happen asynchronously in apps/worker's events-ingest.worker.ts. NEVER
 * perform the upsert/insert here (D-24 Anti-Pattern: a 2xx here means
 * "validated and queued", not "processed").
 *
 * Per-item validation (not a single whole-batch schema): D-24's per-element
 * acceptance status means one malformed item in a batch must not reject the
 * rest -- each item independently resolves to {status: "accepted"} or
 * {status: "rejected", error}. Only the top-level batch SIZE (<= 1000) is
 * checked before per-item parsing.
 */
export async function registerEventsApiRoutes(fastify: FastifyInstance): Promise<void> {
  await fastify.register(async (scope) => {
    // onRequest (not preHandler): must run BEFORE Fastify parses the body
    // (Pitfall 3) -- this route can receive a batch of up to 1000 events.
    scope.addHook("onRequest", apiKeyAuth);

    scope.post(
      "/v1/events",
      {
        // T-02-06-01: rate-limit + a bounded body size on this
        // unauthenticated-until-key-checked, high-volume surface.
        config: { rateLimit: { max: 100, timeWindow: "1 minute" } },
        bodyLimit: 5 * 1024 * 1024,
      },
      async (request, reply) => {
        // T-02-06-04: workspace resolved SOLELY from the verified API key --
        // apiKeyAuth already ran on onRequest and either set this or replied
        // 401 before this handler could ever run.
        const workspaceId = request.apiKeyWorkspaceId as string;

        const rawBody = request.body;
        const rawItems = Array.isArray(rawBody) ? rawBody : [rawBody];

        if (rawItems.length === 0 || rawItems.length > MAX_EVENT_BATCH_SIZE) {
          return reply.code(422).send({
            error: `Batch size must be between 1 and ${MAX_EVENT_BATCH_SIZE} events`,
          });
        }

        // Resolved ONCE, before per-item enqueue, so every item lacking a
        // client-supplied occurredAt shares one deterministic ingestion
        // timestamp -- never a bare `now()` evaluated later inside the
        // worker, which would differ on redelivery and defeat Pitfall 1's
        // idempotency guarantee.
        const ingestedAt = new Date().toISOString();

        const results: EventIngestResultItem[] = await Promise.all(
          rawItems.map(async (rawItem): Promise<EventIngestResultItem> => {
            const parsed = eventEnvelopeSchema.safeParse(rawItem);
            if (!parsed.success) {
              const clientEventId =
                typeof rawItem === "object" && rawItem !== null && "eventId" in rawItem
                  ? (rawItem as { eventId?: unknown }).eventId
                  : undefined;
              return {
                eventId: typeof clientEventId === "string" ? clientEventId : undefined,
                status: "rejected",
                error: parsed.error.issues[0]?.message ?? "Invalid event",
              };
            }

            const item = parsed.data;
            // RESEARCH Open Question 2: an OPTIONAL client-supplied eventId
            // is honored (dedupes the tenant's own retried HTTP POSTs);
            // otherwise a server-generated UUID is minted NOW, before
            // enqueue -- this IS the idempotency key (Pattern 2 / Pitfall 1).
            const eventId = item.eventId ?? randomUUID();
            const occurredAt = item.occurredAt ?? ingestedAt;

            await eventsIngestQueue.add(
              "ingest-event",
              {
                workspaceId,
                eventId,
                occurredAt,
                name: item.name,
                properties: item.properties,
                externalId: item.externalId,
                email: item.email,
              },
              { jobId: eventId }
            );

            return { eventId, status: "accepted" };
          })
        );

        return reply.code(202).send({ results });
      }
    );
  });
}
