import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Per-message unsubscribe token payload (SUBS-04, RESEARCH.md Pitfall 5 /
 * T-04-03-01). Binds the token to a *specific send* (`sendId`), not just the
 * contact, so a leaked/guessed token cannot be replayed for other sends and
 * is auditable back to the email that produced it. `exp` is a Unix-seconds
 * expiry -- `verifyUnsubscribeToken` does NOT itself reject an expired
 * token (it only proves the signature is intact); callers (the unsubscribe
 * route) compare `exp` against `now()` themselves, since "expired" and
 * "invalid signature" are both routed to the same generic response anyway
 * (T-04-03-02).
 */
export interface UnsubscribeTokenPayload {
  sendId: string;
  contactId: string;
  workspaceId: string;
  /** Unix seconds. */
  exp: number;
}

function getSecret(): string {
  const secret = process.env.UNSUBSCRIBE_TOKEN_SECRET;
  if (!secret) {
    throw new Error("UNSUBSCRIBE_TOKEN_SECRET is not set");
  }
  return secret;
}

function sign(encodedPayload: string): string {
  return createHmac("sha256", getSecret()).update(encodedPayload).digest("base64url");
}

/**
 * Base64url-encodes the JSON payload, HMAC-SHA256-signs it with the platform
 * secret, and returns `${encodedPayload}.${signature}` -- a single
 * URL-safe string suitable for the `/unsubscribe/:token` path segment.
 */
export function signUnsubscribeToken(payload: UnsubscribeTokenPayload): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

/**
 * Verifies the HMAC signature with a timing-safe compare and returns the
 * decoded payload, or `null` for ANY failure (wrong shape, bad base64,
 * invalid JSON, or a signature mismatch) -- this function never throws, so a
 * malformed/tampered token always degrades to the same "invalid" outcome the
 * route maps to its generic response (T-04-03-01/T-04-03-02).
 */
export function verifyUnsubscribeToken(token: string): UnsubscribeTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) {
    return null;
  }
  const [encodedPayload, signature] = parts;
  if (!encodedPayload || !signature) {
    return null;
  }

  let expectedSigBuf: Buffer;
  let actualSigBuf: Buffer;
  try {
    expectedSigBuf = Buffer.from(sign(encodedPayload), "base64url");
    actualSigBuf = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }

  if (expectedSigBuf.length !== actualSigBuf.length || !timingSafeEqual(expectedSigBuf, actualSigBuf)) {
    return null;
  }

  try {
    const json = Buffer.from(encodedPayload, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as Partial<UnsubscribeTokenPayload>;
    if (
      typeof parsed.sendId !== "string" ||
      typeof parsed.contactId !== "string" ||
      typeof parsed.workspaceId !== "string" ||
      typeof parsed.exp !== "number"
    ) {
      return null;
    }
    return {
      sendId: parsed.sendId,
      contactId: parsed.contactId,
      workspaceId: parsed.workspaceId,
      exp: parsed.exp,
    };
  } catch {
    return null;
  }
}

/** Composes the public one-click unsubscribe URL from `PUBLIC_APP_URL` + the signed token. */
export function buildListUnsubscribeUrl(token: string): string {
  const baseUrl = process.env.PUBLIC_APP_URL;
  if (!baseUrl) {
    throw new Error("PUBLIC_APP_URL is not set");
  }
  return `${baseUrl}/unsubscribe/${token}`;
}
