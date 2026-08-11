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
 * Phase 5 webhook-processing queue (WBHK-01/02/03): its own dedicated lane,
 * not folded into events-ingest/email-broadcast/email-triggered -- a
 * structurally distinct concern (delivery events vs. contact events vs.
 * sends) with different downstream side effects (suppression/status vs.
 * segment/flow triggers vs. mail dispatch), per CLAUDE.md's queue-isolation
 * guidance and RESEARCH.md's Alternatives Considered.
 */
export const WEBHOOK_EVENTS_QUEUE = "webhook-events";

/**
 * Phase 6 flow-engine queues (FLOW-01..07): four dedicated lanes, hyphen
 * separators (BullMQ rejects colons, see comment above). `FLOW_TRIGGER_EVALUATOR_QUEUE`
 * evaluates an event/contact-change against live flows' event/segment
 * triggers; `FLOW_RUN_ADVANCE_QUEUE` advances one flow_run one step at a
 * time (delay/branch/send); `FLOW_RECONCILIATION_QUEUE` is the repeatable
 * backstop scan for due delay/wait-until wakes (mirrors
 * campaign-scheduler.worker.ts's pattern); `FLOW_SEGMENT_SWEEP_QUEUE` is the
 * repeatable periodic re-check for segment-trigger/time-based exit
 * conditions (D-02) that no single event can drive.
 */
export const FLOW_TRIGGER_EVALUATOR_QUEUE = "flow-trigger-evaluator";
export const FLOW_RUN_ADVANCE_QUEUE = "flow-run-advance";
export const FLOW_RECONCILIATION_QUEUE = "flow-reconciliation";
export const FLOW_SEGMENT_SWEEP_QUEUE = "flow-segment-sweep";
/**
 * Phase 12 (WRK-05/WRK-06, D-09, plan 12-06): the bounded per-flow walk
 * `FLOW_SEGMENT_SWEEP_QUEUE`'s discovery tick now fans out to -- one job per
 * live segment-triggered flow, mirroring `campaign-scheduler` →
 * `campaign-kickoff`'s split. Its own dedicated lane, not folded back into
 * `FLOW_SEGMENT_SWEEP_QUEUE`: discovery is a cross-tenant admin-scan tick,
 * the walk is a per-tenant, potentially-multi-page job -- the same
 * structurally-different-concern reasoning `FLOW_ENROLL_EXISTING_QUEUE`'s
 * own comment gives for not folding it into this queue either.
 */
export const FLOW_SEGMENT_SWEEP_FLOW_QUEUE = "flow-segment-sweep-flow";
/**
 * 06-08/D-04: the publish route's "enroll existing segment members" choice
 * enqueues one of these -- its own dedicated lane (not folded into
 * FLOW_SEGMENT_SWEEP_QUEUE, a structurally different concern: a one-shot
 * resumable batch fired once per publish, not a repeatable periodic scan).
 */
export const FLOW_ENROLL_EXISTING_QUEUE = "flow-enroll-existing";

/**
 * Phase 11 (DLV-03, plan 11-03) reconciler tick queue: its own dedicated
 * lane, not folded into any existing tick queue. A periodic cross-tenant
 * classification scan (discovery via `withCrossWorkspaceScan`, then a
 * per-tenant `FOR UPDATE SKIP LOCKED` claim) is a structurally different
 * concern from send dispatch (`email-broadcast`/`email-triggered`), webhook
 * ingestion (`webhook-events`), or flow advancement (`flow-run-advance`/
 * `flow-reconciliation`) -- it never dispatches mail, it only classifies
 * already-committed `sends` rows from webhook evidence already on disk.
 */
export const SEND_RECONCILER_QUEUE = "send-reconciler";

