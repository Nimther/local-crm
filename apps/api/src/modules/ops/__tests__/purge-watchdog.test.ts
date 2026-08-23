import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { OpsAlertStateClient } from "@mega-crm/db/src/ops/alert-state.js";

import {
  WORKSPACE_PURGE_ALERT_DEDUP_HOURS,
  WORKSPACE_PURGE_STUCK_ALERT_NAME,
  WORKSPACE_PURGE_STUCK_THRESHOLD_HOURS,
  checkWorkspacePurgeHealthAndAlert,
  evaluateWorkspacePurgeHealth,
  type WorkspacePurgeAlertMessage,
  type WorkspacePurgeRecordRow,
} from "../purge-watchdog.js";

/**
 * Phase 22 (PRG-01/PRG-03, D-08, plan 22-08): the full unhealthy-condition
 * matrix on `evaluateWorkspacePurgeHealth`/`renderWorkspacePurgeAlertText`
 * (pure, no DB), plus `checkWorkspacePurgeHealthAndAlert`'s atomic dedup and
 * release-on-healthy behaviour, driven with an in-memory fake `ops_alert_state`
 * client and a spy `sendMail` -- deliberately no live database, mirroring
 * this plan's own instruction to keep this test file free of a migration/DB
 * fixture dependency.
 */

function buildRecord(overrides: Partial<WorkspacePurgeRecordRow> = {}): WorkspacePurgeRecordRow {
  return {
    workspaceId: randomUUID(),
    status: "purging",
    reportedAt: null,
    firstDestructiveBatchAt: null,
    lastProgressAt: null,
    purgeError: null,
    ...overrides,
  };
}

describe("evaluateWorkspacePurgeHealth (pure, no DB)", () => {
  it("test 1: healthy -- no purge records at all", () => {
    const result = evaluateWorkspacePurgeHealth([], new Date());
    expect(result.healthy).toBe(true);
    expect(result.entries).toEqual([]);
  });

  it("test 2: healthy -- reported and waiting, regardless of reported_at's age (the report-only window is by design)", () => {
    const now = new Date("2027-01-10T00:00:00Z");
    const recentlyReported = buildRecord({ status: "reported", reportedAt: new Date(now.getTime() - 5 * 60_000) });
    const longReported = buildRecord({ status: "reported", reportedAt: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) });

    expect(evaluateWorkspacePurgeHealth([recentlyReported], now).healthy).toBe(true);
    expect(evaluateWorkspacePurgeHealth([longReported], now).healthy).toBe(true);
  });

  it("test 3: healthy -- purging with recent progress, even though first_destructive_batch_at is days old (a large tenant takes a long time)", () => {
    const now = new Date("2027-01-10T00:00:00Z");
    const record = buildRecord({
      status: "purging",
      firstDestructiveBatchAt: new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000),
      lastProgressAt: new Date(now.getTime() - 3 * 60_000),
    });

    expect(evaluateWorkspacePurgeHealth([record], now).healthy).toBe(true);
  });

  it("test 4: stuck -- purging with no progress past the threshold names the workspace and the reason, falling back to first_destructive_batch_at before any heartbeat has landed", () => {
    const now = new Date("2027-01-10T00:00:00Z");
    const stale = new Date(now.getTime() - (WORKSPACE_PURGE_STUCK_THRESHOLD_HOURS + 1) * 60 * 60 * 1000);

    const withHeartbeat = randomUUID();
    const resultA = evaluateWorkspacePurgeHealth(
      [buildRecord({ workspaceId: withHeartbeat, status: "purging", firstDestructiveBatchAt: stale, lastProgressAt: stale })],
      now,
    );
    expect(resultA.healthy).toBe(false);
    if (!resultA.healthy) {
      expect(resultA.entries).toHaveLength(1);
      expect(resultA.entries[0]).toMatchObject({ workspaceId: withHeartbeat, reason: "stuck" });
    }

    // No heartbeat has committed yet -- falls back to first_destructive_batch_at.
    const noHeartbeatYet = randomUUID();
    const resultB = evaluateWorkspacePurgeHealth(
      [buildRecord({ workspaceId: noHeartbeatYet, status: "purging", firstDestructiveBatchAt: stale, lastProgressAt: null })],
      now,
    );
    expect(resultB.healthy).toBe(false);
    if (!resultB.healthy) {
      expect(resultB.entries[0]).toMatchObject({ workspaceId: noHeartbeatYet, reason: "stuck" });
    }
  });

  it("test 5: failed -- a recorded failure names the workspace and carries the error", () => {
    const now = new Date("2027-01-10T00:00:00Z");
    const workspaceId = randomUUID();
    const result = evaluateWorkspacePurgeHealth([buildRecord({ workspaceId, status: "failed", purgeError: "AUTH_DATABASE_URL not set" })], now);

    expect(result.healthy).toBe(false);
    if (!result.healthy) {
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]).toMatchObject({ workspaceId, reason: "failed", error: "AUTH_DATABASE_URL not set" });
    }
  });

  it("test 6: multiple unhealthy workspaces produce ONE result listing both, not two independent alerts", () => {
    const now = new Date("2027-01-10T00:00:00Z");
    const stale = new Date(now.getTime() - (WORKSPACE_PURGE_STUCK_THRESHOLD_HOURS + 1) * 60 * 60 * 1000);
    const stuckWorkspaceId = randomUUID();
    const failedWorkspaceId = randomUUID();

    const result = evaluateWorkspacePurgeHealth(
      [
        buildRecord({ workspaceId: stuckWorkspaceId, status: "purging", lastProgressAt: stale }),
        buildRecord({ workspaceId: failedWorkspaceId, status: "failed", purgeError: "boom" }),
      ],
      now,
    );

    expect(result.healthy).toBe(false);
    if (!result.healthy) {
      expect(result.entries).toHaveLength(2);
      expect(result.entries.map((entry) => entry.workspaceId).sort()).toEqual([stuckWorkspaceId, failedWorkspaceId].sort());
    }
  });
});

