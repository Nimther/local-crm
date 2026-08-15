import { pool } from "@mega-crm/tenant-context";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";
import type { QueueMetricsResult } from "../queue-monitor.js";
import {
  QUEUE_DEPTH_ALERT_DEDUP_HOURS,
  QUEUE_DEPTH_ALERT_NAME,
  QUEUE_DEPTH_THRESHOLDS,
  checkQueueDepthHealthAndAlert,
  evaluateQueueDepthHealth,
  renderQueueDepthAlertText,
} from "../queue-depth-watchdog.js";

/**
 * Phase 15 (OPS-13, plan 15-13, Task 2): the full unhealthy-condition matrix
 * on `evaluateQueueDepthHealth`/`renderQueueDepthAlertText` (pure, no DB),
 * plus `checkQueueDepthHealthAndAlert`'s atomic dedup via the shared
 * `claimOpsAlertSlot` and the release-on-send-failure path -- mirrors
 * `send-reconciler-watchdog.test.ts`'s own structure and conventions.
 */

function okMetrics(overrides: Partial<{ waiting: number; delayed: number; active: number; failed: number }> = {}): QueueMetricsResult {
  return {
    readable: true,
    waiting: 0,
    delayed: 0,
    active: 0,
    failed: 0,
    oldestPendingAt: null,
    ...overrides,
  };
}

function allHealthyMetrics(): Record<string, QueueMetricsResult> {
  const metrics: Record<string, QueueMetricsResult> = {};
  for (const queueName of Object.keys(QUEUE_DEPTH_THRESHOLDS)) {
    metrics[queueName] = okMetrics();
  }
  return metrics;
}

