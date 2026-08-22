import { z } from "zod";
import { subscriptionStatusSchema } from "./contact.js";

/**
 * Phase 21 (DSR-01..04, D-05/D-06/D-07): the per-contact DSR export
 * document. This plan (21-01) establishes ONLY `metadata`, `profile` and
 * `customProperties` -- the Growth rule in 21-01-PLAN.md's
 * `<document_contract>` requires every later section (`consentHistory`,
 * `events`, `sends`, `flowParticipation`, `campaignMemberships`) to be
 * ADDED here by the plan that implements its walk, never pre-declared as an
 * empty placeholder.
 */
export const DSR_EXPORT_FORMAT_VERSION = "1.0";

/**
 * D-06: full provenance, no requester identity. `sectionRowCounts` is an
 * open-ended integer map so later plans can add a key per section without
 * a schema-shape change here.
 */
export const dsrExportMetadataSchema = z.object({
  generatedAt: z.string(),
  exportFormatVersion: z.string(),
  allowlistName: z.string(),
  allowlistVersion: z.string(),
  workspace: z.object({
    id: z.string(),
    name: z.string(),
  }),
  contact: z.object({
    id: z.string(),
  }),
  sectionRowCounts: z.record(z.string(), z.number().int()),
});
export type DsrExportMetadata = z.infer<typeof dsrExportMetadataSchema>;

/**
 * D-07: camelCase, mirrors `contactResponseSchema`'s field naming --
 * deliberately NOT re-exporting `contactResponseSchema` itself, since the
 * export profile excludes `workspaceId` (already carried in `metadata`).
 */
