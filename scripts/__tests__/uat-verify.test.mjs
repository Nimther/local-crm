// Phase 16 plan 01 (UAT-01/UAT-02, D-13). Tests for scripts/uat-verify.mjs's
// exported pure helpers ONLY -- this repository's `scripts/` vitest lane has
// no database globalSetup (scripts/vitest.config.ts), so the CLI's
// database-touching path (the non-exported `runSendAttribution`) is
// deliberately NOT exercised here. Mirrors
// scripts/__tests__/check-spec-env-coverage.test.mjs's shape: pure exported
// helpers asserted directly against in-memory fixtures.
//
// EXCEPTION (Phase 16 plan 04, the "dedup CLI: usage error on a bad snapshot
// file" describe block near the bottom of this file): that one behavior is a
// runtime-only usage error `parseArgs` itself cannot detect (a well-formed
// `--snapshot <path>` that points at a missing/corrupt file) and is
// deliberately exercised as a real subprocess, mirroring
// scripts/__tests__/deploy-script.test.mjs's own CLI-subprocess convention --
// it needs no database (the snapshot-file read happens before any
// DATABASE_URL check inside `runDedup`), so it stays consistent with this
// file's "no database globalSetup" constraint while still covering the one
// behavior that lives in the CLI path, not in a pure exported helper.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  assertExpectations,
  compareDedupSnapshot,
  formatEventCoverageReport,
  formatReport,
  parseArgs,
  summariseEventCoverage,
} from "../uat-verify.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const UAT_VERIFY_SCRIPT = path.join(REPO_ROOT, "scripts/uat-verify.mjs");

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

  // Phase 16 plan 04 (UAT-03/UAT-04): the `dedup` subcommand's own required
  // flags -- lists it among the accepted set and rejects every missing
  // required flag with a usage error (exit 2 at the CLI layer).
  it("lists dedup among the accepted subcommands when the subcommand is missing", () => {
    expect(() => parseArgs([])).toThrowError(/dedup/);
  });

  it("rejects a dedup invocation missing --workspace", () => {
    expect(() =>
      parseArgs(["dedup", "--mode", "snapshot", "--snapshot", "/tmp/x.json"]),
    ).toThrowError(/--workspace/);
  });

  it("rejects a dedup invocation missing --mode, or with an invalid --mode value", () => {
    expect(() => parseArgs(["dedup", "--workspace", "ws-1", "--snapshot", "/tmp/x.json"])).toThrowError(
      /--mode/,
    );
    expect(() =>
      parseArgs(["dedup", "--workspace", "ws-1", "--mode", "bogus", "--snapshot", "/tmp/x.json"]),
    ).toThrowError(/--mode/);
  });

  it("rejects a dedup --mode compare invocation missing --snapshot", () => {
    expect(() => parseArgs(["dedup", "--workspace", "ws-1", "--mode", "compare"])).toThrowError(
      /--snapshot/,
    );
  });

  it("rejects a dedup invocation missing --send-id, --event-type or --occurred-at", () => {
    expect(() =>
      parseArgs(["dedup", "--workspace", "ws-1", "--mode", "snapshot", "--snapshot", "/tmp/x.json"]),
    ).toThrowError(/--send-id/);
    expect(() =>
      parseArgs([
        "dedup",
        "--workspace",
        "ws-1",
        "--mode",
        "snapshot",
        "--snapshot",
        "/tmp/x.json",
        "--send-id",
        "send-1",
      ]),
    ).toThrowError(/--event-type/);
    expect(() =>
      parseArgs([
        "dedup",
        "--workspace",
        "ws-1",
        "--mode",
        "snapshot",
        "--snapshot",
        "/tmp/x.json",
        "--send-id",
        "send-1",
        "--event-type",
        "delivered",
      ]),
    ).toThrowError(/--occurred-at/);
  });

  it("accepts a well-formed dedup invocation, parsing every flag", () => {
    const parsed = parseArgs([
      "dedup",
      "--workspace",
      "ws-1",
      "--mode",
      "compare",
      "--snapshot",
      "/tmp/dedup-snapshot.json",
      "--send-id",
      "send-1",
      "--event-type",
      "delivered",
      "--occurred-at",
      "2026-01-01T00:00:00Z",
      "--json",
    ]);
    expect(parsed).toEqual({
      subcommand: "dedup",
      workspace: "ws-1",
      mode: "compare",
      snapshotPath: "/tmp/dedup-snapshot.json",
      sendId: "send-1",
      eventType: "delivered",
      occurredAt: "2026-01-01T00:00:00Z",
      json: true,
    });
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

// Phase 16 plan 04 (UAT-03/UAT-04, D-12): compareDedupSnapshot is the pure
// two-layer exactly-once assertion behind the `dedup` subcommand -- exercised
// here with no database, same discipline as summariseEventCoverage above.
// Snapshot shape mirrors collectDedupSnapshot's real return value:
// { workspaceId, sendId, eventType, occurredAt, sendEventsCount,
//   ingressJournalCount, campaignId, rollup: {...} | null,
//   campaignCounters: {...} | null, capturedAt }.
describe("compareDedupSnapshot", () => {
  const baseRollup = {
    sentCount: 5,
    deliveredCount: 4,
    openedCount: 2,
    clickedCount: 1,
    bouncedCount: 1,
    unsubscribedCount: 0,
  };
  const baseCampaignCounters = {
    sentCount: 5,
    failedCount: 0,
    deliveredCount: 4,
    openedCount: 2,
    clickedCount: 1,
    bouncedCount: 1,
    unsubscribedCount: 0,
  };

  function makeSnapshot(overrides = {}) {
    return {
      workspaceId: "ws-1",
      sendId: "send-1",
      eventType: "delivered",
      occurredAt: "2026-01-01T00:00:00Z",
      sendEventsCount: 1,
      ingressJournalCount: 10,
      campaignId: "camp-1",
      rollup: { ...baseRollup },
      campaignCounters: { ...baseCampaignCounters },
      capturedAt: "2026-01-01T00:05:00Z",
      ...overrides,
    };
  }

  it("passes when send_events count is 1, the journal count increased by exactly 1, and every rollup/counter is unchanged", () => {
    const before = makeSnapshot({ ingressJournalCount: 10 });
    const after = makeSnapshot({ ingressJournalCount: 11 });
    const result = compareDedupSnapshot(before, after);
    expect(result.passed).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("fails when the send_events count is 2, naming duplicate rows as the cause", () => {
    const before = makeSnapshot({ ingressJournalCount: 10 });
    const after = makeSnapshot({ ingressJournalCount: 11, sendEventsCount: 2 });
    const result = compareDedupSnapshot(before, after);
    expect(result.passed).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/duplicate/i);
  });

  it("fails when the send_events count is 0, naming the absent row rather than reporting success", () => {
    const before = makeSnapshot({ ingressJournalCount: 10 });
    const after = makeSnapshot({ ingressJournalCount: 11, sendEventsCount: 0 });
    const result = compareDedupSnapshot(before, after);
    expect(result.passed).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/absent/i);
  });

  it("passes when the journal count increased by exactly 1 -- an increase is expected, not a failure", () => {
    const before = makeSnapshot({ ingressJournalCount: 3 });
    const after = makeSnapshot({ ingressJournalCount: 4 });
    const result = compareDedupSnapshot(before, after);
    expect(result.passed).toBe(true);
  });

  it("fails when the journal count did not increase at all, because the replay was never ingested", () => {
    const before = makeSnapshot({ ingressJournalCount: 10 });
    const after = makeSnapshot({ ingressJournalCount: 10 });
    const result = compareDedupSnapshot(before, after);
    expect(result.passed).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/never ingested/i);
  });

  it("fails when the journal count increased by more than 1, naming both numbers rather than silently accepting any increase", () => {
    const before = makeSnapshot({ ingressJournalCount: 10 });
    const after = makeSnapshot({ ingressJournalCount: 12 });
    const result = compareDedupSnapshot(before, after);
    expect(result.passed).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/10/);
    expect(result.reasons.join(" ")).toMatch(/12/);
  });

  it("fails when any rollup counter changed, naming the changed field and both values", () => {
    const before = makeSnapshot({ ingressJournalCount: 10 });
    const after = makeSnapshot({
      ingressJournalCount: 11,
      rollup: { ...baseRollup, deliveredCount: 5 },
    });
    const result = compareDedupSnapshot(before, after);
    expect(result.passed).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/deliveredCount/);
    expect(result.reasons.join(" ")).toMatch(/4/);
    expect(result.reasons.join(" ")).toMatch(/5/);
  });

  it("fails when any campaign counter changed, naming the changed field and both values", () => {
    const before = makeSnapshot({ ingressJournalCount: 10 });
    const after = makeSnapshot({
      ingressJournalCount: 11,
      campaignCounters: { ...baseCampaignCounters, bouncedCount: 2 },
    });
    const result = compareDedupSnapshot(before, after);
    expect(result.passed).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/bouncedCount/);
  });

  it("passes when a send carries no campaign (a flow-step send) and both rollup/campaignCounters are null on both sides", () => {
    const before = makeSnapshot({ ingressJournalCount: 10, campaignId: null, campaignCounters: null });
    const after = makeSnapshot({ ingressJournalCount: 11, campaignId: null, campaignCounters: null });
    const result = compareDedupSnapshot(before, after);
    expect(result.passed).toBe(true);
  });
});

