import { CENSOR, REDACTION_RULES } from "./rules.js";

const KEY_RULE_NAMES = new Set(REDACTION_RULES.keyRules.map((rule) => rule.key.toLowerCase()));

function matchesKeyRule(key: string): boolean {
  return KEY_RULE_NAMES.has(key.toLowerCase());
}

function matchesValuePattern(value: string): boolean {
  return REDACTION_RULES.valueRules.some((rule) => rule.pattern.test(value));
}

/** Marker returned in place of a cyclic reference -- distinct from CENSOR, since a cycle is a shape problem, not a leaked secret. */
const CIRCULAR_MARKER = "[CIRCULAR]";

/**
 * Recursively walks `value` and returns a redacted COPY -- the input is
 * never mutated (Test 6). No depth ceiling: this is the mechanism freeform
 * payloads (event properties, webhook bodies) must go through, since they
 * can nest arbitrarily deep under tenant-chosen key names that
 * `pino-redact.ts`'s fixed-depth path list cannot reach.
 *
 * Redacts by TWO independent mechanisms, matching `REDACTION_RULES`:
 *   - key-name match (case-insensitive) -- the whole subtree under a
 *     matching key becomes CENSOR, without recursing into it.
 *   - value-pattern match -- a string value tested against every
 *     `valueRules` regex, regardless of what key it lives under.
 *
 * `Error` instances get special handling: `Object.entries(new Error(...))`
 * returns nothing (message/stack are non-enumerable), so a naive walk would
 * silently collapse every `console.error("...", err)` call site's error
 * into `{}` -- destroying the stack trace that's the entire reason to log
 * it. Instead the error's name/message/stack are preserved (message run
 * through the same value-pattern check as any other string) alongside any
 * of its own enumerable custom properties, scrubbed the same as a plain
 * object's.
 *
 * Cyclic structures terminate via a `WeakSet` of already-visited objects
 * (Test 7) -- a revisited object returns `CIRCULAR_MARKER` rather than
 * recursing forever.
 */
export function scrub(value: unknown): unknown {
  return scrubInternal(value, new WeakSet<object>());
}

function scrubInternal(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return matchesValuePattern(value) ? CENSOR : value;
  }

  if (typeof value !== "object") {
    // number, boolean, bigint, symbol, function -- pass through unchanged.
    return value;
  }

  if (seen.has(value)) {
    return CIRCULAR_MARKER;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => scrubInternal(item, seen));
  }

  if (value instanceof Error) {
    const err = value as Error & Record<string, unknown>;
    const extraKeys = Object.getOwnPropertyNames(err).filter(
      (key) => key !== "name" && key !== "message" && key !== "stack",
    );
    const extras: Record<string, unknown> = {};
    for (const key of extraKeys) {
      extras[key] = matchesKeyRule(key) ? CENSOR : scrubInternal(err[key], seen);
    }
    return {
      name: err.name,
      message: matchesValuePattern(err.message) ? CENSOR : err.message,
      stack: err.stack,
      ...extras,
    };
  }

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    result[key] = matchesKeyRule(key) ? CENSOR : scrubInternal(val, seen);
  }
  return result;
}