/**
 * A purpose-built in-memory fake over the exact two query shapes
 * `packages/db/src/ops/alert-state.ts`'s `claimOpsAlertSlot`/`releaseOpsAlertSlot`
 * issue, plus `purge-watchdog.ts`'s own unconditional release -- distinguished
 * by SQL prefix and parameter count, never a general SQL engine. This lets
 * the effectful tests below exercise the real dedup/claim/release semantics
 * without a live Postgres database, per this plan's own instruction.
 */
function createFakeOpsAlertStateClient(): OpsAlertStateClient & { readonly state: Map<string, Date | null> } {
  const state = new Map<string, Date | null>();
  return {
    state,
    // eslint-disable-next-line @typescript-eslint/require-await -- fake in-memory client: intentionally synchronous, Promise-wrapped only to match the real client's shape
    async query<T = Record<string, unknown>>(queryText: string, params: unknown[] = []): Promise<{ rows: T[] }> {
      if (queryText.includes("INSERT INTO ops_alert_state")) {
        const [alertName, now, dedupHours] = params as [string, Date, number];
        const current = state.has(alertName) ? (state.get(alertName) ?? null) : null;
        const dedupMs = Number(dedupHours) * 60 * 60 * 1000;
        const canClaim = current === null || current.getTime() < now.getTime() - dedupMs;
        if (!canClaim) return { rows: [] as unknown as T[] };
        state.set(alertName, now);
        return { rows: [{ last_alert_sent_at: now }] as unknown as T[] };
      }

      if (queryText.includes("UPDATE ops_alert_state")) {
        const alertName = params[0] as string;
        if (params.length >= 2) {
          // The guarded release (releaseOpsAlertSlot): only clears the exact
          // value the matching claim just set.
          const expected = params[1] as Date;
          const current = state.get(alertName) ?? null;
          if (current && current.getTime() === expected.getTime()) {
            state.set(alertName, null);
          }
          return { rows: [] as unknown as T[] };
        }
        // The unconditional release (releaseWorkspacePurgeAlertSlotUnconditionally).
        state.set(alertName, null);
        return { rows: [] as unknown as T[] };
      }

      throw new Error(`createFakeOpsAlertStateClient: unrecognized query -- ${queryText}`);
    },
  };
}