/**
 * Phase 11 (R-05, ROADMAP § Sequencing Decisions) deploy-safety contract:
 * this is the FIRST job payload in the codebase to carry an explicit
 * `schemaVersion`. A rolling deploy can have an old-code worker process
 * still draining jobs enqueued by new code (or vice versa) for the seconds/
 * minutes a rollout takes -- without a version field, a worker has no way to
 * tell "this payload's shape predates/postdates what I know how to process"
 * from "this payload's shape is what I expect". `createSendReconcilerWorker`
 * validates every job against `sendReconcilerTickJobSchema` and DEFERS
 * (logs, returns, never throws) a `schemaVersion` it does not recognize,
 * rather than best-effort-processing a payload shape it was not built for.
 * Phase 12/14 extend this same convention to the pre-existing payloads above
 * (`emailBroadcastJobSchema`, `webhookEventsJobSchema`, etc.), which do not
 * carry a `schemaVersion` yet.
 */
export const SEND_RECONCILER_TICK_SCHEMA_VERSION = 1;

export const sendReconcilerTickJobSchema = z.object({
  schemaVersion: z.literal(SEND_RECONCILER_TICK_SCHEMA_VERSION),
});
export type SendReconcilerTickJob = z.infer<typeof sendReconcilerTickJobSchema>;

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
 * email-triggered job payload (SEND-03, widened in 06-02 for Phase 6 flows):
 * a discriminated union on `kind` -- the `campaign`/`test` variants mirror
 * emailBroadcastJobSchema's shape exactly (a triggered send can still be a
 * one-off campaign test-send routed onto the always-on lane), and the new
 * `flow` variant carries `flowRunId`/`nodeId`/`contactId` instead of
 * `campaignId` -- a flow-step send has no campaign at all. Unlike the flat
 * shape this replaces, `campaignId` is no longer required for every kind;
 * `processSendJob` (apps/worker/src/queues/send-dispatch.ts) branches on
 * `kind` before touching any kind-specific field (T-06-02-01 type seam --
 * the `kind === "flow"` dispatch branch itself lands in 06-05).
 */
export const emailTriggeredJobSchema = z.discriminatedUnion("kind", [
  z.object({
    workspaceId: z.string().uuid(),
    kind: z.literal("campaign"),
    campaignId: z.string().uuid(),
    contactId: z.string().uuid(),
  }),
  z.object({
    workspaceId: z.string().uuid(),
    kind: z.literal("test"),
    campaignId: z.string().uuid(),
    testTo: z.string().email(),
    testData: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    workspaceId: z.string().uuid(),
    kind: z.literal("flow"),
    flowRunId: z.string().uuid(),
    nodeId: z.string(),
    contactId: z.string().uuid(),
  }),
]);
export type EmailTriggeredJob = z.infer<typeof emailTriggeredJobSchema>;

/**
 * flow-run-advance job payload: the flow engine's own per-run "tick" --
 * `flowRunId` is the sole pointer, mirroring campaign-kickoff's
 * re-derive-everything-from-the-row convention (the worker re-reads
 * flow_runs/flow_versions for current_node_id, delay state, etc.).
 */
export const flowRunAdvanceJobSchema = z.object({
  workspaceId: z.string().uuid(),
  flowRunId: z.string().uuid(),
});
export type FlowRunAdvanceJob = z.infer<typeof flowRunAdvanceJobSchema>;

/**
 * flow-trigger-check job payload: enqueued after an event is ingested (or a
 * contact is updated) so the flow-trigger-evaluator worker can check live
 * flows' event/segment triggers for this one contact. `eventName` is
 * present for an event-driven check and absent for a contact-change-driven
 * segment re-check (D-02's event-driven half of the hybrid).
 */
export const flowTriggerCheckJobSchema = z.object({
  workspaceId: z.string().uuid(),
  contactId: z.string().uuid(),
  eventName: z.string().min(1).optional(),
});
export type FlowTriggerCheckJob = z.infer<typeof flowTriggerCheckJobSchema>;

/**
 * flow-enroll-existing job payload (D-04): the publish route enqueues ONE of
 * these for every segment-triggered flow's publish -- `flowId`/`flowVersionId`
 * are re-derive-everything-from-the-row pointers (mirrors campaign-kickoff's
 * convention: the worker re-reads the flow's current trigger_segment_id/
 * reentry settings from `flows`, and resolves the entry node from
 * `flowVersionId`'s pinned definition). `enrollExisting` carries the D-04
 * choice itself: `true` creates a run for every current segment member
 * (subject to canEnterFlow); `false` marks them "seen" in the membership
 * snapshot WITHOUT creating any run, so only future entrants enroll.
 */