describe("evaluateQueueDepthHealth / renderQueueDepthAlertText (pure, no DB)", () => {
  it("test 1: every queue under threshold is healthy with no reasons", () => {
    const result = evaluateQueueDepthHealth(allHealthyMetrics(), QUEUE_DEPTH_THRESHOLDS);
    expect(result.healthy).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("test 2: a queue over its threshold is unhealthy with a reason naming that queue", () => {
    const [queueName, threshold] = Object.entries(QUEUE_DEPTH_THRESHOLDS)[0];
    const metrics = allHealthyMetrics();
    metrics[queueName] = okMetrics({ waiting: threshold + 1 });

    const result = evaluateQueueDepthHealth(metrics, QUEUE_DEPTH_THRESHOLDS);
    expect(result.healthy).toBe(false);
    expect(result.reasons.some((r) => r.includes(queueName))).toBe(true);
  });

  it("test 3: boundary -- exactly at threshold is healthy, one over is unhealthy", () => {
    const [queueName, threshold] = Object.entries(QUEUE_DEPTH_THRESHOLDS)[0];

    const atThreshold = allHealthyMetrics();
    atThreshold[queueName] = okMetrics({ waiting: threshold });
    expect(evaluateQueueDepthHealth(atThreshold, QUEUE_DEPTH_THRESHOLDS).healthy).toBe(true);

    const overThreshold = allHealthyMetrics();
    overThreshold[queueName] = okMetrics({ waiting: threshold + 1 });
    expect(evaluateQueueDepthHealth(overThreshold, QUEUE_DEPTH_THRESHOLDS).healthy).toBe(false);
  });

  it("test 4: depth combines waiting + delayed + active, never failed", () => {
    const [queueName, threshold] = Object.entries(QUEUE_DEPTH_THRESHOLDS)[0];
    const metrics = allHealthyMetrics();
    // failed alone, however large, must never trip depth health.
    metrics[queueName] = okMetrics({ failed: threshold + 1_000_000 });
    expect(evaluateQueueDepthHealth(metrics, QUEUE_DEPTH_THRESHOLDS).healthy).toBe(true);

    const splitOver = allHealthyMetrics();
    const third = Math.floor(threshold / 3) + 1;
    splitOver[queueName] = okMetrics({ waiting: third, delayed: third, active: third });
    expect(evaluateQueueDepthHealth(splitOver, QUEUE_DEPTH_THRESHOLDS).healthy).toBe(false);
  });

  it("test 5: an unreadable queue is unhealthy with a distinct blind-monitor reason, regardless of every other queue's counts", () => {
    const [queueName] = Object.entries(QUEUE_DEPTH_THRESHOLDS)[0];
    const metrics = allHealthyMetrics();
    metrics[queueName] = { readable: false, error: "ECONNREFUSED" };

    const result = evaluateQueueDepthHealth(metrics, QUEUE_DEPTH_THRESHOLDS);
    expect(result.healthy).toBe(false);
    expect(result.reasons.some((r) => r.includes(queueName) && /unreadable/i.test(r))).toBe(true);
  });

  it("test 6: a missing metrics entry for a monitored queue evaluates unhealthy, never healthy (absence of data is never good news)", () => {
    const metrics = allHealthyMetrics();
    const [queueName] = Object.entries(QUEUE_DEPTH_THRESHOLDS)[0];
    delete metrics[queueName];

    const result = evaluateQueueDepthHealth(metrics, QUEUE_DEPTH_THRESHOLDS);
    expect(result.healthy).toBe(false);
    expect(result.reasons.some((r) => r.includes(queueName))).toBe(true);
  });

  it("test 7: the rendered body contains queue names, counts and reason names, and no workspace id, contact email or send id planted nearby", () => {
    const plantedWorkspaceId = "11111111-2222-3333-4444-555555555555";
    const plantedEmail = "someone@example.com";
    const plantedSendId = "66666666-7777-8888-9999-000000000000";
    void plantedWorkspaceId;
    void plantedEmail;
    void plantedSendId;

    const [queueName, threshold] = Object.entries(QUEUE_DEPTH_THRESHOLDS)[0];
    const metrics = allHealthyMetrics();
    metrics[queueName] = okMetrics({ waiting: threshold + 5 });
    const result = evaluateQueueDepthHealth(metrics, QUEUE_DEPTH_THRESHOLDS);
    const now = new Date("2027-03-01T00:00:00Z");

    const body = renderQueueDepthAlertText(result.reasons, now);
    expect(body).toContain(queueName);
    expect(body).toContain(String(threshold));
    expect(body).toContain(now.toISOString());

    const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const emailPattern = /[^\s@]+@[^\s@]+\.[^\s@]+/;
    expect(body).not.toMatch(uuidPattern);
    expect(body).not.toMatch(emailPattern);
    expect(body).not.toContain("Bearer");
  });
});

describe("checkQueueDepthHealthAndAlert dedup (T-15-42/43/44)", () => {
  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    pool.on("error", () => {
      // expected: some assertions below may drive overlapping connections.
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  const [unhealthyQueueName, unhealthyThreshold] = Object.entries(QUEUE_DEPTH_THRESHOLDS)[0];

  function unhealthyMetricsFactory(): Record<string, QueueMetricsResult> {
    const metrics = allHealthyMetrics();
    metrics[unhealthyQueueName] = okMetrics({ waiting: unhealthyThreshold + 1 });
    return metrics;
  }

  it("test 8: at most one send per QUEUE_DEPTH_ALERT_DEDUP_HOURS window, even across repeated unhealthy checks", async () => {
    const t1 = new Date();
    const sent: Array<{ to: string; text: string }> = [];
    // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
    const sendMail = async (message: { to: string; text: string }) => {
      sent.push(message);
    };
    const readMetrics = () => Promise.resolve(unhealthyMetricsFactory());

    await checkQueueDepthHealthAndAlert({ client: pool, now: t1, operatorEmail: "ops@example.com", sendMail, readMetrics });
    expect(sent).toHaveLength(1);

    const t2 = new Date(t1.getTime() + 60_000); // still deduped
    await checkQueueDepthHealthAndAlert({ client: pool, now: t2, operatorEmail: "ops@example.com", sendMail, readMetrics });
    expect(sent).toHaveLength(1);

    const t3 = new Date(t1.getTime() + (QUEUE_DEPTH_ALERT_DEDUP_HOURS + 1) * 60 * 60 * 1000); // past window
    await checkQueueDepthHealthAndAlert({ client: pool, now: t3, operatorEmail: "ops@example.com", sendMail, readMetrics });
    expect(sent).toHaveLength(2);
  });

  it("test 9: healthy metrics send nothing", async () => {
    const sent: Array<{ to: string; text: string }> = [];
    // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
    const sendMail = async (message: { to: string; text: string }) => {
      sent.push(message);
    };
    const readMetrics = () => Promise.resolve(allHealthyMetrics());

    await checkQueueDepthHealthAndAlert({
      client: pool,
      now: new Date(),
      operatorEmail: "ops@example.com",
      sendMail,
      readMetrics,
    });
    expect(sent).toHaveLength(0);
  });

  it("test 10: a rejecting sendMail causes checkQueueDepthHealthAndAlert to reject and releases the claim so the next tick can retry", async () => {
    const now = new Date();
    const readMetrics = () => Promise.resolve(unhealthyMetricsFactory());

    await expect(
      checkQueueDepthHealthAndAlert({
        client: pool,
        now,
        operatorEmail: "ops@example.com",
        readMetrics,
        sendMail: () => Promise.reject(new Error("sendgrid down")),
      }),
    ).rejects.toThrow("sendgrid down");

    const { rows } = await pool.query<{ last_alert_sent_at: Date | null }>(
      "SELECT last_alert_sent_at FROM ops_alert_state WHERE alert_name = $1",
      [QUEUE_DEPTH_ALERT_NAME],
    );
    expect(rows[0]?.last_alert_sent_at).toBeNull();

    const sent: Array<{ to: string; text: string }> = [];
    await checkQueueDepthHealthAndAlert({
      client: pool,
      now: new Date(now.getTime() + 1_000),
      operatorEmail: "ops@example.com",
      readMetrics,
      // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
      sendMail: async (message) => {
        sent.push(message);
      },
    });
    expect(sent).toHaveLength(1);
  });
});