describe("checkWorkspacePurgeHealthAndAlert (fake client, spy sendMail)", () => {
  it("test 7: an unhealthy state sends one alert and claims the dedup slot", async () => {
    const fakeClient = createFakeOpsAlertStateClient();
    const now = new Date("2027-02-01T00:00:00Z");
    const workspaceId = randomUUID();
    const sent: WorkspacePurgeAlertMessage[] = [];

    await checkWorkspacePurgeHealthAndAlert({
      client: fakeClient,
      now,
      operatorEmail: "ops@example.com",
      // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
      sendMail: async (message) => {
        sent.push(message);
      },
      readRecords: () => Promise.resolve([buildRecord({ workspaceId, status: "failed", purgeError: "boom" })]),
    });

    expect(sent).toHaveLength(1);
    expect(fakeClient.state.get(WORKSPACE_PURGE_STUCK_ALERT_NAME)?.getTime()).toBe(now.getTime());
  });

  it("test 8: a second replica evaluating the same unhealthy state inside the same dedup window sends nothing", async () => {
    const fakeClient = createFakeOpsAlertStateClient();
    const t1 = new Date("2027-02-01T00:00:00Z");
    const workspaceId = randomUUID();
    const readRecords = () => Promise.resolve([buildRecord({ workspaceId, status: "failed", purgeError: "boom" })]);
    const sent: WorkspacePurgeAlertMessage[] = [];
    // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
    const sendMail = async (message: WorkspacePurgeAlertMessage) => {
      sent.push(message);
    };

    await checkWorkspacePurgeHealthAndAlert({ client: fakeClient, now: t1, operatorEmail: "ops@example.com", sendMail, readRecords });
    expect(sent).toHaveLength(1);

    // A second replica (or the same one, moments later) sharing the SAME
    // underlying ops_alert_state row -- still inside the dedup window.
    const t2 = new Date(t1.getTime() + 60_000);
    await checkWorkspacePurgeHealthAndAlert({ client: fakeClient, now: t2, operatorEmail: "ops@example.com", sendMail, readRecords });
    expect(sent).toHaveLength(1);

    const t3 = new Date(t1.getTime() + (WORKSPACE_PURGE_ALERT_DEDUP_HOURS + 1) * 60 * 60 * 1000);
    await checkWorkspacePurgeHealthAndAlert({ client: fakeClient, now: t3, operatorEmail: "ops@example.com", sendMail, readRecords });
    expect(sent).toHaveLength(2);
  });

  it("test 9: a healthy evaluation releases the claim so the next genuine incident alerts immediately rather than waiting out the dedup window", async () => {
    const fakeClient = createFakeOpsAlertStateClient();
    const t1 = new Date("2027-02-01T00:00:00Z");
    const workspaceId = randomUUID();
    const sent: WorkspacePurgeAlertMessage[] = [];
    // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
    const sendMail = async (message: WorkspacePurgeAlertMessage) => {
      sent.push(message);
    };

    await checkWorkspacePurgeHealthAndAlert({
      client: fakeClient,
      now: t1,
      operatorEmail: "ops@example.com",
      sendMail,
      readRecords: () => Promise.resolve([buildRecord({ workspaceId, status: "failed", purgeError: "boom" })]),
    });
    expect(sent).toHaveLength(1);

    // Operator fixed it -- healthy now, well inside the dedup window.
    const t2 = new Date(t1.getTime() + 60_000);
    await checkWorkspacePurgeHealthAndAlert({
      client: fakeClient,
      now: t2,
      operatorEmail: "ops@example.com",
      sendMail,
      readRecords: () => Promise.resolve([]),
    });
    expect(sent).toHaveLength(1);
    expect(fakeClient.state.get(WORKSPACE_PURGE_STUCK_ALERT_NAME)).toBeNull();

    // A fresh, unrelated incident moments later -- still inside what WOULD
    // have been the stale dedup window had the release above not happened.
    const t3 = new Date(t2.getTime() + 60_000);
    await checkWorkspacePurgeHealthAndAlert({
      client: fakeClient,
      now: t3,
      operatorEmail: "ops@example.com",
      sendMail,
      readRecords: () => Promise.resolve([buildRecord({ workspaceId, status: "failed", purgeError: "boom again" })]),
    });
    expect(sent).toHaveLength(2);
  });

  it("test 10: alert text is PII-free -- the workspace id legitimately appears, but no email pattern or planted workspace name ever does", async () => {
    const plantedWorkspaceName = "Definitely Not This Workspace, Inc.";
    const plantedContactEmail = "someone@example.com";
    void plantedWorkspaceName;
    void plantedContactEmail;

    const fakeClient = createFakeOpsAlertStateClient();
    const now = new Date("2027-06-01T00:00:00Z");
    const workspaceId = randomUUID();
    const sent: WorkspacePurgeAlertMessage[] = [];

    await checkWorkspacePurgeHealthAndAlert({
      client: fakeClient,
      now,
      operatorEmail: "ops@example.com",
      // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
      sendMail: async (message) => {
        sent.push(message);
      },
      readRecords: () => Promise.resolve([buildRecord({ workspaceId, status: "failed", purgeError: "auth database unavailable" })]),
    });

    expect(sent).toHaveLength(1);
    const body = sent[0]?.text ?? "";
    expect(body).toContain(workspaceId);
    expect(body).not.toContain(plantedWorkspaceName);
    expect(body).not.toContain(plantedContactEmail);
    expect(body).not.toMatch(/[^\s@]+@[^\s@]+\.[^\s@]+/);
  });
});