export const flowEnrollExistingJobSchema = z.object({
  workspaceId: z.string().uuid(),
  flowId: z.string().uuid(),
  flowVersionId: z.string().uuid(),
  enrollExisting: z.boolean(),
});
export type FlowEnrollExistingJob = z.infer<typeof flowEnrollExistingJobSchema>;

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

/**
 * webhook-events job payload (WBHK-01/03): mirrors events-ingest's Pattern 2
 * contract -- `workspaceId` is re-derived from this payload inside the
 * worker (never ambient state), resolved by the route via
 * `findWebhookEndpointByToken(pathToken)` BEFORE the payload itself is
 * trusted (RESEARCH.md Architecture Patterns #1: unverified payload data
 * must never select which signing key to verify against). `events` carries
 * the ENTIRE verified SendGrid batch (5-50 raw events per POST) as one job
 * -- ack-fast, whole-batch enqueue (RESEARCH.md Pattern 2), not one job per
 * event. Each element is `z.unknown()` because this plan only stores raw
 * event rows (dedup-only slice, WBHK-03) -- normalized field extraction
 * happens inside the worker, not at the schema boundary, since SendGrid's
 * per-event-type shape varies (05-03 adds normalization/side effects).
 *
 * Phase 13 (CMP-08, D-05, R-05, plan 13-01) widens this shape with two
 * OPTIONAL fields, both optional by design and not by omission:
 * `schemaVersion` and `journalId`. A job enqueued by pre-Phase-13 code
 * carries NEITHER field, and per ROADMAP R-05's backward-compatible-payload
 * intent such a job must still be processed to completion -- an absent
 * `schemaVersion` means the pre-versioned shape, and is processed WITHOUT
 * the journal completion mark (there is no journal row to mark). An
 * unrecognized NON-ABSENT version (e.g. `2` once this schema's literal only
 * names `1`) is deferred the same way `sendReconcilerTickJobSchema`
 * consumers defer: logged and returned, never thrown into BullMQ retries.
 * `journalId` is the `ingress_journal` row id `enqueueWebhookBatch` was
 * handed after `writeIngressJournal` committed -- the worker's sole handle
 * to close the loop via `markIngestionComplete`.
 */
export const WEBHOOK_EVENTS_SCHEMA_VERSION = 1;

export const webhookEventsJobSchema = z.object({
  workspaceId: z.string().uuid(),
  events: z.array(z.unknown()),
  schemaVersion: z.literal(WEBHOOK_EVENTS_SCHEMA_VERSION).optional(),
  journalId: z.string().uuid().optional(),
});
export type WebhookEventsJob = z.infer<typeof webhookEventsJobSchema>;

/**
 * Pure payload constructor shared by BOTH producers of `WEBHOOK_EVENTS_QUEUE`
 * -- `enqueueWebhookBatch` (apps/api, this plan) and plan 13-06's replay
 * sweep (apps/worker) -- so the two cannot drift on job shape while neither
 * app imports the other (the phase-wide `apps/api` <-> `apps/worker` import
 * boundary decision, 13-01-PLAN.md's "Cross-app shared-module placement").
 * `journalId` is optional here too: the replay sweep's own re-enqueue MAY
 * omit it for a row it cannot resolve, and a caller that never journaled a
 * batch (should not happen post-13-01, but this constructor makes no
 * assumption about its caller) can still build a valid legacy-shaped payload.
 */
export function buildWebhookEventsJobPayload(
  workspaceId: string,
  events: unknown[],
  journalId?: string
): WebhookEventsJob {
  return {
    workspaceId,
    events,
    schemaVersion: WEBHOOK_EVENTS_SCHEMA_VERSION,
    ...(journalId !== undefined ? { journalId } : {}),
  };
}

