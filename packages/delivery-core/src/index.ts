export {
  signUnsubscribeToken,
  verifyUnsubscribeToken,
  buildListUnsubscribeUrl,
  type UnsubscribeTokenPayload,
} from "./unsubscribe-token.js";

export {
  buildMailSendRequest,
  sendTenantMailV3,
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
  tryCompleteCampaign,
  claimFlowSend,
  recordFlowStepResult,
  recordFlowExcluded,
  type DispatchSendGateResult,
  type AudienceExclusionBreakdown,
} from "./send-ledger.js";

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
  isValidIanaTimezone,
  resolveTimezone,
  isInsideQuietHours,
  nextQuietWindowEnd,
  type QuietHoursWindow,
} from "./quiet-hours.js";
