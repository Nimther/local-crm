import type { Event, EventHint } from "@sentry/node";
import { scrub } from "./scrub.js";

/**
 * Sentry has NO retroactive redaction (Pitfall 18, 15-RESEARCH.md § Pitfall
 * 3): once a Sentry SDK accepts an event, any secret or PII inside it is
 * permanently stored on Sentry's side, and the only remedy for a leaked
 * field is deleting the ENTIRE project's event history -- there is no
 * per-field retraction API. That makes THIS hook the phase's actual safety
 * mechanism, not a defense-in-depth nicety on top of Sentry's own scrubber:
 * no Sentry SDK may be initialized against a live DSN anywhere in this
 * codebase until `__tests__/sentry-scrub-fixtures.test.ts` is green and
 * wired as a blocking CI step (`.github/workflows/ci.yml`'s `static` job,
 * `check:sentry-redaction` -- see plan 15-06, Task 3).
 *
 * Delegates the ENTIRE event body to the existing `scrub()` -- the same
 * depth-unbounded, key-name- and value-pattern-matching walker
 * `apps/worker`'s `scrubbedConsole` already uses for freeform payloads
 * (10-13, SEC-13). Sentry's own built-in data scrubber is deliberately NOT
 * relied on here: it covers a fixed list of common patterns and knows
 * nothing about this system's specific secret shapes (a decrypted tenant
 * SendGrid key) or that a contact's email/phone is PII under THIS system's
 * data model. This file does not, and must not, declare a second rule
 * list of its own -- any new coverage belongs in `rules.ts`, consumed by
 * `scrub()`, exactly the single-source-of-truth design SEC-13 exists to
 * enforce (`rules-parity.test.ts` guards the OTHER two compiled forms
 * against drift the same way).
 *
 * Typed from `@sentry/node`'s exported `Event`/`EventHint` -- imported as
 * TYPES ONLY (see `packages/redaction/package.json`: `@sentry/node` is a
 * devDependency, never a runtime one -- this package stays
 * dependency-light, SEC-13). Generic over the event's own subtype (rather
 * than pinned to the narrower `ErrorEvent`) so the SAME exported function
 * can be assigned directly to both `beforeSend` (expects a function over
 * `ErrorEvent`) and `beforeSendTransaction` (expects a function over
 * `TransactionEvent`) at all three SDK initialization sites (web/api/
 * worker) -- `@sentry/react`'s events share this exact shape. A function
 * whose parameter is narrowed to `ErrorEvent` is NOT assignable to
 * `beforeSendTransaction`'s slot under `strictFunctionTypes` (verified
 * against the real `@sentry/node@10.70.0` `Options` type); the generic
 * form is instantiated separately at each assignment site instead.
 */
export function sentryBeforeSend<E extends Event>(event: E, _hint: EventHint): E {
  // scrub() never mutates its input and returns a structurally-equivalent
  // copy when there is nothing to redact (packages/redaction's own
  // scrub.test.ts, Test 6) -- so an event with nothing to scrub round-trips
  // to an equivalent event, never undefined/null, preserving the SDK's
  // beforeSend/beforeSendTransaction contract (it must return the event,
  // a replacement event, or null to drop it -- never undefined).
  return scrub(event) as E;
}
