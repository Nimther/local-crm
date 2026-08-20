import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signUnsubscribeToken, verifyUnsubscribeToken } from "../unsubscribe-token.js";
import { logger } from "../logger.js";

/**
 * Unit-level rotation coverage for `verifyUnsubscribeToken`'s candidate loop
 * (ROT-02, T-19-01/02/03), deferred from 19-01 per the phase's Artifacts
 * table. This file is deliberately separate from `unsubscribe-token.test.ts`
 * so the `node:crypto` mock below stays scoped to this file only -- the
 * pre-existing suite keeps exercising the real primitives unmocked.
 *
 * `node:crypto` is mocked with `importOriginal` so the real HMAC and the
 * real timing-safe comparison still run underneath -- only the invocation
 * COUNT of `createHmac` is observed. A stubbed HMAC would make every
 * rotation assertion below vacuous (nothing would actually verify).
 */
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    createHmac: vi.fn(actual.createHmac),
  };
});

/**
 * The sibling package-local pino logger is mocked because it is silent
 * under `NODE_ENV=test` (see `packages/delivery-core/src/logger.ts`) --
 * output capture is not viable, so the D-05 assertions below observe the
 * mocked `info` call directly instead.
 */
vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
  },
}));

// Every secret literal below is well over 32 bytes and contains no comma or
// whitespace (D-03's charset contract) -- constructed via repeat() so the
// length requirement is visibly satisfied rather than eyeballed.
const PRIMARY_SECRET = `unit-rotation-primary-secret-${"a".repeat(20)}`;
const PREVIOUS_SECRET_1 = `unit-rotation-previous-secret-one-${"b".repeat(20)}`;
const PREVIOUS_SECRET_2 = `unit-rotation-previous-secret-two-${"c".repeat(20)}`;
const UNLISTED_SECRET = `unit-rotation-unlisted-secret-${"d".repeat(20)}`;

