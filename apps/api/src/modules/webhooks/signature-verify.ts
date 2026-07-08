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
