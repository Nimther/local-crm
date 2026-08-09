/**
 * Transport-error classifier for the SendGrid `mail/send` call (Phase 11,
 * D-10, DLV-06).
 *
 * Load-bearing rule, in the user's own words (11-CONTEXT.md § Specific
 * Ideas): "если транспортный слой не позволяет доказать, были ли отправлены
 * байты, безопасный default -- reconciling" -- if this module cannot PROVE
 * whether the request bytes ever left this process, the safe default is
 * `ambiguous`, never `pre_connection_retryable`. `ambiguous` is what
 * `send-dispatch.ts` (11-06) sends to `reconciling` (ARCHITECTURE.md §9) --
 * a send in that state is NEVER automatically re-sent; only the
 * reconciler's webhook-evidence read can resolve it. Getting this
 * classification wrong toward "safe to retry" risks a genuine duplicate
 * email; getting it wrong toward "ambiguous" only costs an extra
 * reconciliation cycle. That asymmetry is why `ambiguous` is the
 * structural, always-last default below, and `pre_connection_retryable` is
 * the narrow, explicitly-enumerated exception.
 *
 * The distinguishing signal is: was a connection to SendGrid ever
 * established?
 * - DNS resolution failure (`ENOTFOUND`, `EAI_AGAIN`) or an actively refused
 *   TCP handshake (`ECONNREFUSED`) prove the request could not possibly have
 *   left this process -- the byte stream never started, so retrying is
 *   provably safe.
 * - Everything else -- a connection reset mid-flight (`ECONNRESET`), an
 *   abort/timeout firing while a request was already in flight
 *   (`AbortError`/`TimeoutError`), any error shape this module does not
 *   recognize, or a non-object input (`null`/`undefined`/a string/a number)
 *   -- means the request bytes MAY already have reached SendGrid. All of
 *   these fall through to `ambiguous`.
 *
 * Consequence for future maintainers: adding a `code` to the pre-connection
 * allowlist below is a decision to permit an automatic re-send for that
 * error class. Do not add one unless you can prove the error can ONLY occur
 * before any request bytes left this process.
 */
export type TransportClassification = "pre_connection_retryable" | "ambiguous";

/**
 * The ONLY codes proven to mean "no connection was ever established" --
 * see the file-header rationale for why this list must stay narrow.
 */
const PRE_CONNECTION_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"]);

/** Reads `.code` off an unknown thrown value without throwing on a non-object input. */
function readCode(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Classifies a thrown/rejected value from `sendTenantMailV3`'s `fetch` call.
 * Never throws, regardless of input shape -- a classifier that can itself
 * fail on an unrecognized error would defeat the fail-closed guarantee it
 * exists to provide.
 */
export function classifyTransportError(err: unknown): TransportClassification {
  const directCode = readCode(err);
  if (directCode !== undefined && PRE_CONNECTION_CODES.has(directCode)) {
    return "pre_connection_retryable";
  }

  // Node's `fetch` (undici) wraps socket-level failures inside a
  // `TypeError: fetch failed`, with the REAL code one level down on
  // `.cause` -- reading only the top level would misclassify every genuine
  // ECONNREFUSED as ambiguous and needlessly send a provably-safe-to-retry
  // failure to `reconciling`. Only one level is unwrapped: a `cause` chain
  // deeper than that is not a shape this codebase's runtime produces.
  const cause = typeof err === "object" && err !== null ? (err as { cause?: unknown }).cause : undefined;
  const causeCode = readCode(cause);
  if (causeCode !== undefined && PRE_CONNECTION_CODES.has(causeCode)) {
    return "pre_connection_retryable";
  }

  // Fail-closed default (D-10): ECONNRESET, AbortError/TimeoutError, any
  // unrecognized error shape, and every non-object input all fall through
  // here. This line must stay structurally last -- it is the fallback the
  // whole module exists to make obvious and impossible to bypass.
  return "ambiguous";
}