/**
 * Phase 12 (WRK-05/WRK-06, D-09, R-05, plan 12-06): the segment-sweep
 * discovery/walk pair's own `schemaVersion` payloads -- the SAME deploy-safety
 * contract `sendReconcilerTickJobSchema` established (Phase 11): a rolling
 * deploy can have an old-code worker still draining jobs enqueued by new
 * code (or vice versa), so every changed BullMQ job payload in this
 * codebase now carries an explicit version a worker validates before acting
 * on it, deferring (never throwing) an unrecognized one.
 *
 * `flowSegmentSweepTickJobSchema` (`FLOW_SEGMENT_SWEEP_QUEUE`'s own
 * discovery tick) carries only the version -- discovery needs no other
 * data, it re-derives everything by scanning `flows` itself.
 * `flowSegmentSweepFlowJobSchema` (`FLOW_SEGMENT_SWEEP_FLOW_QUEUE`, the
 * per-flow bounded walk) additionally carries `workspaceId`/`flowId` --
 * mirrors `campaignKickoffJobSchema`'s re-derive-everything-from-the-row
 * convention, the walk re-reads the flow's current trigger_segment_id/
 * reentry settings itself rather than trusting a stale copy in the payload.
 */
export const FLOW_SEGMENT_SWEEP_TICK_SCHEMA_VERSION = 1;
export const flowSegmentSweepTickJobSchema = z.object({
  schemaVersion: z.literal(FLOW_SEGMENT_SWEEP_TICK_SCHEMA_VERSION),
});
export type FlowSegmentSweepTickJob = z.infer<typeof flowSegmentSweepTickJobSchema>;

export const FLOW_SEGMENT_SWEEP_FLOW_SCHEMA_VERSION = 1;
export const flowSegmentSweepFlowJobSchema = z.object({
  schemaVersion: z.literal(FLOW_SEGMENT_SWEEP_FLOW_SCHEMA_VERSION),
  workspaceId: z.string().uuid(),
  flowId: z.string().uuid(),
});
export type FlowSegmentSweepFlowJob = z.infer<typeof flowSegmentSweepFlowJobSchema>;

/**
 * Phase 13 (CMP-08, D-05, D-06, R-05, plan 13-06): the webhook-replay-sweep
 * tick's own `schemaVersion` payload -- mirrors `sendReconcilerTickJobSchema`'s
 * shape and doc comment exactly (Phase 11): a rolling deploy can have an
 * old-code worker still draining jobs enqueued by new code (or vice versa),
 * so this tick's payload carries an explicit version a worker validates
 * before acting on it. `createWebhookReplaySweepWorker`'s processor DEFERS
 * (logs via `scrubbedConsole`, returns without processing) a `schemaVersion`
 * it does not recognize, rather than throwing it into BullMQ retries -- a
 * deferred tick never consumes one of the job's `attempts`, and the next
 * scheduled tick (or the next boot) simply tries again.
 */
export const WEBHOOK_REPLAY_SWEEP_TICK_SCHEMA_VERSION = 1;
export const webhookReplaySweepTickJobSchema = z.object({
  schemaVersion: z.literal(WEBHOOK_REPLAY_SWEEP_TICK_SCHEMA_VERSION),
});
export type WebhookReplaySweepTickJob = z.infer<typeof webhookReplaySweepTickJobSchema>;

/**
 * Phase 13 (CMP-09, D-09 through D-12, R-05, plan 13-09): the reputation
 * tick's own `schemaVersion` payload -- mirrors `sendReconcilerTickJobSchema`'s
 * shape and doc comment exactly (Phase 11): a rolling deploy can have an
 * old-code worker still draining jobs enqueued by new code (or vice versa),
 * so this tick's payload carries an explicit version a worker validates
 * before acting on it. `createReputationTickWorker`'s processor DEFERS
 * (logs via `scrubbedConsole`, returns without processing) a `schemaVersion`
 * it does not recognize, rather than throwing it into BullMQ retries -- a
 * deferred tick never consumes one of the job's `attempts`, and the next
 * scheduled tick (or the next boot) simply tries again.
 */
export const REPUTATION_TICK_SCHEMA_VERSION = 1;
export const reputationTickJobSchema = z.object({
  schemaVersion: z.literal(REPUTATION_TICK_SCHEMA_VERSION),
});
export type ReputationTickJob = z.infer<typeof reputationTickJobSchema>;

