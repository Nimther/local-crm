import pino from "pino";
import { PINO_REDACT_OPTIONS } from "@mega-crm/redaction";
import { getCorrelationContext } from "@mega-crm/tenant-context";

/**
 * Structured logging (Pino, per CLAUDE.md). Phase 15 plan 02 (OPS-06/OPS-07):
 * mirrors `apps/api/src/logger.ts` exactly -- same construction, same
 * redaction source, same correlation mixin -- this is the first Pino logger
 * `apps/worker` has ever had (10-13 gave it `scrubbedConsole` over bare
 * `console.*`, this replaces that as the primary structured channel; direct
 * `console.*` call sites are migrated one at a time by later plans in this
 * phase, not all at once here).
 *
 * The redaction rules live in ONE place, `packages/redaction/src/rules.ts`
 * (`REDACTION_RULES`) -- this file just consumes the compiled path-list form
 * (`PINO_REDACT_OPTIONS`), same as `apps/api`. That compiled form is a
 * fixed-depth field-PATH list -- correct and cheap for known log-call
 * shapes, but it cannot reach arbitrary nesting or match by value. Freeform
 * payloads (event properties, webhook bodies, job data) must go through
 * `@mega-crm/redaction`'s `scrub()` instead, which has no depth ceiling and
 * also matches by value pattern (provider key shape, email, phone) -- never
 * pass a freeform payload straight to this logger expecting `redact` alone
 * to catch it.
 *
 * `mixin()` runs on EVERY log call and merges its return value into that
 * line's fields -- the zero-parameter-threading mechanism (RESEARCH.md
 * Pattern 1) that stamps `requestId`/`workspaceId`/`jobId`/`sendId` onto
 * every worker log line without any call site passing them explicitly.
 * `getCorrelationContext()` returns `{}` when no ALS scope is active (e.g. a
 * boot-time log line before any job has started), so this never throws.
 *
 * `apps/worker` has no `env.ts` (unlike `apps/api`) -- it reads `process.env`
 * directly at every call site that needs it (see `apps/worker/src/server.ts`),
 * and this file follows that same convention rather than inventing one.
 */
export const logger = pino({
  level: process.env.NODE_ENV === "test" ? "silent" : "info",
  redact: PINO_REDACT_OPTIONS,
  mixin() {
    return getCorrelationContext();
  },
});
