/**
 * 10-13 (SEC-13): the SINGLE rule table both compiled forms are derived
 * from -- `pino-redact.ts` (field-path list for the structured logger) and
 * `scrub.ts` (unlimited-depth recursive walker for freeform payloads).
 *
 * A reviewer adding coverage edits ONLY this file. Neither `pino-redact.ts`
 * nor `scrub.ts` declares a rule literal of its own -- that duplication is
 * exactly the drift T-10-13-04 exists to prevent, and the parity test
 * (`__tests__/rules-parity.test.ts`) fails if the two compiled forms ever
 * diverge from what is written here.
 *
 * Two kinds of rule, because they catch two different shapes of leak:
 *
 *   - `keyRules`  -- match by FIELD NAME (case-insensitive). Cheap, and the
 *     only thing a fixed-depth path list (Pino's `redact.paths`) can act
 *     on. Absorbs the four names `apps/api/src/logger.ts` covered before
 *     centralization (`sendgridKey`, `apiKey`, `password`, `token`) plus
 *     every other secret-shaped and PII-shaped field name this codebase
 *     actually uses (grep-grounded against apps/api/src and apps/worker/src
 *     -- see each rule's `protects` comment for its call site).
 *
 *   - `valueRules` -- match by VALUE PATTERN, regardless of what the field
 *     is called. This is the backstop for freeform payloads (event
 *     properties, webhook bodies) where the field name is tenant-chosen and
 *     cannot be enumerated in advance -- a decrypted SendGrid key, an email
 *     address or a phone number leaks the same secret/PII whether it shows
 *     up under a known key name or buried in an arbitrary nested object.
 *     `scrub.ts` is the only consumer that can apply these (a static path
 *     list has no way to test a value against a regex); `pino-redact.ts`'s
 *     doc comment states that limitation explicitly.
 */

export const CENSOR = "[REDACTED]";

export interface KeyRule {
  /** Field name this rule matches, case-insensitively, at any nesting depth. */
  readonly key: string;
  /** What this rule protects and where it comes from -- never left implicit. */
  readonly protects: string;
}

export interface ValueRule {
  /** Short identifier for this pattern, used in test failure messages. */
  readonly name: string;
  /** Tested against string values (not anchored -- a match anywhere in the string redacts the whole value). */
  readonly pattern: RegExp;
  /** What this rule protects and where it comes from -- never left implicit. */
  readonly protects: string;
}