/**
 * Phase 13 (CMP-04, D-01/D-04, plan 13-10): the erasure-scrub job's queue
 * contract. Its own dedicated lane, not folded into any existing queue --
 * this is a background PII-scrub walk over `sends`/`send_events`/`events`
 * (plan 13-13), a structurally different concern from send dispatch,
 * webhook ingestion, or flow advancement. Defined here rather than in
 * plan 13-13 because THIS plan is the producer (`deleteContact`,
 * `apps/api`) and this wave owns the schema file; 13-13 implements the
 * consumer, and plan 13-15's reclaimer is the SECOND producer.
 *
 * `erasureRecordId` is the sole pointer this job needs -- the worker
 * re-reads the `erasure_records` row for its current status/cursors
 * (re-derive-everything-from-the-row, the same convention
 * `campaignKickoffJobSchema`/`flowRunAdvanceJobSchema` use).
 * `workspaceId`/`contactId` are carried too so the worker never has to
 * open an admin-scan connection just to discover which tenant this job
 * belongs to (Pattern 2: never trust ambient state).
 */
export const ERASURE_SCRUB_QUEUE = "erasure-scrub";
export const ERASURE_SCRUB_SCHEMA_VERSION = 1;

export const erasureScrubJobSchema = z.object({
  schemaVersion: z.literal(ERASURE_SCRUB_SCHEMA_VERSION),
  workspaceId: z.string().uuid(),
  contactId: z.string().uuid(),
  erasureRecordId: z.string().uuid(),
});
export type ErasureScrubJob = z.infer<typeof erasureScrubJobSchema>;

/**
 * Pure payload constructor -- mirrors `buildWebhookEventsJobPayload`'s own
 * precedent (plan 13-01) for the identical two-producers-one-consumer
 * shape: this plan's `deleteContact` and plan 13-15's reclaimer BOTH build
 * this payload, so a single exported constructor is what keeps them from
 * drifting on job shape while neither imports the other's app.
 */
export function buildErasureScrubJobPayload(
  workspaceId: string,
  contactId: string,
  erasureRecordId: string
): ErasureScrubJob {
  return {
    schemaVersion: ERASURE_SCRUB_SCHEMA_VERSION,
    workspaceId,
    contactId,
    erasureRecordId,
  };
}

/**
 * Deterministic BullMQ `jobId`, derived from the erasure record's own id
 * (mirrors `eventsIngestJobSchema`'s `eventId`-as-`jobId` convention: the
 * work's own durable identifier, not a caller-invented string). There are
 * TWO producers of this job -- this plan's `deleteContact` request path,
 * and plan 13-15's reclaimer re-enqueueing a stranded `pending` record --
 * and BOTH must derive the SAME id from the SAME erasure-record id, or a
 * reclaim of an already-queued record would queue a second scrub. Exported
 * from here (not computed inline at either call site) so that can never
 * happen. NOTE for readers: BullMQ's own `jobId` deduplication is a
 * best-effort layer, not the authoritative one -- once a completed job
 * ages out of Redis (`STANDARD_JOB_RETENTION`), the same id can be
 * enqueued again. The authoritative idempotency is plan 13-13's own
 * already-complete check on the `erasure_records` row, which holds
 * regardless of Redis state.
 */
export function buildErasureScrubJobId(erasureRecordId: string): string {
  return erasureRecordId;
}

/**
 * Phase 13 (CMP-04, D-04, plan 13-10): the `workspace_suppressions.reason`
 * value written by an erasure. Exported as a shared constant, not an
 * inline string literal, because THREE plans depend on this exact value --
 * this one writes it, plan 13-12 rewrites the row it lives on when the
 * suppression column becomes a hash, and the erasure re-import tests
 * assert on it -- and a string literal repeated across three plans is how
 * they silently drift. Distinct from the reasons a genuine unsubscribe or
 * a provider suppression writes, which is what keeps "asked to leave" from
 * being conflated with "asked to be forgotten" in consent history.
 */
export const SUPPRESSION_REASON_CONTACT_DELETED = "contact_deleted";
