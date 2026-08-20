import { createHmac, timingSafeEqual } from "node:crypto";
import { logger } from "./logger.js";

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

// ROT-01/D-01: the primary secret signs every NEW token. Its meaning and
// name are unchanged by rotation -- only verification gains a fallback list.
function getPrimarySecret(): string {
  const secret = process.env.UNSUBSCRIBE_TOKEN_SECRET;
  if (!secret) {
    throw new Error("UNSUBSCRIBE_TOKEN_SECRET is not set");
  }
  return secret;
}

// ROT-01/D-01: optional, comma-separated, ordered list of retired secrets --
// verification-only, never used to sign. Read lazily on every call (not
// parsed once at module load) so a running process picks up an operator's
// rotation the moment the env var changes and the process restarts, with no
// other code path needing to know the list exists.
function getPreviousSecrets(): string[] {
  const raw = process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS;
  if (!raw) {
    return [];
  }
  return raw.split(",");
}

function signWith(secret: string, encodedPayload: string): string {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

function sign(encodedPayload: string): string {
  return signWith(getPrimarySecret(), encodedPayload);
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

  let actualSigBuf: Buffer;
  try {
    actualSigBuf = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }

  // ROT-01/ROT-02/D-04: try the primary first, then each retired secret in
  // list order -- a link mailed under any retained secret still verifies.
  // D-04/SC3: the loop is EXHAUSTIVE (no early break on a match) so total
  // loop duration is a function of candidates.length alone, never of which
  // candidate matched or whether any did -- this is what keeps the HTTP
  // response byte-identical regardless of which secret (if any) produced
  // the match (T-19-02).
  const candidates = [getPrimarySecret(), ...getPreviousSecrets()];
  let matchedIndex = -1;

  for (let i = 0; i < candidates.length; i++) {
    let expectedSigBuf: Buffer;
    try {
      expectedSigBuf = Buffer.from(signWith(candidates[i], encodedPayload), "base64url");
    } catch {
      continue;
    }
    // T-19-01: every candidate the loop reaches goes through the
    // timing-safe primitive -- no raw equality, no cheap pre-filter that
    // could skip it for a candidate that is actually reached.
    const isMatch =
      expectedSigBuf.length === actualSigBuf.length && timingSafeEqual(expectedSigBuf, actualSigBuf);
    if (isMatch && matchedIndex === -1) {
      matchedIndex = i;
    }
  }

  if (matchedIndex === -1) {
    return null;
  }

  // D-05: observability for the operator's retention decision -- logs ONLY
  // the matched list position, never any secret value. Server-side only;
  // the HTTP response is unaffected (T-19-03, no oracle).
  if (matchedIndex > 0) {
    logger.info({ secretPosition: matchedIndex }, "unsubscribe token verified via previous secret");
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
