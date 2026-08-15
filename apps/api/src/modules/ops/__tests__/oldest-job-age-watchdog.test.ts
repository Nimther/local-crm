import { randomUUID } from "node:crypto";

// 15-13 (Task 3): seeding an organization row directly for test setup is not
// a live application query site -- mirrors ingestion-health-watchdog.test.ts's
// own `authDb`/`organization` seeding convention.
import { authDb as sharedDb, organization } from "@mega-crm/db";
import { closeScanPool, pool, withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { getScanTestDatabaseUrl } from "@mega-crm/test-support";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";
import type { QueueMetricsResult } from "../queue-monitor.js";
import {
  OLDEST_JOB_AGE_ALERT_DEDUP_HOURS,
  OLDEST_JOB_AGE_ALERT_NAME,
  OLDEST_PENDING_JOB_AGE_ALERT_HOURS,
  RECONCILING_SEND_AGE_ALERT_HOURS,
  checkOldestJobAgeHealthAndAlert,
  evaluateOldestJobAgeHealth,
  renderOldestJobAgeAlertText,
} from "../oldest-job-age-watchdog.js";

/**
 * Phase 15 (OPS-13, plan 15-13, Task 3): the full unhealthy-condition matrix
 * on `evaluateOldestJobAgeHealth`/`renderOldestJobAgeAlertText` (pure, no
 * DB), plus `checkOldestJobAgeHealthAndAlert`'s atomic dedup via the shared
 * `claimOpsAlertSlot`, the release-on-send-failure path, and a real
 * `sends.reconciling_since` row read through `withCrossWorkspaceScan`
 * (wrapped internally by the module under test, mirroring
 * `ingestion-health-watchdog.test.ts`'s own DB-fixture conventions).
 */

function okMetrics(oldestPendingAt: Date | null = null): QueueMetricsResult {
  return { readable: true, waiting: 0, delayed: 0, active: 0, failed: 0, oldestPendingAt };
}

function healthyMetrics(): Record<string, QueueMetricsResult> {
  return {
    "email-broadcast": okMetrics(),
    "email-triggered": okMetrics(),
  };
}

describe("evaluateOldestJobAgeHealth / renderOldestJobAgeAlertText (pure, no DB)", () => {
  it("test 1: no pending jobs and no reconciling backlog is healthy", () => {
    const now = new Date("2027-04-01T00:00:00Z");
    const result = evaluateOldestJobAgeHealth(healthyMetrics(), null, now);
    expect(result.healthy).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("test 2: an oldest pending BullMQ job older than the threshold is unhealthy naming the queue and the age", () => {
    const now = new Date("2027-04-01T00:00:00Z");
    const staleAt = new Date(now.getTime() - (OLDEST_PENDING_JOB_AGE_ALERT_HOURS + 1) * 60 * 60 * 1000);
    const metrics = { ...healthyMetrics(), "email-triggered": okMetrics(staleAt) };

    const result = evaluateOldestJobAgeHealth(metrics, null, now);
    expect(result.healthy).toBe(false);
    expect(result.reasons.some((r) => r.includes("email-triggered"))).toBe(true);
    expect(result.reasons.some((r) => /\d+\.\d+h/.test(r))).toBe(true);
  });

  it("test 3: boundary on the pending-job-age threshold -- exactly at threshold is healthy, one hour over is unhealthy", () => {
    const now = new Date("2027-04-01T00:00:00Z");

    const atThresholdAt = new Date(now.getTime() - OLDEST_PENDING_JOB_AGE_ALERT_HOURS * 60 * 60 * 1000);
    const atThreshold = { ...healthyMetrics(), "email-triggered": okMetrics(atThresholdAt) };
    expect(evaluateOldestJobAgeHealth(atThreshold, null, now).healthy).toBe(true);

    const overAt = new Date(now.getTime() - (OLDEST_PENDING_JOB_AGE_ALERT_HOURS * 60 * 60 * 1000 + 1));
    const over = { ...healthyMetrics(), "email-triggered": okMetrics(overAt) };
    expect(evaluateOldestJobAgeHealth(over, null, now).healthy).toBe(false);
  });

  it("test 4: an oldest unresolved reconciling_since older than its threshold is unhealthy naming the age", () => {
    const now = new Date("2027-04-01T00:00:00Z");
    const oldestReconcilingSince = new Date(now.getTime() - (RECONCILING_SEND_AGE_ALERT_HOURS + 1) * 60 * 60 * 1000);

    const result = evaluateOldestJobAgeHealth(healthyMetrics(), oldestReconcilingSince, now);
    expect(result.healthy).toBe(false);
    expect(result.reasons.some((r) => /\d+\.\d+h/.test(r))).toBe(true);
  });

  it("test 5: both conditions at once yield ONE evaluation with both reasons (never two separate evaluations)", () => {
    const now = new Date("2027-04-01T00:00:00Z");
    const stalePendingAt = new Date(now.getTime() - (OLDEST_PENDING_JOB_AGE_ALERT_HOURS + 1) * 60 * 60 * 1000);
    const oldestReconcilingSince = new Date(now.getTime() - (RECONCILING_SEND_AGE_ALERT_HOURS + 1) * 60 * 60 * 1000);
    const metrics = { ...healthyMetrics(), "email-triggered": okMetrics(stalePendingAt) };

    const result = evaluateOldestJobAgeHealth(metrics, oldestReconcilingSince, now);
    expect(result.healthy).toBe(false);
    expect(result.reasons).toHaveLength(2);
  });

  it("test 6: an unreadable queue is unhealthy with the blind-monitor reason", () => {
    const now = new Date("2027-04-01T00:00:00Z");
    const metrics = { ...healthyMetrics(), "email-broadcast": { readable: false as const, error: "ECONNREFUSED" } };

    const result = evaluateOldestJobAgeHealth(metrics, null, now);
    expect(result.healthy).toBe(false);
    expect(result.reasons.some((r) => r.includes("email-broadcast") && /unreadable/i.test(r))).toBe(true);
  });

  it("test 7: the rendered body contains reason lines and the checked-at timestamp, and no workspace id, contact email or send id", () => {
    const now = new Date("2027-04-01T00:00:00Z");
    const stalePendingAt = new Date(now.getTime() - (OLDEST_PENDING_JOB_AGE_ALERT_HOURS + 5) * 60 * 60 * 1000);
    const metrics = { ...healthyMetrics(), "email-triggered": okMetrics(stalePendingAt) };
    const result = evaluateOldestJobAgeHealth(metrics, null, now);

    const body = renderOldestJobAgeAlertText(result.reasons, now);
    expect(body).toContain(now.toISOString());
    expect(body).toContain("email-triggered");

    const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const emailPattern = /[^\s@]+@[^\s@]+\.[^\s@]+/;
    expect(body).not.toMatch(uuidPattern);
    expect(body).not.toMatch(emailPattern);
    expect(body).not.toContain("Bearer");
  });
});

async function freshWorkspaceId(nameSeed: string): Promise<string> {
  const slug = `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [org] = await sharedDb
    .insert(organization)
    .values({ id: randomUUID(), name: nameSeed, slug, createdAt: new Date() })
    .returning();
  return org.id;
}

/** Seeds one `reconciling` send whose `reconciling_since` is `ageHours` old, via the ordinary RLS-scoped tenant transaction (mirrors `send-log-filters.test.ts`'s own `insertSend` convention). */
async function seedReconcilingSend(workspaceId: string, ageHours: number): Promise<void> {
  await withTenant(workspaceId, () =>
    withTenantTransaction(async (client) => {
      const { rows: contactRows } = await client.query<{ id: string }>(
        `INSERT INTO contacts (workspace_id, email) VALUES ($1, $2) RETURNING id`,
        [workspaceId, `oldest-job-age-fixture-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`],
      );
      await client.query(
        `INSERT INTO sends (workspace_id, contact_id, kind, status, queued_at, reconciling_since)
         VALUES ($1, $2, 'campaign', 'reconciling', now(), now() - make_interval(hours => $3))`,
        [workspaceId, contactRows[0].id, ageHours],
      );
    }),
  );
}

describe("checkOldestJobAgeHealthAndAlert dedup", () => {
  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    process.env.SCAN_DATABASE_URL = getScanTestDatabaseUrl();
    pool.on("error", () => {
      // expected: overlapping connections across assertions below.
    });
  });

  afterAll(async () => {
    await pool.end();
    await closeScanPool();
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM ops_alert_state WHERE alert_name = $1`, [OLDEST_JOB_AGE_ALERT_NAME]);
  });

  // Every `reconciling` send this describe block creates is torn down in
  // `afterEach` (never a blanket `DELETE FROM sends`) -- `sends` is a
  // platform-wide table `readOldestReconcilingSince` scans unconditionally,
  // and other apps/api test files may run concurrently against the same
  // ephemeral database.
  const createdWorkspaceIds: string[] = [];
  afterEach(async () => {
    for (const workspaceId of createdWorkspaceIds.splice(0, createdWorkspaceIds.length)) {
      await withTenant(workspaceId, () => withTenantTransaction((client) => client.query(`DELETE FROM sends WHERE workspace_id = $1`, [workspaceId])));
    }
  });

  function unhealthyReadMetrics(now: Date) {
    const stalePendingAt = new Date(now.getTime() - (OLDEST_PENDING_JOB_AGE_ALERT_HOURS + 1) * 60 * 60 * 1000);
    return () => Promise.resolve({ ...healthyMetrics(), "email-triggered": okMetrics(stalePendingAt) });
  }

  it("test 8: at most one send per OLDEST_JOB_AGE_ALERT_DEDUP_HOURS window, even across repeated unhealthy checks", async () => {
    const t1 = new Date();
    const sent: Array<{ to: string; text: string }> = [];
    // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
    const sendMail = async (message: { to: string; text: string }) => {
      sent.push(message);
    };

    await checkOldestJobAgeHealthAndAlert({
      client: pool,
      now: t1,
      operatorEmail: "ops@example.com",
      sendMail,
      readMetrics: unhealthyReadMetrics(t1),
    });
    expect(sent).toHaveLength(1);

    const t2 = new Date(t1.getTime() + 60_000); // still deduped
    await checkOldestJobAgeHealthAndAlert({
      client: pool,
      now: t2,
      operatorEmail: "ops@example.com",
      sendMail,
      readMetrics: unhealthyReadMetrics(t2),
    });
    expect(sent).toHaveLength(1);

    const t3 = new Date(t1.getTime() + (OLDEST_JOB_AGE_ALERT_DEDUP_HOURS + 1) * 60 * 60 * 1000); // past window
    await checkOldestJobAgeHealthAndAlert({
      client: pool,
      now: t3,
      operatorEmail: "ops@example.com",
      sendMail,
      readMetrics: unhealthyReadMetrics(t3),
    });
    expect(sent).toHaveLength(2);
  });

  it("test 9: healthy metrics and no reconciling backlog send nothing", async () => {
    const sent: Array<{ to: string; text: string }> = [];
    // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
    const sendMail = async (message: { to: string; text: string }) => {
      sent.push(message);
    };

    await checkOldestJobAgeHealthAndAlert({
      client: pool,
      now: new Date(),
      operatorEmail: "ops@example.com",
      sendMail,
      readMetrics: () => Promise.resolve(healthyMetrics()),
    });
    expect(sent).toHaveLength(0);
  });

  it("test 10: a real reconciling_since row past threshold, read through withCrossWorkspaceScan, triggers exactly one alert naming its age", async () => {
    const workspaceId = await freshWorkspaceId("oldest-job-age-fixture");
    createdWorkspaceIds.push(workspaceId);
    await seedReconcilingSend(workspaceId, RECONCILING_SEND_AGE_ALERT_HOURS + 2);

    const sent: Array<{ to: string; text: string }> = [];
    // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
    const sendMail = async (message: { to: string; text: string }) => {
      sent.push(message);
    };

    await checkOldestJobAgeHealthAndAlert({
      client: pool,
      now: new Date(),
      operatorEmail: "ops@example.com",
      sendMail,
      readMetrics: () => Promise.resolve(healthyMetrics()),
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/\d+\.\d+h/);
  });

  it("test 11: a rejecting sendMail causes checkOldestJobAgeHealthAndAlert to reject and releases the claim so the next tick can retry", async () => {
    const now = new Date();
    const readMetrics = unhealthyReadMetrics(now);

    await expect(
      checkOldestJobAgeHealthAndAlert({
        client: pool,
        now,
        operatorEmail: "ops@example.com",
        readMetrics,
        sendMail: () => Promise.reject(new Error("sendgrid down")),
      }),
    ).rejects.toThrow("sendgrid down");

    const { rows } = await pool.query<{ last_alert_sent_at: Date | null }>(
      "SELECT last_alert_sent_at FROM ops_alert_state WHERE alert_name = $1",
      [OLDEST_JOB_AGE_ALERT_NAME],
    );
    expect(rows[0]?.last_alert_sent_at).toBeNull();

    const sent: Array<{ to: string; text: string }> = [];
    await checkOldestJobAgeHealthAndAlert({
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
