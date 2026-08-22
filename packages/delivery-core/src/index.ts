export {
  signUnsubscribeToken,
  verifyUnsubscribeToken,
  buildListUnsubscribeUrl,
  type UnsubscribeTokenPayload,
} from "./unsubscribe-token.js";

export {
  buildMailSendRequest,
  sendTenantMailV3,
  SENDGRID_TIMEOUT_MS,
  type SendGridMailSendRequest,
  type BuildMailSendRequestParams,
  type SendTenantMailResult,
} from "./send-mail.js";

export {
  buildContactTemplateData,
  type ContactTemplateData,
  type ContactTemplateDataContact,
} from "./contact-template-data.js";

export {
  evaluatePreSendGate,
  type PreSendDecision,
  type PreSendSkipReason,
  type PreSendGateContact,
} from "./pre-send-gate.js";

export {
  dispatchSendGate,
  releaseDispatchClaim,
  recordSendResult,
  recordExcluded,
  audienceExclusionBreakdown,
  incrementCampaignSendCounter,
  backfillCampaignSendCounter,
  tryCompleteCampaign,
  claimFlowSend,
  recordFlowStepResult,
  recordFlowExcluded,
  resolveReconcilingSend,
  sweepStaleDispatchingSend,
  type DispatchSendGateResult,
  type AudienceExclusionBreakdown,
  type ResolveReconcilingResult,
  type ResolveReconcilingVerdict,
} from "./send-ledger.js";

export {
  classifyReconcilableSend,
  RECONCILE_RESOLUTION_WINDOW_MS,
  RECONCILE_RESCAN_HORIZON_MS,
  STALE_DISPATCHING_AGE_MS,
  type ReconcileVerdict,
  type ReconcileInput,
} from "./reconciler.js";

export {
  getWorkspaceSendSettings,
  upsertWorkspaceSendSettings,
  type WorkspaceSendSettings,
} from "./send-settings.js";

export { normalizeEventType, type NormalizedEventType } from "./event-normalize.js";

export {
  resolveSuppression,
  ADDRESS_DROP_REASONS,
  SOFT_BOUNCE_SUPPRESS_THRESHOLD,
  type SuppressionOutcome,
} from "./suppression-rules.js";

export { deriveCurrentStatus, type DeliveryFacts, type CurrentStatus } from "./send-status.js";

export {
  SEND_STATUSES,
  SEND_STATUS_TRANSITIONS,
  isAllowedTransition,
  writersFor,
  type SendStatus,
  type SendStatusWriter,
  type SendTransition,
} from "./send-state-machine.js";

export {
  isValidIanaTimezone,
  resolveTimezone,
  isInsideQuietHours,
  nextQuietWindowEnd,
  type QuietHoursWindow,
} from "./quiet-hours.js";

export { loadContactTimezone } from "./contact-timezone.js";

export { SEND_ID_NAMESPACE, deriveCampaignSendId, deriveFlowSendId } from "./send-id.js";

export { classifyTransportError, type TransportClassification } from "./transport-classify.js";

export {
  classifyOccurredAt,
  OCCURRED_AT_MAX_PAST_DAYS,
  OCCURRED_AT_MAX_FUTURE_SKEW_MINUTES,
  type OccurredAtVerdict,
} from "./occurred-at-bounds.js";

export {
  classifyReputationRate,
  REPUTATION_WINDOW_DAYS,
  REPUTATION_MIN_DELIVERED_FLOOR,
  COMPLAINT_RATE_WARN,
  COMPLAINT_RATE_CRITICAL,
  HARD_BOUNCE_RATE_WARN,
  HARD_BOUNCE_RATE_CRITICAL,
  type ReputationMetric,
  type ReputationTier,
  type ReputationObservation,
} from "./reputation-rates.js";

export {
  SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST,
  SEND_EVENT_PAYLOAD_EXPORT_ALLOWLIST,
  buildScrubbedSendEventPayload,
  buildExportSendEventPayload,
  buildScrubbedEventProperties,
  ERASURE_SCRUB_PAGE_LIMIT,
} from "./send-event-payload-allowlist.js";
