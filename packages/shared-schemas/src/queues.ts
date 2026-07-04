import { z } from "zod";

/**
 * Queue name constants shared by producer (apps/api) and consumer
 * (apps/worker) so neither side can drift on the literal string BullMQ uses
 * to route jobs. Two separate queues (not one queue + job `priority`) so a
 * flooded broadcast queue can never starve triggered sends — see
 * STACK.md's Queue & Send Pipeline rationale.
 */
// BullMQ rejects queue names containing ":" (it reserves the colon as its
// own Redis-key separator -- see QueueBase's own validation, confirmed
// against bullmq@5.79.1) -- these use "-" instead of the "events:ingest"/
// "imports:csv" notation used in prose/comments elsewhere in this project.
export const EVENTS_INGEST_QUEUE = "events-ingest";
export const IMPORTS_CSV_QUEUE = "imports-csv";

/**
 * events:ingest job payload (EVNT-02/EVNT-03, finalized in 02-06): the
 * SOLE context the worker trusts (Pattern 2) -- `workspaceId` is re-derived
 * from this payload inside the worker (never ambient state), `eventId` is
 * the deterministic idempotency key (BullMQ jobId AND the `events` table's
 * primary-key component), and `occurredAt` is resolved ONCE at ingestion
 * time (apps/api's /v1/events route, before enqueue) so it stays identical
 * across BullMQ redeliveries -- required for `ON CONFLICT (id, occurred_at)
 * DO NOTHING` (Pitfall 1) to actually dedupe.
 */
export const eventsIngestJobSchema = z.object({
  workspaceId: z.string().uuid(),
  eventId: z.string().uuid(),
  occurredAt: z.string().datetime(),
  name: z.string().min(1),
  properties: z.record(z.string(), z.unknown()),
  externalId: z.string().optional(),
  email: z.string().optional(),
});
export type EventsIngestJob = z.infer<typeof eventsIngestJobSchema>;

export const importsCsvJobSchema = z.object({
  workspaceId: z.string().uuid(),
});
export type ImportsCsvJob = z.infer<typeof importsCsvJobSchema>;
