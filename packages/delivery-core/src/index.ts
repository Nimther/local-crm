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
  recordSendResult,
  recordExcluded,
  audienceExclusionBreakdown,
  type DispatchSendGateResult,
  type AudienceExclusionBreakdown,
} from "./send-ledger.js";

export {
  getWorkspaceSendSettings,
  upsertWorkspaceSendSettings,
  type WorkspaceSendSettings,
} from "./send-settings.js";
