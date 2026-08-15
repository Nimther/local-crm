import { describe, expect, test } from "vitest";
import pino from "pino";
import { scrub } from "../scrub.js";
import { PINO_REDACT_OPTIONS } from "../pino-redact.js";
import { CENSOR, REDACTION_RULES } from "../rules.js";

/**
 * The literal `redact.paths` array `apps/api/src/logger.ts` declared
 * BEFORE centralization (10-13) -- captured here as a literal, not derived
 * from anything in this package, so Test 9 asserts "we did not narrow
 * coverage while centralizing" rather than assuming it.
 */
const PREVIOUS_LOGGER_PATHS: readonly string[] = [
  "sendgridKey",
  "*.sendgridKey",
  "*.*.sendgridKey",
  "apiKey",
  "*.apiKey",
  "*.*.apiKey",
  "password",
  "*.password",
  "*.*.password",
  "token",
  "*.token",
  "*.*.token",
];

/** Runs `payload` through a real Pino instance configured with PINO_REDACT_OPTIONS and returns the parsed JSON log line. */
function logViaPino(payload: Record<string, unknown>): Record<string, unknown> {
  const lines: string[] = [];
  const captureStream = {
    write(msg: string): boolean {
      lines.push(msg);
      return true;
    },
  };
  const logger = pino({ redact: PINO_REDACT_OPTIONS }, captureStream);
  logger.info(payload);
  return JSON.parse(lines[0]) as Record<string, unknown>;
}

describe("rules parity", () => {
  test("Test 8: a representative payload -- a decrypted provider key, a password, a token, a contact email, and a nested freeform properties object -- produces the same redacted field set through the compiled logger configuration and through scrub()", () => {
    const payload = {
      sendgridKey: "SG.aaaaaaaaaa.bbbbbbbbbb",
      password: "hunter2-not-a-real-password",
      token: "reset-token-abc123",
      contact: {
        email: "marketer@example.com",
      },
      properties: {
        orderId: "ord_123",
      },
    };

    const loggedViaPino = logViaPino(payload);
    const scrubbed = scrub(payload) as typeof payload;

    // Every key-rule-covered field: redacted identically by both forms.
    expect(loggedViaPino.sendgridKey).toBe(CENSOR);
    expect(scrubbed.sendgridKey).toBe(CENSOR);

    expect(loggedViaPino.password).toBe(CENSOR);
    expect(scrubbed.password).toBe(CENSOR);

    expect(loggedViaPino.token).toBe(CENSOR);
    expect(scrubbed.token).toBe(CENSOR);

    expect((loggedViaPino.contact as Record<string, unknown>).email).toBe(CENSOR);
    expect(scrubbed.contact.email).toBe(CENSOR);

    // The nested freeform properties object: neither form touches
    // non-matching content, and both leave it byte-identical.
    expect((loggedViaPino.properties as Record<string, unknown>).orderId).toBe("ord_123");
    expect(scrubbed.properties.orderId).toBe("ord_123");
  });

  test("Test 9: every field name the previous logger configuration redacted is still covered by the compiled path list (subset assertion -- coverage may only grow, never narrow)", () => {
    for (const path of PREVIOUS_LOGGER_PATHS) {
      expect(PINO_REDACT_OPTIONS.paths).toContain(path);
    }
  });

  test("Test 10: a sendgridKey nested four levels deep (three intermediate objects) is censored -- Pitfall 18's explicit depth-deepening instruction", () => {
    const payload = {
      a: {
        b: {
          c: {
            sendgridKey: "SG.aaaaaaaaaa.bbbbbbbbbb",
          },
        },
      },
    };

    const logged = logViaPino(payload);
    expect(
      (
        ((logged.a as Record<string, unknown>).b as Record<string, unknown>).c as Record<string, unknown>
      ).sendgridKey,
    ).toBe(CENSOR);
  });

  test("Test 11: an email nested five levels deep (four intermediate objects) is censored", () => {
    const payload = {
      a: {
        b: {
          c: {
            d: {
              email: "marketer@example.com",
            },
          },
        },
      },
    };

    const logged = logViaPino(payload);
    expect(
      (
        (
          (
            ((logged.a as Record<string, unknown>).b as Record<string, unknown>).c as Record<string, unknown>
          ).d as Record<string, unknown>
        ) as Record<string, unknown>
      ).email,
    ).toBe(CENSOR);
  });

  test("Test 12: the compiled path list has no duplicate entries and enumerates exactly five depths per key rule", () => {
    expect(new Set(PINO_REDACT_OPTIONS.paths).size).toBe(PINO_REDACT_OPTIONS.paths.length);
    expect(PINO_REDACT_OPTIONS.paths.length).toBe(REDACTION_RULES.keyRules.length * 5);
  });
});
