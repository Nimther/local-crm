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
 * Phase 4 send-pipeline queues (SEND-03): two logically separate queues (not
 * one queue + job `priority`) so a flooded broadcast queue can never starve
 * triggered sends -- see STACK.md's Queue & Send Pipeline rationale.
 * `CAMPAIGN_KICKOFF_QUEUE` is the due-campaign scheduler's own lane, decoupled
 * from the per-recipient broadcast fan-out queue.
 */
export const EMAIL_BROADCAST_QUEUE = "email-broadcast";
export const EMAIL_TRIGGERED_QUEUE = "email-triggered";
export const CAMPAIGN_KICKOFF_QUEUE = "campaign-kickoff";

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

/**
 * imports:csv job payload (CONT-02, finalized in 02-07): mirrors
 * events:ingest's Pattern 2 contract exactly -- `workspaceId` is re-derived
 * from this payload inside the worker (never ambient state), and
 * `csvImportId` is the sole pointer into the already-staged
 * `csv_import_rows` table (the worker re-reads persisted rows rather than
 * re-parsing the original upload, since apps/worker is a separate process
 * with no access to the request's file stream -- see 02-07-PLAN.md's
 * "Decision surfaced"). Idempotency under BullMQ's at-least-once redelivery
 * is achieved via each row's own persisted `status` (Pitfall 1), not via
 * `jobId` alone -- a single import's apply job may itself be long-running
 * (100k+ rows) and is safe to redeliver in full.
 */
export const importsCsvJobSchema = z.object({
  workspaceId: z.string().uuid(),
  csvImportId: z.string().uuid(),
});
export type ImportsCsvJob = z.infer<typeof importsCsvJobSchema>;

/**
 * email-broadcast job payload (SEND-01/SEND-06, RESEARCH.md Pitfall 1):
 * mirrors events-ingest's Pattern 2 contract -- `workspaceId` is always
 * included and re-derived inside the worker (never ambient state, the single
 * most load-bearing convention for worker jobs in this codebase).
 * `kind: "test"` test-sends still go through this same queue (tagged, not a
 * separate path) so the send pipeline has exactly one code path; `contactId`
 * is required for `kind: "campaign"` and absent for `kind: "test"`, which
 * instead carries `testTo`/`testData`.
 */
export const emailBroadcastJobSchema = z.object({
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  kind: z.enum(["campaign", "test"]),
  contactId: z.string().uuid().optional(),
  testTo: z.string().email().optional(),
  testData: z.record(z.string(), z.unknown()).optional(),
});
export type EmailBroadcastJob = z.infer<typeof emailBroadcastJobSchema>;

/**
 * email-triggered job payload (SEND-03): registered now so the reserved
 * priority lane exists ahead of its first real producer (Phase 6 flows);
 * mirrors emailBroadcastJobSchema's shape.
 */
export const emailTriggeredJobSchema = z.object({
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  kind: z.enum(["campaign", "test"]),
  contactId: z.string().uuid().optional(),
  testTo: z.string().email().optional(),
  testData: z.record(z.string(), z.unknown()).optional(),
});
export type EmailTriggeredJob = z.infer<typeof emailTriggeredJobSchema>;

/**
 * campaign-kickoff job payload: the due-campaign scheduler enqueues one of
 * these per campaign whose scheduled_at has elapsed; the kickoff worker
 * re-derives everything else (recipients, template, sender) from the
 * campaign row itself.
 */
export const campaignKickoffJobSchema = z.object({
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
});
export type CampaignKickoffJob = z.infer<typeof campaignKickoffJobSchema>;