// Phase 16 plan 04: the dedup-key query itself (four columns, migration 0057
// named as its source) is a static source-text assertion, not a behavior
// unit test -- the query cannot run without a database, but its shape and
// provenance comment are load-bearing and checkable directly.
describe("dedup-key query provenance (static source check)", () => {
  it("filters send_events on exactly the four dedup-key columns and cites migration 0057 as its source", () => {
    const source = readSourceFile();
    expect(source).toMatch(/send_events_dedup_v2_idx/);
    expect(source).toMatch(/migration 0057/);
    expect(source).toMatch(
      /WHERE workspace_id = \$1\s+AND send_id = \$2\s+AND event_type = \$3\s+AND occurred_at = \$4/,
    );
  });

  function readSourceFile() {
    return readFileSync(UAT_VERIFY_SCRIPT, "utf8");
  }
});

// Phase 16 plan 04: the one dedup CLI behavior that lives in the CLI path,
// not in a pure exported helper -- see this file's header EXCEPTION note.
describe("dedup CLI: usage error on a bad snapshot file", () => {
  const DEDUP_BASE_ARGS = [
    "dedup",
    "--workspace",
    "11111111-1111-1111-1111-111111111111",
    "--send-id",
    "22222222-2222-2222-2222-222222222222",
    "--event-type",
    "delivered",
    "--occurred-at",
    "2026-01-01T00:00:00Z",
    "--mode",
    "compare",
  ];

  function runDedupCli(extraArgs) {
    try {
      const stdout = execFileSync("node", [UAT_VERIFY_SCRIPT, ...DEDUP_BASE_ARGS, ...extraArgs], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });
      return { exitCode: 0, stdout, stderr: "" };
    } catch (err) {
      return { exitCode: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
  }

  it("a missing snapshot file exits with the usage error code (2), never a pass", () => {
    const run = runDedupCli(["--snapshot", "/tmp/definitely-does-not-exist-uat16-dedup.json"]);
    expect(run.exitCode).toBe(2);
  });

  it("an unparseable snapshot file (invalid JSON) exits with the usage error code (2), never a pass", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "uat16-dedup-test-"));
    const badSnapshotPath = path.join(dir, "bad-snapshot.json");
    writeFileSync(badSnapshotPath, "this is not valid json{{{");
    const run = runDedupCli(["--snapshot", badSnapshotPath]);
    expect(run.exitCode).toBe(2);
  });
});
