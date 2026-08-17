// Phase 16 plan 01 (UAT-01/UAT-02, D-13). Tests for scripts/uat-verify.mjs's
// exported pure helpers ONLY -- this repository's `scripts/` vitest lane has
// no database globalSetup (scripts/vitest.config.ts), so the CLI's
// database-touching path (the non-exported `runSendAttribution`) is
// deliberately NOT exercised here. Mirrors
// scripts/__tests__/check-spec-env-coverage.test.mjs's shape: pure exported
// helpers asserted directly against in-memory fixtures.

import { describe, expect, it } from "vitest";

import {
  assertExpectations,
  formatEventCoverageReport,
  formatReport,
  parseArgs,
  summariseEventCoverage,
} from "../uat-verify.mjs";

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

  it("lists event-coverage among the accepted subcommands when the subcommand is missing", () => {
    expect(() => parseArgs([])).toThrowError(/event-coverage/);
  });

  it("rejects an event-coverage invocation missing --workspace", () => {
    expect(() => parseArgs(["event-coverage"])).toThrowError(/--workspace/);
  });

  it("parses event-coverage's boolean flags without consuming the next token as their value", () => {
    const parsed = parseArgs([
      "event-coverage",
      "--workspace",
      "ws-1",
      "--require-campaign",
      "--require-flow-step",
      "--since",
      "2026-01-01T00:00:00Z",
    ]);
    expect(parsed.requireCampaign).toBe(true);
    expect(parsed.requireFlowStep).toBe(true);
    expect(parsed.since).toBe("2026-01-01T00:00:00Z");
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

// Phase 16 plan 02 (UAT-02): summariseEventCoverage/formatEventCoverageReport
// are the pure helpers behind the `event-coverage` subcommand -- exercised
// here with no database, same discipline as send-attribution's helpers
// above. Rows are shaped exactly like the query's mapped output:
// { eventType, occurredAt, sendId, campaignId, nodeId }.
describe("summariseEventCoverage", () => {
  const allFourRows = [
    { eventType: "delivered", occurredAt: "2026-01-01T00:00:00Z", sendId: "s1", campaignId: "camp-1", nodeId: null },
    { eventType: "open", occurredAt: "2026-01-01T00:01:00Z", sendId: "s1", campaignId: "camp-1", nodeId: null },
    { eventType: "click", occurredAt: "2026-01-01T00:02:00Z", sendId: "s1", campaignId: "camp-1", nodeId: null },
    { eventType: "bounce", occurredAt: "2026-01-01T00:03:00Z", sendId: "s2", campaignId: null, nodeId: null },
  ];

  it("returns a passing result with an empty missing list when rows cover all four expected types", () => {
    const result = summariseEventCoverage(allFourRows, {});
    expect(result.pass).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("returns a failing result naming exactly the one missing type when rows are missing it", () => {
    const rowsMissingBounce = allFourRows.filter((r) => r.eventType !== "bounce");
    const result = summariseEventCoverage(rowsMissingBounce, {});
    expect(result.pass).toBe(false);
    expect(result.missing).toEqual(["bounce"]);
  });

  it("returns a failing result naming all four types as missing when given zero rows, never a pass", () => {
    const result = summariseEventCoverage([], {});
    expect(result.pass).toBe(false);
    expect(result.missing).toEqual(["delivered", "open", "click", "bounce"]);
  });

  it("with requireCampaign, fails naming the unattributed send id when every observed send has a null campaign reference", () => {
    const rowsNoCampaign = allFourRows.map((r) => ({ ...r, campaignId: null }));
    const result = summariseEventCoverage(rowsNoCampaign, { requireCampaign: true });
    expect(result.pass).toBe(false);
    expect(result.unattributed.campaign).toEqual(expect.arrayContaining(["s1", "s2"]));
  });

  it("with requireFlowStep, fails naming the unattributed send id when every observed send has a null flow step reference", () => {
    const result = summariseEventCoverage(allFourRows, { requireFlowStep: true });
    expect(result.pass).toBe(false);
    expect(result.unattributed.flowStep).toEqual(expect.arrayContaining(["s1", "s2"]));
  });

  it("with both requireCampaign and requireFlowStep, passes only when at least one campaign-attributed send AND at least one flow-step-attributed send are present", () => {
    const rows = [
      { eventType: "delivered", occurredAt: "2026-01-01T00:00:00Z", sendId: "camp-send", campaignId: "camp-1", nodeId: null },
      { eventType: "open", occurredAt: "2026-01-01T00:01:00Z", sendId: "flow-send", campaignId: null, nodeId: "node-1" },
      { eventType: "click", occurredAt: "2026-01-01T00:02:00Z", sendId: "flow-send", campaignId: null, nodeId: "node-1" },
      { eventType: "bounce", occurredAt: "2026-01-01T00:03:00Z", sendId: "camp-send", campaignId: "camp-1", nodeId: null },
    ];
    const result = summariseEventCoverage(rows, { requireCampaign: true, requireFlowStep: true });
    expect(result.pass).toBe(true);
    expect(result.unattributed).toEqual({});
  });

  it("--since excludes rows whose occurred_at precedes the given instant", () => {
    const rowsWithOneStale = [
      { eventType: "delivered", occurredAt: "2025-01-01T00:00:00Z", sendId: "old-send", campaignId: null, nodeId: null },
      ...allFourRows,
    ];
    const result = summariseEventCoverage(rowsWithOneStale, { since: "2026-01-01T00:00:00Z" });
    expect(result.pass).toBe(true);
    expect(result.observed.find((o) => o.eventType === "delivered").sendId).not.toBe("old-send");
  });

  it("reports, per observed event type, the count and the send id it was attributed to", () => {
    const rows = [...allFourRows, { eventType: "delivered", occurredAt: "2026-01-01T00:04:00Z", sendId: "s3", campaignId: null, nodeId: null }];
    const result = summariseEventCoverage(rows, {});
    const delivered = result.observed.find((o) => o.eventType === "delivered");
    expect(delivered.count).toBe(2);
    expect(delivered.sendId).toBeDefined();
  });
});

describe("formatEventCoverageReport", () => {
  it("renders a line per observed event type with its count and attributed send id", () => {
    const result = {
      pass: true,
      observed: [{ eventType: "delivered", count: 1, sendId: "s1" }],
      missing: [],
      unattributed: {},
    };
    const text = formatEventCoverageReport(result);
    expect(text).toContain("delivered");
    expect(text).toContain("s1");
    expect(text).toContain("PASS");
  });

  it("under --json emits parseable JSON carrying the same fields", () => {
    const result = { pass: false, observed: [], missing: ["bounce"], unattributed: {} };
    const text = formatEventCoverageReport(result, { json: true });
    const parsed = JSON.parse(text);
    expect(parsed.pass).toBe(false);
    expect(parsed.missing).toEqual(["bounce"]);
  });
});
