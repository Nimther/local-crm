import { randomUUID } from "node:crypto";

// 15-14 (Task 2): seeding an organization row directly for test setup is not
// a live application query site -- mirrors oldest-job-age-watchdog.test.ts's
// own `authDb`/`organization` seeding convention.
import { authDb as sharedDb, organization } from "@mega-crm/db";
import { closeScanPool, pool, withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { getScanTestDatabaseUrl } from "@mega-crm/test-support";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";
import {
  FAILED_SEND_SHARE_ALERT_DEDUP_HOURS,
  FAILED_SEND_SHARE_ALERT_NAME,
  FAILED_SEND_SHARE_ALERT_THRESHOLD,
  FAILED_SEND_SHARE_MIN_SAMPLE_SIZE,
  FAILED_SEND_SHARE_ROLLING_WINDOW_HOURS,
  checkFailedSendShareHealthAndAlert,
  evaluateFailedSendShareHealth,
  renderFailedSendShareAlertText,
  type SendStatusCounts,
} from "../failed-send-share-watchdog.js";

/**
 * Phase 15 (OPS-13, plan 15-14, Task 2): the full unhealthy-condition matrix
 * on `evaluateFailedSendShareHealth`/`renderFailedSendShareAlertText` (pure,
 * no DB), plus `checkFailedSendShareHealthAndAlert`'s atomic dedup via the
 * shared `claimOpsAlertSlot`, the release-on-send-failure path, and a real
 * `sends` status-count read through `withCrossWorkspaceScan` (mirrors
 * `oldest-job-age-watchdog.test.ts`'s own DB-fixture conventions).
 */

describe("evaluateFailedSendShareHealth / renderFailedSendShareAlertText (pure, no DB)", () => {
  it("test 1: a window whose terminal outcomes are mostly failures is unhealthy with the observed share", () => {
    const counts: SendStatusCounts = { sent: 5, failed: 20 };
    const result = evaluateFailedSendShareHealth(counts);
    expect(result.healthy).toBe(false);
    expect(result.reasons.some((r) => r.includes("20") && r.includes("25"))).toBe(true);
  });

  it("test 2: a window with many rate-limited deferrals (dispatching) and no terminal failures is healthy -- deferrals are in neither the numerator nor the denominator", () => {
    const counts: SendStatusCounts = { dispatching: 10_000, sent: FAILED_SEND_SHARE_MIN_SAMPLE_SIZE };
    const result = evaluateFailedSendShareHealth(counts);
    expect(result.healthy).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("test 3: a window whose sends are still reconciling is healthy -- non-terminal outcomes excluded from both sides rather than counted as successes", () => {
    const counts: SendStatusCounts = { reconciling: 10_000 };
    const result = evaluateFailedSendShareHealth(counts);
    expect(result.healthy).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("test 3b: a window whose sends are still unknown (ambiguous terminal) is healthy -- unknown never counts as failure or success", () => {
    const counts: SendStatusCounts = { unknown: 10_000, sent: FAILED_SEND_SHARE_MIN_SAMPLE_SIZE };
    const result = evaluateFailedSendShareHealth(counts);
    expect(result.healthy).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("test 3c: a window dominated by excluded (pre-send-gate skip) sends is healthy -- an excluded send was never attempted and must never count in the denominator", () => {
    const counts: SendStatusCounts = { excluded: 100_000, failed: 1, sent: 1 };
    // denominator = sent+failed = 2, below MIN_SAMPLE_SIZE -> healthy anyway,
    // but the point of this test is that `excluded`'s 100,000 rows never
    // enter the denominator at all (if they did, this would still be
    // healthy by dilution, masking the real 50% failure rate among actual
    // attempts -- the NEXT test proves the denominator is exactly 2).
    const result = evaluateFailedSendShareHealth(counts, {
      minSampleSize: 2,
      shareThreshold: FAILED_SEND_SHARE_ALERT_THRESHOLD,
    });
    expect(result.healthy).toBe(false);
    expect(result.reasons.some((r) => r.includes("1/2"))).toBe(true);
  });

  it("test 4: a window with fewer terminal outcomes than the minimum sample size is healthy regardless of the share", () => {
    const counts: SendStatusCounts = { sent: 0, failed: FAILED_SEND_SHARE_MIN_SAMPLE_SIZE - 1 };
    const result = evaluateFailedSendShareHealth(counts);
    expect(result.healthy).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("test 5: boundary -- exactly at the share threshold is healthy, one over is unhealthy", () => {
    const denominator = 100;
    const atThresholdFailed = Math.round(denominator * FAILED_SEND_SHARE_ALERT_THRESHOLD);
    const atThreshold: SendStatusCounts = { sent: denominator - atThresholdFailed, failed: atThresholdFailed };
    expect(
      evaluateFailedSendShareHealth(atThreshold, { minSampleSize: FAILED_SEND_SHARE_MIN_SAMPLE_SIZE, shareThreshold: FAILED_SEND_SHARE_ALERT_THRESHOLD }).healthy,
    ).toBe(true);

    const overThreshold: SendStatusCounts = { sent: denominator - (atThresholdFailed + 1), failed: atThresholdFailed + 1 };
    expect(
      evaluateFailedSendShareHealth(overThreshold, { minSampleSize: FAILED_SEND_SHARE_MIN_SAMPLE_SIZE, shareThreshold: FAILED_SEND_SHARE_ALERT_THRESHOLD }).healthy,
    ).toBe(false);
  });

  it("test 6: no sends at all in the window yields healthy", () => {
    const result = evaluateFailedSendShareHealth({});
    expect(result.healthy).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("test 7: the rendered body contains none of a planted workspace id, contact email or send id", () => {
    const plantedWorkspaceId = "11111111-2222-3333-4444-555555555555";
    const plantedEmail = "someone@example.com";
    const plantedSendId = "66666666-7777-8888-9999-000000000000";
    void plantedWorkspaceId;
    void plantedEmail;
    void plantedSendId;

    const now = new Date("2027-05-01T00:00:00Z");
    const result = evaluateFailedSendShareHealth({ sent: 5, failed: 20 });
    const body = renderFailedSendShareAlertText(result.reasons, now);
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

/** Seeds one `sends` row of a given status inside the rolling window, via the ordinary RLS-scoped tenant transaction. */
async function seedSend(workspaceId: string, status: string): Promise<void> {
  await withTenant(workspaceId, () =>
    withTenantTransaction(async (client) => {
      const { rows: contactRows } = await client.query<{ id: string }>(
        `INSERT INTO contacts (workspace_id, email) VALUES ($1, $2) RETURNING id`,
        [workspaceId, `failed-send-share-fixture-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`],
      );
      await client.query(`INSERT INTO sends (workspace_id, contact_id, kind, status, queued_at) VALUES ($1, $2, 'campaign', $3, now())`, [
        workspaceId,
        contactRows[0].id,
        status,
      ]);
    }),
  );
}

describe("checkFailedSendShareHealthAndAlert dedup", () => {
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
    await pool.query(`DELETE FROM ops_alert_state WHERE alert_name = $1`, [FAILED_SEND_SHARE_ALERT_NAME]);
  });

  // Every `sends` row this describe block creates is torn down in
  // `afterEach` (never a blanket `DELETE FROM sends`) -- `sends` is a
  // platform-wide table `readSendStatusCountsSince` scans unconditionally,
  // and other apps/api test files may run concurrently against the same
  // ephemeral database.
  const createdWorkspaceIds: string[] = [];
  afterEach(async () => {
    for (const workspaceId of createdWorkspaceIds.splice(0, createdWorkspaceIds.length)) {
      await withTenant(workspaceId, () => withTenantTransaction((client) => client.query(`DELETE FROM sends WHERE workspace_id = $1`, [workspaceId])));
    }
  });

  function unhealthyReadCounts(): () => Promise<SendStatusCounts> {
    return () => Promise.resolve({ sent: 5, failed: 20 });
  }

  it("test 8: at most one send per FAILED_SEND_SHARE_ALERT_DEDUP_HOURS window, even across repeated unhealthy checks", async () => {
    const t1 = new Date();
    const sent: Array<{ to: string; text: string }> = [];
    // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
    const sendMail = async (message: { to: string; text: string }) => {
      sent.push(message);
    };
    const readCounts = unhealthyReadCounts();

    await checkFailedSendShareHealthAndAlert({ client: pool, now: t1, operatorEmail: "ops@example.com", sendMail, readCounts });
    expect(sent).toHaveLength(1);

    const t2 = new Date(t1.getTime() + 60_000); // still deduped
    await checkFailedSendShareHealthAndAlert({ client: pool, now: t2, operatorEmail: "ops@example.com", sendMail, readCounts });
    expect(sent).toHaveLength(1);

    const t3 = new Date(t1.getTime() + (FAILED_SEND_SHARE_ALERT_DEDUP_HOURS + 1) * 60 * 60 * 1000); // past window
    await checkFailedSendShareHealthAndAlert({ client: pool, now: t3, operatorEmail: "ops@example.com", sendMail, readCounts });
    expect(sent).toHaveLength(2);
  });

  it("test 9: a healthy count breakdown sends nothing", async () => {
    const sentMessages: Array<{ to: string; text: string }> = [];
    // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
    const sendMail = async (message: { to: string; text: string }) => {
      sentMessages.push(message);
    };

    await checkFailedSendShareHealthAndAlert({
      client: pool,
      now: new Date(),
      operatorEmail: "ops@example.com",
      sendMail,
      readCounts: () => Promise.resolve({ sent: 100 }),
    });
    expect(sentMessages).toHaveLength(0);
  });

  it("test 10: a rejecting sendMail causes checkFailedSendShareHealthAndAlert to reject and releases the claim so the next tick can retry", async () => {
    const now = new Date();
    const readCounts = unhealthyReadCounts();

    await expect(
      checkFailedSendShareHealthAndAlert({
        client: pool,
        now,
        operatorEmail: "ops@example.com",
        readCounts,
        sendMail: () => Promise.reject(new Error("sendgrid down")),
      }),
    ).rejects.toThrow("sendgrid down");

    const { rows } = await pool.query<{ last_alert_sent_at: Date | null }>(
      "SELECT last_alert_sent_at FROM ops_alert_state WHERE alert_name = $1",
      [FAILED_SEND_SHARE_ALERT_NAME],
    );
    expect(rows[0]?.last_alert_sent_at).toBeNull();

    const sent: Array<{ to: string; text: string }> = [];
    await checkFailedSendShareHealthAndAlert({
      client: pool,
      now: new Date(now.getTime() + 1_000),
      operatorEmail: "ops@example.com",
      readCounts,
      // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
      sendMail: async (message) => {
        sent.push(message);
      },
    });
    expect(sent).toHaveLength(1);
  });

  it("test 11: a real seeded mix of statuses, read through withCrossWorkspaceScan's default readCounts, alerts only on the sent/failed share -- reconciling/excluded/unknown/dispatching rows never dilute or inflate it", async () => {
    const workspaceId = await freshWorkspaceId("failed-send-share-fixture");
    createdWorkspaceIds.push(workspaceId);

    // 1 sent, 4 failed -> denominator 5, share 80% (well above threshold),
    // easily distinguishable from noise, plus a pile of non-attempted /
    // non-terminal rows that must never enter the computation.
    await seedSend(workspaceId, "sent");
    await seedSend(workspaceId, "failed");
    await seedSend(workspaceId, "failed");
    await seedSend(workspaceId, "failed");
    await seedSend(workspaceId, "failed");
    await seedSend(workspaceId, "reconciling");
    await seedSend(workspaceId, "unknown");
    await seedSend(workspaceId, "excluded");
    await seedSend(workspaceId, "dispatching");

    const sentMessages: Array<{ to: string; text: string }> = [];
    // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
    const sendMail = async (message: { to: string; text: string }) => {
      sentMessages.push(message);
    };

    await checkFailedSendShareHealthAndAlert({
      client: pool,
      now: new Date(),
      operatorEmail: "ops@example.com",
      sendMail,
      thresholds: { minSampleSize: 2, shareThreshold: FAILED_SEND_SHARE_ALERT_THRESHOLD },
    });

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toContain("4/5");
  });
});

// Sanity: the exported rolling-window constant is a positive number of hours
// this module's default `readCounts` uses to bound the `sends` scan -- a
// regression to 0 or a negative value would silently widen the scan to
// "since the epoch" or narrow it to nothing.
describe("FAILED_SEND_SHARE_ROLLING_WINDOW_HOURS sanity", () => {
  it("is a positive number of hours", () => {
    expect(FAILED_SEND_SHARE_ROLLING_WINDOW_HOURS).toBeGreaterThan(0);
  });
});
