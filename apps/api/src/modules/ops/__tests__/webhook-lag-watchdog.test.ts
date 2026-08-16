import { randomUUID } from "node:crypto";

// 15-14 (Task 1): seeding an organization row directly for test setup is not
// a live application query site -- mirrors oldest-job-age-watchdog.test.ts's
// own `authDb`/`organization` seeding convention.
import { authDb as sharedDb, organization } from "@mega-crm/db";
import { closeScanPool, pool, withCrossWorkspaceScan, withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { getScanTestDatabaseUrl } from "@mega-crm/test-support";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";
import {
  WEBHOOK_LAG_ALERT_DEDUP_HOURS,
  WEBHOOK_LAG_ALERT_MINUTES,
  WEBHOOK_LAG_ALERT_NAME,
  checkWebhookLagHealthAndAlert,
  evaluateWebhookLagHealth,
  readNewestWebhookEventAt,
  renderWebhookLagAlertText,
} from "../webhook-lag-watchdog.js";

/**
 * Phase 15 (OPS-13, plan 15-14, Task 1): the full unhealthy-condition matrix
 * on `evaluateWebhookLagHealth`/`renderWebhookLagAlertText` (pure, no DB),
 * plus `checkWebhookLagHealthAndAlert`'s atomic dedup via the shared
 * `claimOpsAlertSlot`, the release-on-send-failure path, and real reads
 * through `withCrossWorkspaceScan` (mirrors `oldest-job-age-watchdog.test.ts`'s
 * own DB-fixture conventions).
 */

describe("evaluateWebhookLagHealth / renderWebhookLagAlertText (pure, no DB)", () => {
  const now = new Date("2027-06-01T00:00:00Z");

  it("test 1: newest webhook event older than the lag threshold AND outstanding sends awaiting evidence is unhealthy", () => {
    const staleAt = new Date(now.getTime() - (WEBHOOK_LAG_ALERT_MINUTES + 5) * 60_000);
    const oldestReconcilingSince = new Date(now.getTime() - 60 * 60_000);
    const result = evaluateWebhookLagHealth(staleAt, oldestReconcilingSince, now);
    expect(result.healthy).toBe(false);
    expect(result.reasons.some((r) => /\d+\.\d+min/.test(r))).toBe(true);
  });

  it("test 2: newest webhook event older than the lag threshold with NO outstanding sends is healthy -- a quiet system is not lagging, it is idle", () => {
    const veryStaleAt = new Date(now.getTime() - 365 * 24 * 60 * 60_000); // a year old
    const result = evaluateWebhookLagHealth(veryStaleAt, null, now);
    expect(result.healthy).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("test 3: recent webhook events with outstanding sends is healthy", () => {
    const recentAt = new Date(now.getTime() - 60_000);
    const oldestReconcilingSince = new Date(now.getTime() - 60 * 60_000);
    const result = evaluateWebhookLagHealth(recentAt, oldestReconcilingSince, now);
    expect(result.healthy).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("test 4: no webhook event ever recorded, with outstanding sends, is unhealthy with its own distinct reason", () => {
    const oldestReconcilingSince = new Date(now.getTime() - 60 * 60_000);
    const result = evaluateWebhookLagHealth(null, oldestReconcilingSince, now);
    expect(result.healthy).toBe(false);
    expect(result.reasons.some((r) => /never/i.test(r))).toBe(true);
  });

  it("test 5: no webhook event ever recorded, with no outstanding sends either, is healthy (nothing to be lagging about)", () => {
    const result = evaluateWebhookLagHealth(null, null, now);
    expect(result.healthy).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("test 6: boundary -- exactly at the lag threshold is healthy, one minute over is unhealthy", () => {
    const oldestReconcilingSince = new Date(now.getTime() - 60 * 60_000);

    const atThresholdAt = new Date(now.getTime() - WEBHOOK_LAG_ALERT_MINUTES * 60_000);
    expect(evaluateWebhookLagHealth(atThresholdAt, oldestReconcilingSince, now).healthy).toBe(true);

    const overThresholdAt = new Date(now.getTime() - (WEBHOOK_LAG_ALERT_MINUTES * 60_000 + 60_000));
    expect(evaluateWebhookLagHealth(overThresholdAt, oldestReconcilingSince, now).healthy).toBe(false);
  });

  it("test 7: the rendered body contains none of a planted workspace id, contact email or send id", () => {
    const plantedWorkspaceId = "11111111-2222-3333-4444-555555555555";
    const plantedEmail = "someone@example.com";
    const plantedSendId = "66666666-7777-8888-9999-000000000000";
    void plantedWorkspaceId;
    void plantedEmail;
    void plantedSendId;

    const staleAt = new Date(now.getTime() - (WEBHOOK_LAG_ALERT_MINUTES + 5) * 60_000);
    const oldestReconcilingSince = new Date(now.getTime() - 60 * 60_000);
    const result = evaluateWebhookLagHealth(staleAt, oldestReconcilingSince, now);

    const body = renderWebhookLagAlertText(result.reasons, now);
    expect(body).toContain(now.toISOString());

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

/** Seeds one `workspace_webhook_endpoints` row with a given `last_event_at`, via the ordinary RLS-scoped tenant transaction. */
async function seedWebhookEndpoint(workspaceId: string, lastEventAt: Date | null): Promise<void> {
  await withTenant(workspaceId, () =>
    withTenantTransaction(async (client) => {
      await client.query(
        `INSERT INTO workspace_webhook_endpoints (workspace_id, path_token, last_event_at)
         VALUES ($1, $2, $3)`,
        [workspaceId, `webhook-lag-fixture-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, lastEventAt],
      );
    }),
  );
}

/** Seeds one `reconciling` send whose `reconciling_since` is `ageHours` old, via the ordinary RLS-scoped tenant transaction (mirrors oldest-job-age-watchdog.test.ts's own convention). */
async function seedReconcilingSend(workspaceId: string, ageHours: number): Promise<void> {
  await withTenant(workspaceId, () =>
    withTenantTransaction(async (client) => {
      const { rows: contactRows } = await client.query<{ id: string }>(
        `INSERT INTO contacts (workspace_id, email) VALUES ($1, $2) RETURNING id`,
        [workspaceId, `webhook-lag-fixture-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`],
      );
      await client.query(
        `INSERT INTO sends (workspace_id, contact_id, kind, status, queued_at, reconciling_since)
         VALUES ($1, $2, 'campaign', 'reconciling', now(), now() - make_interval(hours => $3))`,
        [workspaceId, contactRows[0].id, ageHours],
      );
    }),
  );
}

describe("checkWebhookLagHealthAndAlert dedup", () => {
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
    await pool.query(`DELETE FROM ops_alert_state WHERE alert_name = $1`, [WEBHOOK_LAG_ALERT_NAME]);
  });

  // Every row this describe block creates (sends, workspace_webhook_endpoints)
  // is torn down in `afterEach` (never a blanket DELETE) -- both tables are
  // platform-wide scans, and other apps/api test files may run concurrently
  // against the same ephemeral database.
  const createdWorkspaceIds: string[] = [];
  afterEach(async () => {
    for (const workspaceId of createdWorkspaceIds.splice(0, createdWorkspaceIds.length)) {
      await withTenant(workspaceId, () =>
        withTenantTransaction(async (client) => {
          await client.query(`DELETE FROM sends WHERE workspace_id = $1`, [workspaceId]);
          await client.query(`DELETE FROM workspace_webhook_endpoints WHERE workspace_id = $1`, [workspaceId]);
        }),
      );
    }
  });

  function unhealthyReadSignals(now: Date): () => Promise<{ newestWebhookEventAt: Date | null; oldestReconcilingSince: Date | null }> {
    const staleAt = new Date(now.getTime() - (WEBHOOK_LAG_ALERT_MINUTES + 5) * 60_000);
    const oldestReconcilingSince = new Date(now.getTime() - 60 * 60_000);
    return () => Promise.resolve({ newestWebhookEventAt: staleAt, oldestReconcilingSince });
  }

  it("test 8: at most one send per WEBHOOK_LAG_ALERT_DEDUP_HOURS window, even across repeated unhealthy checks", async () => {
    const t1 = new Date();
    const sent: Array<{ to: string; text: string }> = [];
    // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
    const sendMail = async (message: { to: string; text: string }) => {
      sent.push(message);
    };
    const readSignals = unhealthyReadSignals(t1);

    await checkWebhookLagHealthAndAlert({ client: pool, now: t1, operatorEmail: "ops@example.com", sendMail, readSignals });
    expect(sent).toHaveLength(1);

    const t2 = new Date(t1.getTime() + 60_000); // still deduped
    await checkWebhookLagHealthAndAlert({ client: pool, now: t2, operatorEmail: "ops@example.com", sendMail, readSignals: unhealthyReadSignals(t2) });
    expect(sent).toHaveLength(1);

    const t3 = new Date(t1.getTime() + (WEBHOOK_LAG_ALERT_DEDUP_HOURS + 1) * 60 * 60 * 1000); // past window
    await checkWebhookLagHealthAndAlert({ client: pool, now: t3, operatorEmail: "ops@example.com", sendMail, readSignals: unhealthyReadSignals(t3) });
    expect(sent).toHaveLength(2);
  });

  it("test 9: healthy signals (no outstanding sends) send nothing", async () => {
    const sentMessages: Array<{ to: string; text: string }> = [];
    // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
    const sendMail = async (message: { to: string; text: string }) => {
      sentMessages.push(message);
    };

    await checkWebhookLagHealthAndAlert({
      client: pool,
      now: new Date(),
      operatorEmail: "ops@example.com",
      sendMail,
      readSignals: () => Promise.resolve({ newestWebhookEventAt: null, oldestReconcilingSince: null }),
    });
    expect(sentMessages).toHaveLength(0);
  });

  it("test 10: a rejecting sendMail causes checkWebhookLagHealthAndAlert to reject and releases the claim so the next tick can retry", async () => {
    const now = new Date();
    const readSignals = unhealthyReadSignals(now);

    await expect(
      checkWebhookLagHealthAndAlert({
        client: pool,
        now,
        operatorEmail: "ops@example.com",
        readSignals,
        sendMail: () => Promise.reject(new Error("sendgrid down")),
      }),
    ).rejects.toThrow("sendgrid down");

    const { rows } = await pool.query<{ last_alert_sent_at: Date | null }>(
      "SELECT last_alert_sent_at FROM ops_alert_state WHERE alert_name = $1",
      [WEBHOOK_LAG_ALERT_NAME],
    );
    expect(rows[0]?.last_alert_sent_at).toBeNull();

    const sent: Array<{ to: string; text: string }> = [];
    await checkWebhookLagHealthAndAlert({
      client: pool,
      now: new Date(now.getTime() + 1_000),
      operatorEmail: "ops@example.com",
      readSignals,
      // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
      sendMail: async (message) => {
        sent.push(message);
      },
    });
    expect(sent).toHaveLength(1);
  });

  it("test 11: a real seeded RECENT last_event_at plus a real reconciling send, read through withCrossWorkspaceScan's default readSignals end to end, stays healthy -- contamination-safe direction (a fresh write can only push the platform-wide MAX up, never down, so concurrent test-suite fixtures elsewhere in the shared ephemeral DB can never turn this healthy case flaky)", async () => {
    const workspaceId = await freshWorkspaceId("webhook-lag-fixture");
    createdWorkspaceIds.push(workspaceId);

    await seedWebhookEndpoint(workspaceId, new Date());
    await seedReconcilingSend(workspaceId, 2);

    const sentMessages: Array<{ to: string; text: string }> = [];
    // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
    const sendMail = async (message: { to: string; text: string }) => {
      sentMessages.push(message);
    };

    await checkWebhookLagHealthAndAlert({
      client: pool,
      now: new Date(),
      operatorEmail: "ops@example.com",
      sendMail,
    });

    expect(sentMessages).toHaveLength(0);
  });

  it("test 12: readNewestWebhookEventAt, via withCrossWorkspaceScan, reflects a freshly seeded last_event_at as a LOWER BOUND on the platform-wide MAX (asserted as a delta-free lower bound, not exact equality, so concurrent test-suite fixtures elsewhere in the shared ephemeral DB can never contaminate this assertion the way an exact-value check would)", async () => {
    const workspaceId = await freshWorkspaceId("webhook-lag-fixture");
    createdWorkspaceIds.push(workspaceId);

    const before = new Date();
    await seedWebhookEndpoint(workspaceId, before);

    const after = await withCrossWorkspaceScan((client) => readNewestWebhookEventAt(client));
    expect(after).not.toBeNull();
    expect((after as Date).getTime()).toBeGreaterThanOrEqual(before.getTime());
  });
});