export const REDACTION_RULES: { keyRules: readonly KeyRule[]; valueRules: readonly ValueRule[] } = {
  keyRules: [
    // Absorbed verbatim from apps/api/src/logger.ts's pre-centralization list.
    { key: "sendgridKey", protects: "tenant SendGrid API key (BYO, decrypted before send/validate/webhook provisioning)" },
    { key: "apiKey", protects: "generic API key field (sendgrid-key.ts route body, sendgrid-client.ts params)" },
    { key: "password", protects: "user password (Better Auth credential sign-up/sign-in/reset)" },
    { key: "token", protects: "session/verification/reset/unsubscribe token (Better Auth flows, delivery-core unsubscribe-token.ts)" },
    // Added: other secret-shaped field names actually used across apps/api and apps/worker.
    { key: "secret", protects: "generic secret material (API-key secret half, signing secrets)" },
    { key: "apiSecret", protects: "API key secret half (api-key-auth.ts's `mcrm_<id>.<secret>` scheme)" },
    // ROT-01/D-02: spelled as the environment-variable name, not a camelCase
    // transformation of it -- scrub.ts lower-cases rule keys into a Set and
    // matches a field only on exact lower-cased equality, so a camelCase key
    // would never match a field literally named after the env var. The
    // generic `secret` rule above does not cover either of these, because it
    // only matches a field named exactly `secret`, not one containing it.
    // packages/delivery-core's own package-local logger does NOT route
    // through this pipeline (same as the packages/contacts-core precedent),
    // so these two rules are defence in depth for the API and worker
    // loggers, not the safeguard on D-05's own log call -- that safeguard is
    // the shape of the call, asserted directly by plan 19-04.
    {
      key: "UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS",
      protects:
        "retired unsubscribe-token HMAC signing secret(s), comma-separated verification-only list read in packages/delivery-core/src/unsubscribe-token.ts",
    },
    {
      key: "UNSUBSCRIBE_TOKEN_SECRET",
      protects: "current unsubscribe-token HMAC signing secret, read in packages/delivery-core/src/unsubscribe-token.ts",
    },
    { key: "clientSecret", protects: "OAuth/provider-style client secret" },
    { key: "refreshToken", protects: "OAuth/session refresh token" },
    { key: "sessionToken", protects: "session token" },
    { key: "accessToken", protects: "OAuth/session access token" },
    { key: "authorization", protects: "Authorization header value (`Bearer <key>` -- sendgrid-client.ts, sendgrid-webhook-provision.ts, api-key-auth.ts)" },
    { key: "cookie", protects: "session cookie header/value (tenancy/invites.ts session-transfer flow)" },
    { key: "plaintextDek", protects: "decrypted per-tenant KMS Data Encryption Key material (packages/kms/src/client.ts, zeroed after use but must never reach a log)" },
    // Added: PII-shaped field names, so a shallow field named exactly this
    // is caught by BOTH compiled forms -- the value-pattern rules below are
    // the depth-independent backstop for the same PII under any other name.
    { key: "email", protects: "contact/user email address under its own field name" },
    { key: "phone", protects: "contact phone number under its own field name" },
  ],
  valueRules: [
    {
      name: "sendgridProviderKey",
      // SendGrid API key shape: `SG.<22 chars>.<43 chars>` in practice: this
      // pattern is deliberately loose (10+ base64url chars per segment)
      // rather than pinned to exact lengths, so it still catches the key
      // wherever it appears in a value -- regardless of field name --
      // without becoming brittle against a future SendGrid format change.
      pattern: /SG\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
      protects: "SendGrid API key shape, wherever it appears in a value regardless of field name",
    },
    {
      name: "email",
      pattern: /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+/,
      protects: "email address in value position under any field name -- the freeform-event-properties backstop",
    },
    {
      name: "phone",
      // Requires a STANDALONE run of 10+ digits (E.164's floor), where "digits"
      // may be separated by the usual phone punctuation, AND where the run is
      // not itself a canonical UUID. All three halves of that sentence are
      // load-bearing, and each was learned from a live failure:
      //
      //  - the digit FLOOR: the first version matched "7+ digit-ish
      //    characters", which hit substrings of most v4 UUIDs. UUIDs
      //    (workspace_id/contact_id/send_id) are logged constantly.
      //
      //  - the BOUNDARIES: raising the floor to 10 only made the UUID
      //    collision rarer, not impossible -- measured at ~4% of
      //    `randomUUID()` values, because `-` is one of this pattern's own
      //    separators, so a UUID's hex groups chain into a single long digit
      //    run whenever enough of their characters happen to be digits (e.g.
      //    `b2cd545e-6853-418e-a436-2d4658232825`). A trailing `\b` did not
      //    help: it let the match START mid-token, in the middle of a hex
      //    group. That is what kept redacting `owningWorkspaceId` in
      //    webhook-events-sibling-drop.test.ts's Test 4 at a ~4% duty cycle,
      //    and it is a production defect too -- SEC-09/WR-01's drop signal
      //    exists precisely to carry workspace ids.
      //
      //  - the UUID-SHAPE EXCLUSION: anchoring both ends against
      //    `[0-9A-Za-z-]` did NOT fix this "by construction", as the previous
      //    revision of this comment claimed. Work out what those anchors
      //    actually admit inside a standalone canonical UUID. The lookbehind
      //    `(?<![0-9A-Za-z-])` permits exactly ONE start position -- index 0,
      //    because every other position follows a hex character or a `-`. The
      //    closing lookahead `(?![0-9A-Za-z-])` permits exactly ONE end
      //    position -- end of value, because every internal position is
      //    followed by a digit, a hex letter or a `-`. A match therefore
      //    requires EVERY character of the token to be a digit or a `-`. So
      //    the anchors excluded a UUID only when it happened to contain a hex
      //    LETTER -- not because it was UUID-shaped -- and an ALL-DECIMAL
      //    canonical UUID (all 32 hex characters happening to be digits) was
      //    still matched in full and redacted. That class has density
      //    0.625^30 x 0.5 = 3.76e-7 of `randomUUID()` values (the version
      //    nibble is a fixed `4`, the variant nibble is a digit in 2 of its 4
      //    legal values, the other 30 characters are free), measured as 0 hits
      //    in 3,000,000 samples -- which is exactly why the 5000-sample guard
      //    written for this rule never reached it. But it is 100% for the nil
      //    UUID `00000000-0000-0000-0000-000000000000`, a sentinel this
      //    codebase can legitimately log. Debug session
      //    `uuid-redacted-as-phone`; reported literal
      //    `17240210-0546-4077-9954-207876832048`.
      //
      // The `(?!<uuid shape>)` lookahead in the pattern below replaces that
      // INCIDENTAL criterion ("the token contains a hex letter") with the
      // INTENDED one ("the token is UUID-shaped"). That closes the whole
      // all-decimal residue rather than the one reported literal: 0 of 200,000
      // all-decimal canonical UUIDs match, where the pattern it replaced
      // matched 200,000 of 200,000. Realistic phone formats are unaffected,
      // because their separators are INTERNAL to the match rather than at its
      // edges and no phone number carries the 8-4-4-4-12 shape:
      // `+14155550199`, `+1 415-555-0199`, `(415) 555-0199`, `tel:+1-415-555-0199`.
      //
      // THREE properties of that lookahead are load-bearing. Two of them fail
      // SILENTLY -- the rule keeps working for phones while quietly redacting
      // UUIDs again, or quietly stops covering real PII -- so each is pinned by
      // a named assertion in `__tests__/scrub-identifier-false-positive.test.ts`:
      //
      //  1. PLACEMENT -- it must sit AFTER the optional `\+?\(?` prefix, never
      //     before it. Placed before, `(<uuid>)` and `+<uuid>` are redacted
      //     anyway: the match simply begins one character earlier, on the `(`
      //     or the `+`, at a position where the shape lookahead never fires.
      //     Measured 2 of 23 discriminating probes still failing. Pinned by
      //     Test 9's parenthesised and `+`-prefixed cases.
      //
      //  2. THE INNER `(?![0-9A-Za-z-])` -- it narrows the exclusion to tokens
      //     that END right after the 12th character of the final group. Drop it
      //     and `12345678-1234-1234-1234-1234567890123` (8-4-4-4-13: a 33-digit
      //     run that is NOT a canonical UUID) stops matching, trading this
      //     false positive for a false NEGATIVE on real PII. Pinned by Test 11.
      //
      //  3. `[0-9a-fA-F]` rather than `[0-9]` -- the two are provably
      //     EQUIVALENT here, because a hex-lettered UUID cannot match the outer
      //     pattern at all (see the BOUNDARIES bullet above), so excluding it
      //     changes no behaviour. Full-hex is kept DELIBERATELY: it states the
      //     intent ("this token is UUID-shaped") instead of encoding the
      //     accident that only all-decimal UUIDs ever got this far. Unlike (1)
      //     and (2) this one is NOT test-pinned -- no assertion can distinguish
      //     the two spellings -- so do not "simplify" it to `[0-9]`; this
      //     paragraph is the only thing preserving what the lookahead is for.
      //
      // The upper bound is open (`{9,}` = 10 or more) rather than the E.164
      // ceiling of 15. With a start anchor a capped pattern could no longer
      // slide its start position forward to cover a longer run, so `{9,14}`
      // would have stopped matching 16+ digit runs (a card number being the
      // realistic case) that the previous pattern did catch. Open-ended keeps
      // this rule's effective coverage a superset of what it replaced.
      pattern:
        /(?<![0-9A-Za-z-])\+?\(?(?![0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![0-9A-Za-z-]))\d(?:[\s().-]*\d){9,}(?![0-9A-Za-z-])/,
      protects: "phone number in value position under any field name -- the freeform-event-properties backstop",
    },
  ],
};
