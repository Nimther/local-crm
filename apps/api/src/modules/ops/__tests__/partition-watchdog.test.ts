import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db as sharedDb, organization } from "@mega-crm/db";
import { pool, withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import {
  BUFFER_ALERT_THRESHOLD_MONTHS,
  LOOKAHEAD_MONTHS,
} from "@mega-crm/db/src/partitions/ensure-partitions.js";
import type { PartitionMaintenanceRunRow } from "@mega-crm/db/src/partitions/maintenance-run.js";

import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";
import { env } from "../../../env.js";
import {
  ALERT_DEDUP_HOURS,
  STALE_THRESHOLD_HOURS,
  checkPartitionHealthAndAlert,
  claimAlertSlot,
  evaluatePartitionHealth,
  renderOperatorAlertText,
} from "../partition-watchdog.js";

/**
 * 09-01 task 2 (D-02/D-03): the full unhealthy-condition matrix on
 * `evaluatePartitionHealth`/`renderOperatorAlertText` (pure, no DB), plus
 * `claimAlertSlot`'s atomic once-per-day dedup and the "no tenant data leaks
 * into the alert body" property (needs the shared apps/api test database).
 */

const THRESHOLDS = { staleThresholdHours: STALE_THRESHOLD_HOURS, bufferAlertThresholdMonths: BUFFER_ALERT_THRESHOLD_MONTHS };

function buildRow(overrides: Partial<PartitionMaintenanceRunRow> = {}): PartitionMaintenanceRunRow {
  return {
    id: 1,
    lastRunAt: new Date(),
    lookaheadMonths: LOOKAHEAD_MONTHS,
    bufferAlertThresholdMonths: BUFFER_ALERT_THRESHOLD_MONTHS,
    eventsBufferMonths: 3,
    sendEventsBufferMonths: 3,
    bufferMonthsRemaining: 3,
    eventsDefaultCount: 0,
    sendEventsDefaultCount: 0,
    partitionsCreated: [],
    lastAlertSentAt: null,
    updatedAt: new Date(),
    ...overrides,
  };
}

async function seedHealthRow(overrides: Partial<PartitionMaintenanceRunRow> = {}): Promise<void> {
  const row = buildRow(overrides);
  await pool.query(
    `INSERT INTO partition_maintenance_runs (
       id, last_run_at, lookahead_months, buffer_alert_threshold_months,
       events_buffer_months, send_events_buffer_months, buffer_months_remaining,
       events_default_count, send_events_default_count, partitions_created,
       last_alert_sent_at, updated_at
     ) VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     ON CONFLICT (id) DO UPDATE SET
       last_run_at = EXCLUDED.last_run_at,
       lookahead_months = EXCLUDED.lookahead_months,
       buffer_alert_threshold_months = EXCLUDED.buffer_alert_threshold_months,
       events_buffer_months = EXCLUDED.events_buffer_months,
       send_events_buffer_months = EXCLUDED.send_events_buffer_months,
       buffer_months_remaining = EXCLUDED.buffer_months_remaining,
       events_default_count = EXCLUDED.events_default_count,
       send_events_default_count = EXCLUDED.send_events_default_count,
       partitions_created = EXCLUDED.partitions_created,
       last_alert_sent_at = EXCLUDED.last_alert_sent_at,
       updated_at = now()`,
    [
      row.lastRunAt,
      row.lookaheadMonths,
      row.bufferAlertThresholdMonths,
      row.eventsBufferMonths,
      row.sendEventsBufferMonths,
      row.bufferMonthsRemaining,
      row.eventsDefaultCount,
      row.sendEventsDefaultCount,
      row.partitionsCreated,
      row.lastAlertSentAt,
    ],
  );
}

describe("evaluatePartitionHealth / renderOperatorAlertText (pure, no DB)", () => {
  it("test 1: a stale last run is unhealthy; 25h is still healthy on that axis", () => {
    const now = new Date("2027-01-10T00:00:00Z");
    const staleRow = buildRow({ lastRunAt: new Date(now.getTime() - 27 * 60 * 60 * 1000) });
    const freshRow = buildRow({ lastRunAt: new Date(now.getTime() - 25 * 60 * 60 * 1000) });

    const staleResult = evaluatePartitionHealth(staleRow, now, THRESHOLDS);
    expect(staleResult.healthy).toBe(false);
    expect(staleResult.reasons).toContain("stale_last_run");

    const freshResult = evaluatePartitionHealth(freshRow, now, THRESHOLDS);
    expect(freshResult.healthy).toBe(true);
  });

  it("test 2: an absent health row is unhealthy, and the alert body says so", () => {
    const now = new Date("2027-01-10T00:00:00Z");
    const result = evaluatePartitionHealth(null, now, THRESHOLDS);
    expect(result.healthy).toBe(false);
    expect(result.reasons).toContain("missing_health_row");

    const body = renderOperatorAlertText(null, result.reasons, now);
    expect(body).toMatch(/no partition_maintenance_runs row/i);
  });

  it("test 3: buffer exactly at the threshold is healthy, one below is not", () => {
    const now = new Date("2027-01-10T00:00:00Z");
    const atThreshold = buildRow({ lastRunAt: now, bufferMonthsRemaining: BUFFER_ALERT_THRESHOLD_MONTHS });
    const belowThreshold = buildRow({
      lastRunAt: now,
      bufferMonthsRemaining: BUFFER_ALERT_THRESHOLD_MONTHS - 1,
    });

    expect(evaluatePartitionHealth(atThreshold, now, THRESHOLDS).healthy).toBe(true);
    const belowResult = evaluatePartitionHealth(belowThreshold, now, THRESHOLDS);
    expect(belowResult.healthy).toBe(false);
    expect(belowResult.reasons).toContain("low_buffer");
  });

  it("test 4: a non-zero DEFAULT count is unhealthy for either table, and instructs the relocation procedure", () => {
    const now = new Date("2027-01-10T00:00:00Z");

    const eventsDefaultRow = buildRow({ lastRunAt: now, eventsDefaultCount: 1 });
    const eventsResult = evaluatePartitionHealth(eventsDefaultRow, now, THRESHOLDS);
    expect(eventsResult.healthy).toBe(false);
    expect(eventsResult.reasons).toContain("events_default_nonzero");
    expect(renderOperatorAlertText(eventsDefaultRow, eventsResult.reasons, now)).toMatch(/relocat/i);

    const sendEventsDefaultRow = buildRow({ lastRunAt: now, sendEventsDefaultCount: 1 });
    const sendEventsResult = evaluatePartitionHealth(sendEventsDefaultRow, now, THRESHOLDS);
    expect(sendEventsResult.healthy).toBe(false);
    expect(sendEventsResult.reasons).toContain("send_events_default_nonzero");
    expect(renderOperatorAlertText(sendEventsDefaultRow, sendEventsResult.reasons, now)).toMatch(/relocat/i);
  });
});

describe("claimAlertSlot dedup / checkPartitionHealthAndAlert (D-02/D-03/T-09-03/T-09-04/T-09-05)", () => {
  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    pool.on("error", () => {
      // expected: test 6 below deliberately drives two independent pools
      // against the same row; a benign pool-level error listener is required
      // the same way apps/api/src/db/__tests__/rls-pooling-chaos.test.ts's is.
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("test 5: at most one send per ALERT_DEDUP_HOURS window, even across repeated unhealthy checks", async () => {
    const t1 = new Date("2027-02-01T00:00:00Z");
    await seedHealthRow({ lastRunAt: t1, bufferMonthsRemaining: 1, lastAlertSentAt: null });

    // claimAlertSlot's own return-value contract, directly: the single
    // conditional UPDATE ... RETURNING resolves true exactly when it
    // actually claimed the slot.
    const directFirstClaim = await claimAlertSlot(pool, t1, ALERT_DEDUP_HOURS);
    expect(directFirstClaim).toBe(true);
    const directSecondClaim = await claimAlertSlot(pool, new Date(t1.getTime() + 60_000), ALERT_DEDUP_HOURS);
    expect(directSecondClaim).toBe(false);

    // Reset the claim this direct probe just took, so the
    // checkPartitionHealthAndAlert flow below starts from a clean slate.
    await seedHealthRow({ lastRunAt: t1, bufferMonthsRemaining: 1, lastAlertSentAt: null });

    const sent: Array<{ to: string; text: string }> = [];
    // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
    const sendMail = async (message: { to: string; text: string }) => {
      sent.push(message);
    };

    await checkPartitionHealthAndAlert({ client: pool, now: t1, operatorEmail: "ops@example.com", sendMail });
    expect(sent).toHaveLength(1);

    const t2 = new Date(t1.getTime() + 60_000); // 1 minute later -- still deduped
    await checkPartitionHealthAndAlert({ client: pool, now: t2, operatorEmail: "ops@example.com", sendMail });
    expect(sent).toHaveLength(1);

    const t3 = new Date(t1.getTime() + (ALERT_DEDUP_HOURS + 1) * 60 * 60 * 1000); // past the dedup window
    await checkPartitionHealthAndAlert({ client: pool, now: t3, operatorEmail: "ops@example.com", sendMail });
    expect(sent).toHaveLength(2);
  });

  it("test 6: two concurrent replicas checking the same unhealthy row produce exactly one send", async () => {
    await seedHealthRow({ lastRunAt: new Date(), bufferMonthsRemaining: 1, lastAlertSentAt: null });

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
        checkPartitionHealthAndAlert({ client: poolA, now, operatorEmail: "ops@example.com", sendMail }),
        checkPartitionHealthAndAlert({ client: poolB, now, operatorEmail: "ops@example.com", sendMail }),
      ]);
    } finally {
      await poolA.end();
      await poolB.end();
    }

    expect(sent).toHaveLength(1);
  });

  it("test 7: the alert body carries no tenant data, no credential, and no connection string", async () => {
    const workspaceId = randomUUID();
    const contactId = randomUUID();
    const eventPayloadMarker = `secret-payload-${randomUUID()}`;

    await sharedDb.insert(organization).values({
      id: workspaceId,
      name: "Leak probe Co",
      slug: `leak-probe-${workspaceId.slice(0, 8)}`,
      createdAt: new Date(),
    });

    await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        await client.query(`INSERT INTO contacts (id, workspace_id, external_id) VALUES ($1, $2, $3)`, [
          contactId,
          workspaceId,
          "leak-probe-contact",
        ]);
        await client.query(
          `INSERT INTO events (id, workspace_id, contact_id, name, properties, occurred_at)
           VALUES ($1, $2, $3, $4, $5, now())`,
          [randomUUID(), workspaceId, contactId, "probe_event", JSON.stringify({ marker: eventPayloadMarker })],
        );
      }),
    );

    await seedHealthRow({ lastRunAt: new Date(), bufferMonthsRemaining: 1, lastAlertSentAt: null });

    const sent: Array<{ to: string; text: string }> = [];
    await checkPartitionHealthAndAlert({
      client: pool,
      now: new Date(),
      operatorEmail: "ops@example.com",
      // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
      sendMail: async (message) => {
        sent.push(message);
      },
    });

    expect(sent).toHaveLength(1);
    const body = sent[0]?.text ?? "";
    expect(body).not.toContain(workspaceId);
    expect(body).not.toContain(contactId);
    expect(body).not.toContain(eventPayloadMarker);
    expect(body).not.toContain(env.PLATFORM_SENDGRID_API_KEY);
    expect(body.toLowerCase()).not.toMatch(/postgres(ql)?:\/\//);
  });

  it("test 8: a rejecting sendMail causes checkPartitionHealthAndAlert to reject, never swallowed", async () => {
    await seedHealthRow({ lastRunAt: new Date(), bufferMonthsRemaining: 1, lastAlertSentAt: null });

    await expect(
      checkPartitionHealthAndAlert({
        client: pool,
        now: new Date(),
        operatorEmail: "ops@example.com",
        sendMail: () => Promise.reject(new Error("sendgrid down")),
      }),
    ).rejects.toThrow("sendgrid down");
  });
});
