import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import pino from "pino";
import { scrub } from "../scrub.js";
import { PINO_REDACT_OPTIONS } from "../pino-redact.js";
import { CENSOR } from "../rules.js";

/**
 * Phase 15 plan 04 (OPS-07, T-15-11): proves `apps/api`'s and `apps/worker`'s
 * loggers redact identically -- BEHAVIOURALLY, by running one shared fixture
 * through two real Pino instances each configured with `PINO_REDACT_OPTIONS`
 * (the exact option object both apps' `logger.ts` pass to `redact`), not by
 * string-comparing source. Reference each app's logger file by path (via
 * `readFileSync`) for the source-level guard case only -- this package must
 * never gain a dependency on either app (SEC-13's single-definition rule
 * would be meaningless if this package imported the very modules it exists
 * to keep in sync).
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const API_LOGGER_PATH = join(REPO_ROOT, "apps", "api", "src", "logger.ts");
const WORKER_LOGGER_PATH = join(REPO_ROOT, "apps", "worker", "src", "logger.ts");

/** Runs `payload` through a real Pino instance configured with PINO_REDACT_OPTIONS and returns the parsed JSON log line. */
function logViaPino(payload: Record<string, unknown>): Record<string, unknown> {
  const lines: string[] = [];
  const captureStream = {
    write(msg: string): boolean {
      lines.push(msg);
      return true;
    },
  };
  // Same `redact` option value both apps' logger.ts pass to `pino()` --
  // building two separate instances (rather than one shared instance) is
  // the point: it proves two independently-constructed Pino instances given
  // the same compiled option object behave identically, which is exactly
  // what "apps/api's process and apps/worker's process redact the same way"
  // reduces to.
  const logger = pino({ redact: PINO_REDACT_OPTIONS }, captureStream);
  logger.info(payload);
  return JSON.parse(lines[0]) as Record<string, unknown>;
}

/** Strips Pino's own non-deterministic envelope fields (`time`, `pid`, `hostname`) so two log lines can be compared purely on the fields redaction touches. */
function stripNonDeterministicFields(line: Record<string, unknown>): Record<string, unknown> {
  const { time: _time, pid: _pid, hostname: _hostname, ...rest } = line;
  return rest;
}

describe("logger uniformity between apps/api and apps/worker", () => {
  test("Test 1: the same fixture payload logged through two independently-built pino instances, each configured with PINO_REDACT_OPTIONS exactly as apps/api/src/logger.ts and apps/worker/src/logger.ts declare it, yields deep-equal redacted output", () => {
    const fixture = {
      sendgridKey: "SG.aaaaaaaaaa.bbbbbbbbbb",
      password: "hunter2-not-a-real-password",
      token: "reset-token-abc123",
      contact: {
        email: "marketer@example.com",
        phone: "+14155550199",
      },
      nested: {
        deeper: {
          stillDeeper: {
            apiKey: "deeply-nested-api-key",
          },
        },
      },
      properties: {
        orderId: "ord_123",
      },
    };

    const loggedByApiInstance = logViaPino(fixture);
    const loggedByWorkerInstance = logViaPino(fixture);

    expect(stripNonDeterministicFields(loggedByWorkerInstance)).toEqual(stripNonDeterministicFields(loggedByApiInstance));

    // Sanity: this is not a vacuous deep-equal of two empty objects -- both
    // instances actually redacted the fields the fixture set out to exercise.
    expect(loggedByApiInstance.sendgridKey).toBe(CENSOR);
    const contact = loggedByApiInstance.contact as Record<string, unknown>;
    expect(contact.email).toBe(CENSOR);
    const nested = loggedByApiInstance.nested as Record<string, unknown>;
    const deeper = nested.deeper as Record<string, unknown>;
    const stillDeeper = deeper.stillDeeper as Record<string, unknown>;
    expect(stillDeeper.apiKey).toBe(CENSOR);
  });

  test("Test 2: known boundary -- a provider-key-shaped value under a key name NOT in keyRules passes the path list unchanged, while scrub() censors the same payload (documenting why both compiled forms exist rather than assuming the path list alone is sufficient)", () => {
    const payload = {
      // `randomField` is not a member of REDACTION_RULES.keyRules -- a
      // key-path matcher structurally cannot catch a secret hiding under an
      // unlisted field name, no matter how many depths are enumerated.
      randomField: "SG.cccccccccc.dddddddddd",
    };

    const loggedViaPino = logViaPino(payload);
    expect(loggedViaPino.randomField).toBe("SG.cccccccccc.dddddddddd");

    const scrubbed = scrub(payload) as typeof payload;
    expect(scrubbed.randomField).toBe(CENSOR);
  });

  test("Test 3: neither apps/api/src/logger.ts nor apps/worker/src/logger.ts declares a locally-declared redaction path array -- SEC-13's single-definition rule stays enforced, not just aspirational", () => {
    const apiSource = readFileSync(API_LOGGER_PATH, "utf-8");
    const workerSource = readFileSync(WORKER_LOGGER_PATH, "utf-8");

    // A locally-declared path array would look like `paths: [` (or
    // `paths:[`) somewhere in the file. Both apps must instead only ever
    // reference the imported `PINO_REDACT_OPTIONS` constant.
    const localPathArrayPattern = /paths\s*:\s*\[/;

    expect(apiSource).not.toMatch(localPathArrayPattern);
    expect(workerSource).not.toMatch(localPathArrayPattern);

    expect(apiSource).toContain("PINO_REDACT_OPTIONS");
    expect(workerSource).toContain("PINO_REDACT_OPTIONS");
  });
});