export const dsrExportProfileSchema = z.object({
  id: z.string(),
  externalId: z.string().nullable(),
  email: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  phone: z.string().nullable(),
  city: z.string().nullable(),
  country: z.string().nullable(),
  timezone: z.string().nullable(),
  tags: z.array(z.string()),
  subscriptionStatus: subscriptionStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DsrExportProfile = z.infer<typeof dsrExportProfileSchema>;

/**
 * Phase 21 plan 03 (DSR-01): one `subscription_status_history` row, exactly
 * as `selectConsentHistoryPage` reads it in `dsr-export.repository.ts`.
 * `oldStatus`/`reason` are nullable because the underlying columns are
 * (a first-ever history row can have no prior status; not every source
 * records a reason).
 */
export const dsrExportConsentHistoryEntrySchema = z.object({
  id: z.string(),
  oldStatus: z.string().nullable(),
  newStatus: z.string(),
  source: z.string(),
  reason: z.string().nullable(),
  changedAt: z.string(),
});
export type DsrExportConsentHistoryEntry = z.infer<typeof dsrExportConsentHistoryEntrySchema>;

/**
 * Phase 21 plan 03 (DSR-02, D-01): one `events` row -- deliberately no
 * `properties` field. The repository's `selectEventsPage` never selects
 * that column at all, so there is no value here to omit; the schema simply
 * has no key for it.
 */
export const dsrExportEventSchema = z.object({
  id: z.string(),
  name: z.string(),
  occurredAt: z.string(),
  receivedAt: z.string(),
});
export type DsrExportEvent = z.infer<typeof dsrExportEventSchema>;

/**
 * Phase 21 plan 05 (DSR-02, DSR-03): one `send_events` row nested under its
 * parent send, exactly as `selectSendEventsPage` reads it in
 * `dsr-export.repository.ts` -- `sendId` is deliberately NOT a field here
 * (the nesting already carries it via the parent `sends` array entry).
 * `payload` is a free-form record because `buildExportSendEventPayload` has
 * already bounded it to `SEND_EVENT_PAYLOAD_EXPORT_ALLOWLIST` by the time it
 * reaches this shape -- the schema itself does not re-enforce that bound
 * (the allowlist function is the single place that does).
 */
export const dsrExportSendEventSchema = z.object({
  id: z.string(),
  sgEventId: z.string(),
  eventType: z.string(),
  reason: z.string().nullable(),
  isTest: z.boolean(),
  occurredAt: z.string(),
  receivedAt: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
export type DsrExportSendEvent = z.infer<typeof dsrExportSendEventSchema>;

/**
 * Phase 21 plan 05 (DSR-02): one `sends` row, exactly as `selectSendsPage`
 * reads it in `dsr-export.repository.ts` -- deliberately excludes
 * `reconcilingSince`/`dispatchDurationMs` (platform telemetry about the
 * dispatch attempt, not the subject's personal data, per
 * `docs/PII-INVENTORY.md`). `sendEvents` nests every provider event for
 * this send, oldest first.
 */
export const dsrExportSendSchema = z.object({
  id: z.string(),
  campaignId: z.string().nullable(),
  kind: z.string(),
  status: z.string(),
  exclusionReason: z.string().nullable(),
  providerMessageId: z.string().nullable(),
  queuedAt: z.string(),
  sentAt: z.string().nullable(),
  deliveredAt: z.string().nullable(),
  firstOpenedAt: z.string().nullable(),
  firstClickedAt: z.string().nullable(),
  bouncedAt: z.string().nullable(),
  droppedAt: z.string().nullable(),
  unsubscribedAt: z.string().nullable(),
  spamReportedAt: z.string().nullable(),
  bounceReason: z.string().nullable(),
  dropReason: z.string().nullable(),
  flowRunId: z.string().nullable(),
  nodeId: z.string().nullable(),
  openCount: z.number().int(),
  clickCount: z.number().int(),
  dispatchedAt: z.string().nullable(),
  sendEvents: z.array(dsrExportSendEventSchema),
});
export type DsrExportSend = z.infer<typeof dsrExportSendSchema>;

/**
 * Phase 21 plan 06 (DSR-02, D-04): one `flow_run_steps` row nested under its
 * parent run, exactly as `selectFlowRunStepsPage` reads it in
 * `dsr-export.repository.ts` -- `flowRunId` is deliberately NOT a field here
 * (the nesting already carries it via the parent `flowParticipation` array
 * entry).
 */
export const dsrExportFlowRunStepSchema = z.object({
  id: z.string(),
  nodeId: z.string(),
  nodeType: z.string(),
  outcome: z.string(),
  sendId: z.string().nullable(),
  createdAt: z.string(),
});
export type DsrExportFlowRunStep = z.infer<typeof dsrExportFlowRunStepSchema>;

/**
 * Phase 21 plan 06 (DSR-02, D-04): one `flow_runs` row, exactly as
 * `selectFlowRunsPage` reads it in `dsr-export.repository.ts` --
 * deliberately carries EVERY status (no filter narrows this to only the
 * active statuses `flow_runs_one_active_per_contact` covers), since
 * completed/exited/ejected runs are processing history under GDPR Art. 15
 * just as much as an in-flight one. `steps` nests every `flow_run_steps`
 * row for this run, oldest first.
 */
export const dsrExportFlowRunSchema = z.object({
  id: z.string(),
  flowId: z.string(),
  flowVersionId: z.string(),
  status: z.string(),
  currentNodeId: z.string().nullable(),
  enteredAt: z.string(),
  lastEntryAt: z.string(),
  exitedAt: z.string().nullable(),
  exitReason: z.string().nullable(),
  steps: z.array(dsrExportFlowRunStepSchema),
});
export type DsrExportFlowRun = z.infer<typeof dsrExportFlowRunSchema>;

/**
 * Phase 21 plan 06 (DSR-02, D-04): one `campaign_recipients` row, exactly as
 * `selectCampaignRecipientsPage` reads it in `dsr-export.repository.ts` --
 * which campaign targeted this contact and when the snapshot recorded it.
 */
export const dsrExportCampaignMembershipSchema = z.object({
  id: z.string(),
  campaignId: z.string(),
  createdAt: z.string(),
});
export type DsrExportCampaignMembership = z.infer<typeof dsrExportCampaignMembershipSchema>;

/** D-05: the document shape this plan establishes -- see the module doc comment for the Growth rule governing every later section. */
export const dsrExportDocumentSchema = z.object({
  metadata: dsrExportMetadataSchema,
  profile: dsrExportProfileSchema,
  customProperties: z.record(z.string(), z.unknown()),
  consentHistory: z.array(dsrExportConsentHistoryEntrySchema),
  events: z.array(dsrExportEventSchema),
  sends: z.array(dsrExportSendSchema),
  flowParticipation: z.array(dsrExportFlowRunSchema),
  campaignMemberships: z.array(dsrExportCampaignMembershipSchema),
});
export type DsrExportDocument = z.infer<typeof dsrExportDocumentSchema>;

/** D-13: the typed 410 body for an already-erased contact -- no document keys. */
export const dsrExportErasedBodySchema = z.object({
  code: z.literal("contact_erased"),
  erasedAt: z.string(),
  erasureRecordId: z.string().nullable(),
});
export type DsrExportErasedBody = z.infer<typeof dsrExportErasedBodySchema>;