function samplePayload() {
  return {
    sendId: "11111111-1111-1111-1111-111111111111",
    contactId: "22222222-2222-2222-2222-222222222222",
    workspaceId: "33333333-3333-3333-3333-333333333333",
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
}

function forgeFrom(token: string): string {
  const [encodedPayload] = token.split(".");
  const forgedSignature = Buffer.from("not-the-real-signature-at-all").toString("base64url");
  return `${encodedPayload}.${forgedSignature}`;
}

let originalPrimary: string | undefined;
let originalPrevious: string | undefined;

beforeEach(() => {
  originalPrimary = process.env.UNSUBSCRIBE_TOKEN_SECRET;
  originalPrevious = process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS;
  process.env.PUBLIC_APP_URL = "https://api.example.com";
});

afterEach(() => {
  if (originalPrimary === undefined) {
    delete process.env.UNSUBSCRIBE_TOKEN_SECRET;
  } else {
    process.env.UNSUBSCRIBE_TOKEN_SECRET = originalPrimary;
  }
  if (originalPrevious === undefined) {
    delete process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS;
  } else {
    process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS = originalPrevious;
  }
  vi.mocked(createHmac).mockClear();
  vi.mocked(logger.info).mockClear();
});

// ROT-02/D-01/D-02: rotation semantics -- a previous-secret-signed token
// verifies through the fallback list, list order is genuinely traversed
// (not just the first previous entry), an unretained secret still fails,
// and D-01 parity holds when the previous-secrets variable is absent or empty.
describe("verifyUnsubscribeToken rotation semantics (ROT-02, D-01, D-02)", () => {
  it("verifies a token signed by a retired primary once it moves into the previous list", () => {
    process.env.UNSUBSCRIBE_TOKEN_SECRET = PRIMARY_SECRET;
    delete process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS;
    const payload = samplePayload();
    const token = signUnsubscribeToken(payload);

    process.env.UNSUBSCRIBE_TOKEN_SECRET = PREVIOUS_SECRET_1;
    process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS = PRIMARY_SECRET;

    expect(verifyUnsubscribeToken(token)).toEqual(payload);
  });

  it("traverses the full previous list -- a match at list position 2 (not just the first entry) still verifies", () => {
    process.env.UNSUBSCRIBE_TOKEN_SECRET = PREVIOUS_SECRET_1;
    delete process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS;
    const payload = samplePayload();
    const token = signUnsubscribeToken(payload);

    // Candidates become [primary, PREVIOUS_SECRET_2, PREVIOUS_SECRET_1] --
    // the signing secret sits at index 2, proving the loop does not stop
    // after the first previous entry.
    process.env.UNSUBSCRIBE_TOKEN_SECRET = PRIMARY_SECRET;
    process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS = `${PREVIOUS_SECRET_2},${PREVIOUS_SECRET_1}`;

    expect(verifyUnsubscribeToken(token)).toEqual(payload);
  });

  it("returns null when the signing secret is neither the primary nor anywhere in the previous list", () => {
    process.env.UNSUBSCRIBE_TOKEN_SECRET = UNLISTED_SECRET;
    delete process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS;
    const token = signUnsubscribeToken(samplePayload());

    process.env.UNSUBSCRIBE_TOKEN_SECRET = PRIMARY_SECRET;
    process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS = `${PREVIOUS_SECRET_1},${PREVIOUS_SECRET_2}`;

    expect(verifyUnsubscribeToken(token)).toBeNull();
  });

  it("D-01 parity: with the previous-secrets variable absent, pre-rotation single-secret behaviour is unchanged", () => {
    process.env.UNSUBSCRIBE_TOKEN_SECRET = PRIMARY_SECRET;
    delete process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS;

    const payload = samplePayload();
    const token = signUnsubscribeToken(payload);
    expect(verifyUnsubscribeToken(token)).toEqual(payload);

    const [, signature] = token.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({ ...payload, contactId: "44444444-4444-4444-4444-444444444444" })
    ).toString("base64url");
    expect(verifyUnsubscribeToken(`${tamperedPayload}.${signature}`)).toBeNull();

    expect(verifyUnsubscribeToken(forgeFrom(token))).toBeNull();
  });

  it("an empty-string previous-secrets value behaves exactly as an absent one", () => {
    process.env.UNSUBSCRIBE_TOKEN_SECRET = PRIMARY_SECRET;
    delete process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS;
    const token = signUnsubscribeToken(samplePayload());

    process.env.UNSUBSCRIBE_TOKEN_SECRET = PREVIOUS_SECRET_1;
    process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS = "";

    // PRIMARY_SECRET's token no longer verifies once the primary rotates to
    // PREVIOUS_SECRET_1 and the previous list is the empty string -- same
    // outcome as when the variable is absent entirely.
    expect(verifyUnsubscribeToken(token)).toBeNull();
  });
});

// ROT-02/SC3, RESEARCH Pitfall 2: the candidate loop must evaluate every
// candidate regardless of where (or whether) a match occurs, so total loop
// work is a pure function of candidate count -- this is what keeps the HTTP
// response byte-identical no matter which secret (if any) matched. A
// plausible future "optimisation" (breaking on the first match) is exactly
// the regression this gate exists to catch.
describe("verifyUnsubscribeToken exhaustive evaluation (ROT-02/SC3, T-19-01/02)", () => {
  it("invokes the HMAC primitive once per candidate, and the count is identical for a primary match, a last-previous match, and no match", () => {
    process.env.UNSUBSCRIBE_TOKEN_SECRET = PRIMARY_SECRET;
    delete process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS;
    const tokenViaPrimary = signUnsubscribeToken(samplePayload());

    process.env.UNSUBSCRIBE_TOKEN_SECRET = PREVIOUS_SECRET_2;
    const tokenViaLastPrevious = signUnsubscribeToken(samplePayload());

    // Post-rotation env: 3 total candidates (primary + 2 previous).
    process.env.UNSUBSCRIBE_TOKEN_SECRET = PRIMARY_SECRET;
    process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS = `${PREVIOUS_SECRET_1},${PREVIOUS_SECRET_2}`;
    const candidateCount = 3;

    const hmacSpy = vi.mocked(createHmac);

    hmacSpy.mockClear();
    expect(verifyUnsubscribeToken(tokenViaPrimary)).not.toBeNull();
    const countPrimaryMatch = hmacSpy.mock.calls.length;

    hmacSpy.mockClear();
    expect(verifyUnsubscribeToken(tokenViaLastPrevious)).not.toBeNull();
    const countLastPreviousMatch = hmacSpy.mock.calls.length;

    hmacSpy.mockClear();
    expect(verifyUnsubscribeToken(forgeFrom(tokenViaPrimary))).toBeNull();
    const countNoMatch = hmacSpy.mock.calls.length;

    expect(countPrimaryMatch).toBe(candidateCount);
    expect(countLastPreviousMatch).toBe(candidateCount);
    expect(countNoMatch).toBe(candidateCount);
  });
});

