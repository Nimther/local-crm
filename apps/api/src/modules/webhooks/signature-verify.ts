import { EventWebhook } from "@sendgrid/eventwebhook";

/**
 * Thin, pure wrapper around `@sendgrid/eventwebhook`'s ECDSA verification
 * (WBHK-01, RESEARCH.md "Don't Hand-Roll"). Never hand-rolls ASN.1/ECDSA
 * parsing -- SendGrid's public key format requires a specific DER-wrapping
 * step (`convertPublicKeyToECDSA`) before Node's `crypto` module will
 * accept it, and `@sendgrid/eventwebhook` already implements this
 * correctly. Mirrors `verifyUnsubscribeToken`'s "pure verify function"
 * role: given bad/malformed inputs, returns `false` rather than throwing --
 * the caller (webhooks.routes.ts) treats any falsy result identically as
 * "invalid signature, fail closed", never distinguishing a malformed key
 * from a genuinely wrong signature (no information to leak either way).
 */
export function verifyWebhookSignature(
  publicKey: string,
  rawBody: Buffer,
  signature: string | undefined,
  timestamp: string | undefined
): boolean {
  if (!signature || !timestamp) {
    return false;
  }
  try {
    const eventWebhook = new EventWebhook();
    const ecPublicKey = eventWebhook.convertPublicKeyToECDSA(publicKey);
    return eventWebhook.verifySignature(ecPublicKey, rawBody, signature, timestamp);
  } catch {
    // A malformed publicKey/signature/timestamp throws inside the
    // underlying ecdsa library rather than returning false -- normalize to
    // the same fail-closed `false` result so the route never has to
    // special-case a thrown error vs. a returned false.
    return false;
  }
}

/**
 * Default replay/staleness window, in seconds (SEC-07, 10-11): SendGrid's
 * `x-twilio-email-event-webhook-timestamp` header must be within this many
 * seconds of "now", in EITHER direction, or the delivery is rejected
 * exactly like a bad signature. Ten minutes is a wide tolerance for
 * provider-to-host clock skew (T-10-11-05, accepted) while still bounding
 * how long a captured, correctly-signed delivery can be replayed.
 * Overridable via `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` (env.ts) --
 * `webhooks.routes.ts` passes that value in; this constant is only the
 * schema-level default.
 */
export const DEFAULT_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 600;

/**
 * Pure freshness predicate (SEC-07, 10-11) -- deliberately separate from
 * `verifyWebhookSignature` above, not folded into it: keeping
 * `verifyWebhookSignature` an unmodified thin wrapper over the vendor
 * library is what makes it safe to leave alone, and the route composes
 * both results itself (RESEARCH.md Pitfall 6 -- this bounds ONLY the
 * signature header's timestamp, never each event's own `timestamp` field
 * inside the batch body; that is Phase 13's CMP-05).
 *
 * Reads no environment variable itself (`toleranceSeconds` is the caller's
 * job to resolve, from `env.ts`) so it stays pure and directly
 * unit-testable. Mirrors `verifyWebhookSignature`'s fail-closed posture:
 * malformed/missing input returns `false`, never throws, and the caller
 * never learns WHY it failed.
 */
export function isWebhookTimestampFresh(
  timestamp: string | undefined,
  toleranceSeconds: number,
  now: number = Date.now()
): boolean {
  if (!timestamp) {
    return false;
  }
  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    return false;
  }
  const nowSeconds = now / 1000;
  const ageSeconds = Math.abs(nowSeconds - timestampSeconds);
  return ageSeconds <= toleranceSeconds;
}
