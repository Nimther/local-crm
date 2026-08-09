import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "@mega-crm/tenant-context";
import type { ReconcilerRunRow } from "@mega-crm/db/src/reconciler/reconciler-run.js";

import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";
import {
  RECONCILER_ALERT_DEDUP_HOURS,
  RECONCILER_STALE_THRESHOLD_MINUTES,
  RECONCILING_AGE_ALERT_HOURS,
  checkReconcilerHealthAndAlert,
  claimReconcilerAlertSlot,
  evaluateReconcilerHealth,
  renderReconcilerAlertText,
} from "../send-reconciler-watchdog.js";

/**
 * 11-09 task 2 (D-14): the full unhealthy-condition matrix on
 * `evaluateReconcilerHealth`/`renderReconcilerAlertText` (pure, no DB), plus
 * `claimReconcilerAlertSlot`'s atomic dedup and the release-on-send-failure
 * path (needs the shared apps/api test database) -- mirrors
 * `partition-watchdog.test.ts`'s own structure and conventions.
 */

const THRESHOLDS = {
  staleThresholdMinutes: RECONCILER_STALE_THRESHOLD_MINUTES,
  reconcilingAgeAlertHours: RECONCILING_AGE_ALERT_HOURS,
};

function buildRow(overrides: Partial<ReconcilerRunRow> = {}): ReconcilerRunRow {
  return {
    id: 1,
    lastRunAt: new Date(),
    candidatesScanned: 0,
    rowsResolved: 0,
    rowsMarkedUnknown: 0,
    staleDispatchingSwept: 0,
    oldestReconcilingSince: null,
    lastAlertSentAt: null,
    updatedAt: new Date(),
    ...overrides,
  };
}

async function seedReconcilerRow(overrides: Partial<ReconcilerRunRow> = {}): Promise<void> {
  const row = buildRow(overrides);
  await pool.query(
    `INSERT INTO send_reconciler_runs (
       id, last_run_at, candidates_scanned, rows_resolved, rows_marked_unknown,
       stale_dispatching_swept, oldest_reconciling_since, last_alert_sent_at, updated_at
     ) VALUES (1, $1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (id) DO UPDATE SET
       last_run_at = EXCLUDED.last_run_at,
       candidates_scanned = EXCLUDED.candidates_scanned,
       rows_resolved = EXCLUDED.rows_resolved,
       rows_marked_unknown = EXCLUDED.rows_marked_unknown,
       stale_dispatching_swept = EXCLUDED.stale_dispatching_swept,
       oldest_reconciling_since = EXCLUDED.oldest_reconciling_since,
       last_alert_sent_at = EXCLUDED.last_alert_sent_at,
       updated_at = now()`,
    [
      row.lastRunAt,
      row.candidatesScanned,
      row.rowsResolved,
      row.rowsMarkedUnknown,
      row.staleDispatchingSwept,
      row.oldestReconcilingSince,
      row.lastAlertSentAt,
    ],
  );
}

