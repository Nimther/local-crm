import pino from "pino";
import { PINO_REDACT_OPTIONS } from "@mega-crm/redaction";
import { env } from "./env.js";

/**
 * Structured logging (Pino, per CLAUDE.md).
 *
 * 10-13 (SEC-13): the redaction rules used to live here as an inline path
 * array. They now live in ONE place, `packages/redaction/src/rules.ts`
 * (`REDACTION_RULES`), and this file just consumes the compiled form --
 * `PINO_REDACT_OPTIONS` -- rather than declaring its own list. A reviewer
 * adding coverage edits `rules.ts`, not this file.
 *
 * This compiled form is a fixed-depth field-PATH list -- correct and cheap
 * for this app's known request/response shapes, but it cannot reach
 * arbitrary nesting or match by value. Freeform payloads (event
 * properties, webhook bodies) go through `@mega-crm/redaction`'s `scrub()`
 * instead, which has no depth ceiling and also matches by value pattern
 * (provider key shape, email, phone) -- see that package's doc comments.
 */
export const logger = pino({
  level: env.NODE_ENV === "test" ? "silent" : "info",
  redact: PINO_REDACT_OPTIONS,
});
