// Phase 16 plan 01 (UAT-01/UAT-02, D-13). Tests for scripts/uat-verify.mjs's
// exported pure helpers ONLY -- this repository's `scripts/` vitest lane has
// no database globalSetup (scripts/vitest.config.ts), so the CLI's
// database-touching path (the non-exported `runSendAttribution`) is
// deliberately NOT exercised here. Mirrors
// scripts/__tests__/check-spec-env-coverage.test.mjs's shape: pure exported
// helpers asserted directly against in-memory fixtures.

import { describe, expect, it } from "vitest";

import { assertExpectations, formatReport, parseArgs } from "../uat-verify.mjs";

describe("parseArgs", () => {
  it("rejects an invocation with no subcommand, naming the accepted set", () => {
    expect(() => parseArgs([])).toThrowError(/send-attribution/);
  });

  it("rejects an invocation with an unknown subcommand, naming the accepted set", () => {
    expect(() => parseArgs(["bogus-subcommand"])).toThrowError(/send-attribution/);
  });

  it("rejects a send-attribution invocation missing --workspace", () => {
    expect(() => parseArgs(["send-attribution", "--send-id", "abc"])).toThrowError(/--workspace/);
  });

  it("rejects a send-attribution invocation missing both --send-id and --message-id", () => {
    expect(() => parseArgs(["send-attribution", "--workspace", "ws-1"])).toThrowError(
      /--send-id|--message-id/,
    );
  });

  it("accepts --expect-events as a comma-separated list, yielding the event types as a list", () => {
    const parsed = parseArgs([
      "send-attribution",
      "--workspace",
      "ws-1",
      "--send-id",
      "send-1",
      "--expect-events",
      "delivered,opened",
    ]);
    expect(parsed.expectEvents).toEqual(["delivered", "opened"]);
  });

  it("accepts --message-id in place of --send-id", () => {
    const parsed = parseArgs(["send-attribution", "--workspace", "ws-1", "--message-id", "sg-msg-1"]);
    expect(parsed.sendId).toBeNull();
    expect(parsed.messageId).toBe("sg-msg-1");
  });
});

describe("assertExpectations", () => {
  it("fails when an expected event type is absent from the observed set", () => {
    const result = assertExpectations(
      {
        send: { id: "s1", status: "sent" },
        events: [{ eventType: "delivered", occurredAt: "2026-01-01T00:00:00Z" }],
      },
      { status: "sent", events: ["delivered", "opened"] },
    );
    expect(result.passed).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/opened/);
  });

  it("fails when zero send rows were observed, and its message says zero rows were observed rather than reporting success", () => {
    const result = assertExpectations({ send: null, events: [] }, { status: "sent", events: [] });
    expect(result.passed).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/zero/i);
  });

  it("fails when the observed send status differs from --expect-status", () => {
    const result = assertExpectations(
      { send: { id: "s1", status: "reconciling" }, events: [] },
      { status: "sent", events: [] },
    );
    expect(result.passed).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/status/i);
  });

  it("passes only when the send row exists, its status matches, and every expected event type is present", () => {
    const result = assertExpectations(
      {
        send: { id: "s1", status: "sent" },
        events: [{ eventType: "delivered", occurredAt: "2026-01-01T00:00:00Z" }],
      },
      { status: "sent", events: ["delivered"] },
    );
    expect(result.passed).toBe(true);
    expect(result.reasons).toEqual([]);
  });
});

describe("formatReport", () => {
  const observed = {
    send: { id: "s1", sgMessageId: "sg-1", status: "sent" },
    events: [{ eventType: "delivered", occurredAt: "2026-01-01T00:00:00Z", sgEventId: "evt-1" }],
  };

  it("renders the matched send id, the SendGrid message id, the send status, and one line per observed event with its type and occurred_at", () => {
    const text = formatReport(observed);
    expect(text).toContain("s1");
    expect(text).toContain("sg-1");
    expect(text).toContain("sent");
    expect(text).toContain("delivered");
    expect(text).toContain("2026-01-01T00:00:00Z");
  });

  it("under --json emits parseable JSON carrying the same fields", () => {
    const text = formatReport(observed, { json: true });
    const parsed = JSON.parse(text);
    expect(parsed.sendId).toBe("s1");
    expect(parsed.sgMessageId).toBe("sg-1");
    expect(parsed.status).toBe("sent");
    expect(parsed.events[0].eventType).toBe("delivered");
  });
});
