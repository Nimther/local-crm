import { CENSOR, REDACTION_RULES } from "./rules.js";

/**
 * Compiles `REDACTION_RULES.keyRules` into the field-path form Pino's
 * `redact` option expects: each key name at the same three wildcard depths
 * `apps/api/src/logger.ts` used before centralization (root, one level
 * nested, two levels nested -- `field`, `*.field`, `*.*.field`). Spread
 * this into the `redact` option of a Pino instance:
 *
 *   pino({ redact: PINO_REDACT_OPTIONS })
 *
 * LIMITATION (the reason `scrub.ts` exists as a second compiled form): a
 * path list can only reach as deep as it is enumerated here, and it can
 * only match by FIELD NAME -- it has no way to test a value against a
 * regex. It is a correct, cheap match for the API's known request/response
 * shapes, which nest a handful of levels deep at most. It is NOT safe for
 * freeform payloads (event properties, webhook bodies) that can nest
 * arbitrarily deep under tenant-chosen key names -- those must go through
 * `scrub()` instead, which walks to unlimited depth and also matches by
 * value pattern.
 */
export const PINO_REDACT_OPTIONS: { paths: string[]; censor: string } = {
  paths: REDACTION_RULES.keyRules.flatMap((rule) => [rule.key, `*.${rule.key}`, `*.*.${rule.key}`]),
  censor: CENSOR,
};
