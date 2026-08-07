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
      pattern: /(?:\+?\d[\d\s().-]{7,}\d)/,
      protects: "phone number in value position under any field name -- the freeform-event-properties backstop",
    },
  ],
};