describe("evaluateReconcilerHealth / renderReconcilerAlertText (pure, no DB)", () => {
  it("test 1: evaluateReconcilerHealth(null, ...) is unhealthy with missing_health_row, and the alert body says so without dereferencing the row", () => {
    const now = new Date("2027-01-10T00:00:00Z");
    const result = evaluateReconcilerHealth(null, now, THRESHOLDS);
    expect(result.healthy).toBe(false);
    expect(result.reasons).toEqual(["missing_health_row"]);

    const body = renderReconcilerAlertText(null, result.reasons, now);
    expect(body).toMatch(/no send_reconciler_runs row/i);
    expect(body).toContain(now.toISOString());
    expect(body).toContain("missing_health_row");
  });

  it("test 2: a stale last run is unhealthy; exactly at the threshold is still healthy", () => {
    const now = new Date("2027-01-10T00:00:00Z");
    const staleRow = buildRow({
      lastRunAt: new Date(now.getTime() - (RECONCILER_STALE_THRESHOLD_MINUTES + 1) * 60 * 1000),
    });
    const atThresholdRow = buildRow({
      lastRunAt: new Date(now.getTime() - RECONCILER_STALE_THRESHOLD_MINUTES * 60 * 1000),
    });

    const staleResult = evaluateReconcilerHealth(staleRow, now, THRESHOLDS);
    expect(staleResult.healthy).toBe(false);
    expect(staleResult.reasons).toContain("stale_last_run");

    const atThresholdResult = evaluateReconcilerHealth(atThresholdRow, now, THRESHOLDS);
    expect(atThresholdResult.healthy).toBe(true);
  });

  it("test 3: an aged reconciling backlog is unhealthy with reconciling_backlog_aged", () => {
    const now = new Date("2027-01-10T00:00:00Z");
    const agedRow = buildRow({
      lastRunAt: now,
      oldestReconcilingSince: new Date(now.getTime() - (RECONCILING_AGE_ALERT_HOURS + 1) * 60 * 60 * 1000),
    });

    const result = evaluateReconcilerHealth(agedRow, now, THRESHOLDS);
    expect(result.healthy).toBe(false);
    expect(result.reasons).toContain("reconciling_backlog_aged");
  });

  it("test 4: a null oldestReconcilingSince and a fresh lastRunAt is healthy", () => {
    const now = new Date("2027-01-10T00:00:00Z");
    const healthyRow = buildRow({ lastRunAt: now, oldestReconcilingSince: null });

    const result = evaluateReconcilerHealth(healthyRow, now, THRESHOLDS);
    expect(result.healthy).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("test 5: both unhealthy conditions at once return both reasons", () => {
    const now = new Date("2027-01-10T00:00:00Z");
    const bothRow = buildRow({
      lastRunAt: new Date(now.getTime() - (RECONCILER_STALE_THRESHOLD_MINUTES + 1) * 60 * 1000),
      oldestReconcilingSince: new Date(now.getTime() - (RECONCILING_AGE_ALERT_HOURS + 1) * 60 * 60 * 1000),
    });

    const result = evaluateReconcilerHealth(bothRow, now, THRESHOLDS);
    expect(result.healthy).toBe(false);
    expect(result.reasons).toContain("stale_last_run");
    expect(result.reasons).toContain("reconciling_backlog_aged");
  });

  it("test 6: renderReconcilerAlertText carries the tripped reasons, checked-at timestamp, last_run_at, the four tick counters, and the backlog age in hours", () => {
    const now = new Date("2027-01-10T00:00:00Z");
    const row = buildRow({
      lastRunAt: new Date(now.getTime() - 10 * 60 * 1000),
      candidatesScanned: 12,
      rowsResolved: 5,
      rowsMarkedUnknown: 3,
      staleDispatchingSwept: 2,
      oldestReconcilingSince: new Date(now.getTime() - (RECONCILING_AGE_ALERT_HOURS + 5) * 60 * 60 * 1000),
    });
    const result = evaluateReconcilerHealth(row, now, THRESHOLDS);

    const body = renderReconcilerAlertText(row, result.reasons, now);
    expect(body).toContain(result.reasons.join(", "));
    expect(body).toContain(now.toISOString());
    expect(body).toContain(row.lastRunAt.toISOString());
    expect(body).toContain("candidates_scanned=12");
    expect(body).toContain("rows_resolved=5");
    expect(body).toContain("rows_marked_unknown=3");
    expect(body).toContain("stale_dispatching_swept=2");
    expect(body).toMatch(/\(\d+\.\d+h old\)/);
  });

  it("test 7: the rendered body matches no UUID pattern, no email pattern, and never contains 'Bearer'", () => {
    const now = new Date("2027-01-10T00:00:00Z");
    const row = buildRow({
      lastRunAt: new Date(now.getTime() - (RECONCILER_STALE_THRESHOLD_MINUTES + 1) * 60 * 1000),
      oldestReconcilingSince: new Date(now.getTime() - (RECONCILING_AGE_ALERT_HOURS + 1) * 60 * 60 * 1000),
    });
    const result = evaluateReconcilerHealth(row, now, THRESHOLDS);
    const body = renderReconcilerAlertText(row, result.reasons, now);

    const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const emailPattern = /[^\s@]+@[^\s@]+\.[^\s@]+/;

    expect(body).not.toMatch(uuidPattern);
    expect(body).not.toMatch(emailPattern);
    expect(body).not.toContain("Bearer");

    // Also true of the missing-row body.
    const missingBody = renderReconcilerAlertText(null, ["missing_health_row"], now);
    expect(missingBody).not.toMatch(uuidPattern);
    expect(missingBody).not.toMatch(emailPattern);
    expect(missingBody).not.toContain("Bearer");
  });
});

describe("claimReconcilerAlertSlot dedup / checkReconcilerHealthAndAlert (T-11-09-01/02/03/04)", () => {
  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    pool.on("error", () => {
      // expected: test 9 below deliberately drives two independent pools
      // against the same row, mirroring partition-watchdog.test.ts's own
      // multi-pool convention.
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("test 8: at most one send per RECONCILER_ALERT_DEDUP_HOURS window, even across repeated unhealthy checks", async () => {
    const t1 = new Date("2027-02-01T00:00:00Z");
    // Unhealthy at t1 (and, since staleness only grows with now, at every
    // later checkpoint too) via stale_last_run -- this is what actually
    // drives checkReconcilerHealthAndAlert's own claim-then-send path below;
    // the direct claimReconcilerAlertSlot probe right after this is
    // independent of health and would pass regardless.
    const staleLastRunAt = new Date(t1.getTime() - (RECONCILER_STALE_THRESHOLD_MINUTES + 1) * 60 * 1000);
    await seedReconcilerRow({ lastRunAt: staleLastRunAt, lastAlertSentAt: null });

    const directFirstClaim = await claimReconcilerAlertSlot(pool, t1, RECONCILER_ALERT_DEDUP_HOURS);
    expect(directFirstClaim).toBe(true);
    const directSecondClaim = await claimReconcilerAlertSlot(
      pool,
      new Date(t1.getTime() + 60_000),
      RECONCILER_ALERT_DEDUP_HOURS,
    );
    expect(directSecondClaim).toBe(false);

    // Reset the claim this direct probe just took, so the
    // checkReconcilerHealthAndAlert flow below starts from a clean slate.
    await seedReconcilerRow({ lastRunAt: staleLastRunAt, lastAlertSentAt: null });

    const sent: Array<{ to: string; text: string }> = [];
    // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
    const sendMail = async (message: { to: string; text: string }) => {
      sent.push(message);
    };

    await checkReconcilerHealthAndAlert({ client: pool, now: t1, operatorEmail: "ops@example.com", sendMail });
    expect(sent).toHaveLength(1);

    const t2 = new Date(t1.getTime() + 60_000); // still deduped
    await checkReconcilerHealthAndAlert({ client: pool, now: t2, operatorEmail: "ops@example.com", sendMail });
    expect(sent).toHaveLength(1);

    const t3 = new Date(t1.getTime() + (RECONCILER_ALERT_DEDUP_HOURS + 1) * 60 * 60 * 1000); // past the window
    await checkReconcilerHealthAndAlert({ client: pool, now: t3, operatorEmail: "ops@example.com", sendMail });
    expect(sent).toHaveLength(2);
  });

  it("test 9: checkReconcilerHealthAndAlert sends nothing when healthy and does not touch last_alert_sent_at", async () => {
    const now = new Date();
    const previousAlertSentAt = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    await seedReconcilerRow({ lastRunAt: now, oldestReconcilingSince: null, lastAlertSentAt: previousAlertSentAt });

    const sent: Array<{ to: string; text: string }> = [];
    // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
    const sendMail = async (message: { to: string; text: string }) => {
      sent.push(message);
    };

    await checkReconcilerHealthAndAlert({ client: pool, now, operatorEmail: "ops@example.com", sendMail });
    expect(sent).toHaveLength(0);

    const { rows } = await pool.query<{ last_alert_sent_at: Date }>(
      "SELECT last_alert_sent_at FROM send_reconciler_runs WHERE id = 1",
    );
    expect(rows[0]?.last_alert_sent_at.getTime()).toBe(previousAlertSentAt.getTime());
  });

  it("test 10: two concurrent replicas checking the same unhealthy row produce exactly one send", async () => {
    await seedReconcilerRow({ lastRunAt: new Date(Date.now() - 60 * 60 * 1000), lastAlertSentAt: null });

    const dsn = getTestDatabaseUrl();
    const poolA = new Pool({ connectionString: dsn, max: 2 });
    const poolB = new Pool({ connectionString: dsn, max: 2 });
    poolA.on("error", () => undefined);
    poolB.on("error", () => undefined);

    const sent: Array<{ to: string; text: string }> = [];
    // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
    const sendMail = async (message: { to: string; text: string }) => {
      sent.push(message);
    };
    const now = new Date();

    try {
      await Promise.all([
        checkReconcilerHealthAndAlert({ client: poolA, now, operatorEmail: "ops@example.com", sendMail }),
        checkReconcilerHealthAndAlert({ client: poolB, now, operatorEmail: "ops@example.com", sendMail }),
      ]);
    } finally {
      await poolA.end();
      await poolB.end();
    }

    expect(sent).toHaveLength(1);
  });

  it("test 11: a rejecting sendMail causes checkReconcilerHealthAndAlert to reject, never swallowed, and does not permanently burn the dedup window (CR-02)", async () => {
    const now = new Date();
    await seedReconcilerRow({ lastRunAt: new Date(now.getTime() - 60 * 60 * 1000), lastAlertSentAt: null });

    await expect(
      checkReconcilerHealthAndAlert({
        client: pool,
        now,
        operatorEmail: "ops@example.com",
        sendMail: () => Promise.reject(new Error("sendgrid down")),
      }),
    ).rejects.toThrow("sendgrid down");

    const { rows } = await pool.query<{ last_alert_sent_at: Date | null }>(
      "SELECT last_alert_sent_at FROM send_reconciler_runs WHERE id = 1",
    );
    expect(rows[0]?.last_alert_sent_at).toBeNull();

    // The very next check, moments later, still inside the dedup window,
    // must be able to claim and actually send.
    const sent: Array<{ to: string; text: string }> = [];
    await checkReconcilerHealthAndAlert({
      client: pool,
      now: new Date(now.getTime() + 1_000),
      operatorEmail: "ops@example.com",
      // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
      sendMail: async (message) => {
        sent.push(message);
      },
    });
    expect(sent).toHaveLength(1);
  });
});