// D-05: on a successful verification via a non-primary secret,
// verifyUnsubscribeToken emits exactly one structured log line carrying the
// matched list position and no secret material; a primary match emits none.
// This logger deliberately bypasses `packages/redaction`, so the "no secret
// material" property is asserted directly here rather than relying on a
// shared redaction gate.
describe("verifyUnsubscribeToken D-05 log shape", () => {
  it("emits zero log calls when the primary secret matches", () => {
    process.env.UNSUBSCRIBE_TOKEN_SECRET = PRIMARY_SECRET;
    process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS = `${PREVIOUS_SECRET_1},${PREVIOUS_SECRET_2}`;
    const token = signUnsubscribeToken(samplePayload());

    expect(verifyUnsubscribeToken(token)).not.toBeNull();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("emits exactly one log call carrying position 1 for a match at previous list position 1", () => {
    process.env.UNSUBSCRIBE_TOKEN_SECRET = PREVIOUS_SECRET_1;
    delete process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS;
    const token = signUnsubscribeToken(samplePayload());

    process.env.UNSUBSCRIBE_TOKEN_SECRET = PRIMARY_SECRET;
    process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS = PREVIOUS_SECRET_1;

    expect(verifyUnsubscribeToken(token)).not.toBeNull();
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.info).mock.calls[0]?.[0]).toMatchObject({ secretPosition: 1 });
  });

  it("emits exactly one log call carrying position 2 for a match at previous list position 2", () => {
    process.env.UNSUBSCRIBE_TOKEN_SECRET = PREVIOUS_SECRET_2;
    delete process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS;
    const token = signUnsubscribeToken(samplePayload());

    process.env.UNSUBSCRIBE_TOKEN_SECRET = PRIMARY_SECRET;
    process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS = `${PREVIOUS_SECRET_1},${PREVIOUS_SECRET_2}`;

    expect(verifyUnsubscribeToken(token)).not.toBeNull();
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.info).mock.calls[0]?.[0]).toMatchObject({ secretPosition: 2 });
  });

  it("emits zero log calls when nothing matches", () => {
    process.env.UNSUBSCRIBE_TOKEN_SECRET = UNLISTED_SECRET;
    delete process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS;
    const token = signUnsubscribeToken(samplePayload());

    process.env.UNSUBSCRIBE_TOKEN_SECRET = PRIMARY_SECRET;
    process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS = `${PREVIOUS_SECRET_1},${PREVIOUS_SECRET_2}`;

    expect(verifyUnsubscribeToken(token)).toBeNull();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("the serialised log argument and message contain none of the secret values and no substring of the token signature", () => {
    process.env.UNSUBSCRIBE_TOKEN_SECRET = PREVIOUS_SECRET_1;
    delete process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS;
    const token = signUnsubscribeToken(samplePayload());
    const [, signature] = token.split(".");

    process.env.UNSUBSCRIBE_TOKEN_SECRET = PRIMARY_SECRET;
    process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS = `${PREVIOUS_SECRET_1},${PREVIOUS_SECRET_2}`;

    expect(verifyUnsubscribeToken(token)).not.toBeNull();

    const call = vi.mocked(logger.info).mock.calls[0];
    expect(call).toBeDefined();
    const [logArg, logMessage] = call as [unknown, string];
    const serialised = `${JSON.stringify(logArg)} ${logMessage}`;

    for (const secret of [PRIMARY_SECRET, PREVIOUS_SECRET_1, PREVIOUS_SECRET_2, UNLISTED_SECRET]) {
      expect(serialised).not.toContain(secret);
    }
    expect(serialised).not.toContain(signature);
  });
});
