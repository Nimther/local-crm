import { afterEach, describe, expect, it } from "vitest";
import { assertUnsubscribeTokenSecrets } from "../server.js";

/**
 * 19-02 (ROT-01, D-02, D-03, D-07): the worker's boot-time gate for both
 * `UNSUBSCRIBE_TOKEN_SECRET` and `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` --
 * factored out of `buildWorker()` (same testability reasoning as
 * `logSendgridBaseUrlOverrideIfActive`, see `sendgrid-base-url-boot-log.test.ts`)
 * so this can be exercised directly without constructing all twenty
 * production BullMQ workers. Mirrors `apps/api/src/env.ts`'s superRefine
 * contract, independently hard-coded per the codebase's triplication
 * convention.
 */
describe("assertUnsubscribeTokenSecrets (19-02, ROT-01/D-02/D-03/D-07)", () => {
  const originalPrimary = process.env.UNSUBSCRIBE_TOKEN_SECRET;
  const originalPrevious = process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS;

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
  });

  it("primary set to a valid 40-char secret, previous unset -- does not throw", () => {
    process.env.UNSUBSCRIBE_TOKEN_SECRET = "a".repeat(40);
    delete process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS;
    expect(() => assertUnsubscribeTokenSecrets()).not.toThrow();
  });

  it("primary unset -- throws, message names UNSUBSCRIBE_TOKEN_SECRET", () => {
    delete process.env.UNSUBSCRIBE_TOKEN_SECRET;
    delete process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS;
    expect(() => assertUnsubscribeTokenSecrets()).toThrow(/UNSUBSCRIBE_TOKEN_SECRET/);
  });

  it("primary 31 chars -- throws", () => {
    process.env.UNSUBSCRIBE_TOKEN_SECRET = "a".repeat(31);
    delete process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS;
    expect(() => assertUnsubscribeTokenSecrets()).toThrow();
  });

  it("primary containing a space -- throws, message names the charset rule", () => {
    process.env.UNSUBSCRIBE_TOKEN_SECRET = `${"a".repeat(20)} ${"a".repeat(19)}`;
    delete process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS;
    expect(() => assertUnsubscribeTokenSecrets()).toThrow(/comma or whitespace/);
  });

  it("primary containing a comma -- throws, message names the charset rule", () => {
    process.env.UNSUBSCRIBE_TOKEN_SECRET = `${"a".repeat(20)},${"a".repeat(19)}`;
    delete process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS;
    expect(() => assertUnsubscribeTokenSecrets()).toThrow(/comma or whitespace/);
  });

  it("previous set to one valid entry -- does not throw", () => {
    process.env.UNSUBSCRIBE_TOKEN_SECRET = "a".repeat(40);
    process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS = "b".repeat(32);
    expect(() => assertUnsubscribeTokenSecrets()).not.toThrow();
  });

  it("previous set to five valid entries -- does not throw", () => {
    process.env.UNSUBSCRIBE_TOKEN_SECRET = "a".repeat(40);
    const entries = Array.from({ length: 5 }, (_, i) => String.fromCharCode(98 + i).repeat(32));
    process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS = entries.join(",");
    expect(() => assertUnsubscribeTokenSecrets()).not.toThrow();
  });

  it("previous set to six entries -- throws, message names the maximum", () => {
    process.env.UNSUBSCRIBE_TOKEN_SECRET = "a".repeat(40);
    const entries = Array.from({ length: 6 }, (_, i) => String.fromCharCode(98 + i).repeat(32));
    process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS = entries.join(",");
    expect(() => assertUnsubscribeTokenSecrets()).toThrow(/5/);
  });

  it("previous containing a 31-character entry -- throws", () => {
    process.env.UNSUBSCRIBE_TOKEN_SECRET = "a".repeat(40);
    process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS = "b".repeat(31);
    expect(() => assertUnsubscribeTokenSecrets()).toThrow();
  });

  it("previous with a trailing comma (empty entry) -- throws", () => {
    process.env.UNSUBSCRIBE_TOKEN_SECRET = "a".repeat(40);
    process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS = `${"b".repeat(32)},`;
    expect(() => assertUnsubscribeTokenSecrets()).toThrow();
  });

  it("previous containing an entry equal to the primary -- throws", () => {
    process.env.UNSUBSCRIBE_TOKEN_SECRET = "a".repeat(40);
    process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS = "a".repeat(40);
    expect(() => assertUnsubscribeTokenSecrets()).toThrow();
  });

  it("previous containing two identical entries -- throws", () => {
    process.env.UNSUBSCRIBE_TOKEN_SECRET = "a".repeat(40);
    process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS = `${"b".repeat(32)},${"b".repeat(32)}`;
    expect(() => assertUnsubscribeTokenSecrets()).toThrow();
  });

  it("previous containing whitespace -- throws", () => {
    process.env.UNSUBSCRIBE_TOKEN_SECRET = "a".repeat(40);
    process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS = `${"b".repeat(15)} ${"b".repeat(16)}`;
    expect(() => assertUnsubscribeTokenSecrets()).toThrow();
  });

  it("no thrown message contains any of the secret values used in the test", () => {
    const primary = "P".repeat(40);
    const previousEntry = "Q".repeat(32);
    process.env.UNSUBSCRIBE_TOKEN_SECRET = primary;
    process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS = `${previousEntry},${previousEntry}`;
    try {
      assertUnsubscribeTokenSecrets();
      throw new Error("expected assertUnsubscribeTokenSecrets to throw");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(primary);
      expect(message).not.toContain(previousEntry);
    }
  });
});
