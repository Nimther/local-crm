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
    const a = logged.a as Record<string, unknown>;
    const b = a.b as Record<string, unknown>;
    const c = b.c as Record<string, unknown>;
    expect(c.sendgridKey).toBe(CENSOR);
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
    const a = logged.a as Record<string, unknown>;
    const b = a.b as Record<string, unknown>;
    const c = b.c as Record<string, unknown>;
    const d = c.d as Record<string, unknown>;
    expect(d.email).toBe(CENSOR);
  });

  test("Test 12: the compiled path list has no duplicate entries and enumerates exactly five depths per key rule", () => {
    expect(new Set(PINO_REDACT_OPTIONS.paths).size).toBe(PINO_REDACT_OPTIONS.paths.length);
    expect(PINO_REDACT_OPTIONS.paths.length).toBe(REDACTION_RULES.keyRules.length * 5);
  });

  test("Test 13 (ROT-01, D-02): a payload carrying the unsubscribe signing-secret environment-variable field names -- at the root and nested two levels deep -- is censored identically by both compiled forms, and a non-secret sibling is untouched by both, so the new rules are targeted rather than blanket", () => {
    const payload = {
      UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS: "dummy-previous-secret-value,dummy-previous-secret-value-2",
      UNSUBSCRIBE_TOKEN_SECRET: "dummy-primary-secret-value",
      // Non-secret sibling: proves the new rules are targeted, not blanket.
      workspaceId: "b2cd545e-6853-418e-a436-2d4658232825",
      rotationContext: {
        details: {
          UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS: "dummy-previous-secret-value-nested",
        },
      },
    };

    const loggedViaPino = logViaPino(payload);
    const scrubbed = scrub(payload) as typeof payload;

    expect(loggedViaPino.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS).toBe(CENSOR);
    expect(scrubbed.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS).toBe(CENSOR);

    expect(loggedViaPino.UNSUBSCRIBE_TOKEN_SECRET).toBe(CENSOR);
    expect(scrubbed.UNSUBSCRIBE_TOKEN_SECRET).toBe(CENSOR);

    const loggedRotationContext = loggedViaPino.rotationContext as Record<string, unknown>;
    const loggedDetails = loggedRotationContext.details as Record<string, unknown>;
    expect(loggedDetails.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS).toBe(CENSOR);
    expect(scrubbed.rotationContext.details.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS).toBe(CENSOR);

    // Non-secret sibling: untouched by both forms.
    expect(loggedViaPino.workspaceId).toBe(payload.workspaceId);
    expect(scrubbed.workspaceId).toBe(payload.workspaceId);
  });

  test("Test 14 (ROT-01, D-02): a lower-cased spelling of the previous-secrets field name still redacts through scrub() -- scrub.ts lower-cases both the rule key and the incoming field name before comparing (KEY_RULE_NAMES.has(key.toLowerCase())), so the case-insensitive contract holds there; the Pino path list is a case-SENSITIVE literal-string match (fast-redact has no case-folding), which is a pre-existing structural limit of pino-redact.ts shared by every other rule in the table, not a gap this plan introduces", () => {
    const payload = {
      unsubscribe_token_secret_previous: "dummy-previous-secret-value-lowercase",
    };

    const scrubbed = scrub(payload) as typeof payload;
    expect(scrubbed.unsubscribe_token_secret_previous).toBe(CENSOR);
  });
});
