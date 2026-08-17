import { CENSOR, REDACTION_RULES } from "./rules.js";

/**
 * Compiles `REDACTION_RULES.keyRules` into the field-path form Pino's
 * `redact` option expects: each key name at five wildcard depths (root,
 * one through four levels nested -- `field`, `*.field`, `*.*.field`,
 * `*.*.*.field`, `*.*.*.*.field`). Spread this into the `redact` option of
 * a Pino instance:
 *
 *   pino({ redact: PINO_REDACT_OPTIONS })
 *
 * Phase 15 plan 04 (OPS-07, Pitfall 18's logging half): this was originally
 * three depths (`field`, `*.field`, `*.*.field`) -- exactly what
 * `apps/api/src/logger.ts` enumerated before centralization (10-13). Now
 * that `apps/worker` has its own Pino logger too (plan 15-02), a secret
 * nested one level deeper than the enumeration would be logged in
 * plaintext by BOTH processes, not just one -- two more explicit depths
 * were added as defense in depth. Do not simplify this back down to two or
 * three depths: that regresses exactly the coverage this plan added.
 *
 * LIMITATION (the reason `scrub.ts` exists as a second compiled form, and
 * why five depths is still a BOUNDED improvement, not a full fix): a path
 * list can only reach as deep as it is enumerated here, and it can only
 * match by FIELD NAME -- it has no way to test a value against a regex.
 * `fast-redact` has no recursive/glob-style "any depth" wildcard (each `*`
 * token matches exactly one level -- see getpino.io/#/docs/redaction,
 * "Path is limited"), so no finite enumeration ever fully closes this gap.
 * Five depths is a correct, cheap match for this codebase's known
 * request/response shapes, which nest a handful of levels deep at most. It
 * is NOT safe for freeform, tenant-authored JSONB (event `properties`,
 * webhook `payload`) that can nest arbitrarily deep under tenant-chosen key
 * names -- those must go through `scrub()` instead, which walks to
 * unlimited depth and also matches by value pattern. Any log line that
 * embeds such a payload verbatim must route through `scrub()`, never rely
 * on this path list alone.
 */
export const PINO_REDACT_OPTIONS: { paths: string[]; censor: string } = {
  paths: REDACTION_RULES.keyRules.flatMap((rule) => [
    rule.key,
    `*.${rule.key}`,
    `*.*.${rule.key}`,
    `*.*.*.${rule.key}`,
    `*.*.*.*.${rule.key}`,
  ]),
  censor: CENSOR,
};
