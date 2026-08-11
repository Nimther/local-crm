import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyMigrationFile,
  createEphemeralDatabase,
  dropEphemeralDatabase,
  listMigrationFiles,
} from "@mega-crm/test-support";

import {
  BUFFER_ALERT_THRESHOLD_MONTHS,
  LOOKAHEAD_MONTHS,
  PARTITIONED_TABLES,
  ensurePartitions,
} from "@mega-crm/db/src/partitions/ensure-partitions.js";
import { runPartitionMaintenance } from "@mega-crm/db/src/partitions/maintenance-run.js";
import { checkPartitionHealthAndAlert } from "../partition-watchdog.js";

/**
 * 09-01 task 1 -- the tracer: drives migration -> DDL function -> health row
 * -> cross-process read -> plain-text alert as ONE path, against a real
 * ephemeral Postgres, before anything is scheduled. Provisions its OWN
 * database (mirrors packages/db/src/__tests__/migrate-from-empty.test.ts)
 * rather than the apps/api-wide globalSetup database, so the full migration
 * chain -- including catch-up migration 0038 -- is proven to apply from
 * empty, not merely a no-op replay against an already-migrated database.
 */

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../../packages/db/migrations",
);

interface PartitionRow {
  relname: string;
  relispartition: boolean;
  bound: string | null;
}

function parseBound(expr: string): { from: string; to: string } {
  const match = /FOR VALUES FROM \(([^)]+)\) TO \(([^)]+)\)/.exec(expr);
  if (!match) {
    throw new Error(`could not parse partition bound expression: ${expr}`);
  }
  return { from: match[1], to: match[2] };
}

describe("Partition maintenance tracer (DB-01/DB-02, 09-01 task 1)", () => {
  let pool: Pool;
  let databaseName: string;
  let adminDsn: string;

  beforeAll(async () => {
    const created = await createEphemeralDatabase({ workspace: "partition-maintenance-tracer" });
    databaseName = created.databaseName;
    adminDsn = created.adminDsn;
    // Force every physical connection this pool ever opens onto a UTC
    // session TimeZone, from connection time onward -- the local Postgres
    // server backing this suite may default to a non-UTC zone (e.g. the
    // developer machine's own TimeZone), which would otherwise make the
    // EARLIER, timezone-implicit migrations (0007/0020's bare '2026-08-01'
    // literals) apply relative to a non-UTC session while THIS migration's
    // explicit '+00' bounds apply relative to UTC -- a spurious mismatch at
    // the month boundary that has nothing to do with either migration's own
    // correctness. A correctly configured production/CI Postgres runs under
    // UTC by default; this makes the test environment match that assumption
    // rather than depend on whatever zone the local server happens to use.
    pool = new Pool({ connectionString: created.dsn, max: 5, options: "-c timezone=UTC" });

    const files = listMigrationFiles(MIGRATIONS_DIR);
    for (const file of files) {
      await applyMigrationFile(pool, MIGRATIONS_DIR, file);
    }
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (databaseName) await dropEphemeralDatabase(databaseName, adminDsn);
  });

  // 09-REVIEW CR-01: this must run before any other test in this file
  // touches `partition_maintenance_runs` (test 3/test 4 below are the first
  // ones that do, via runPartitionMaintenance) -- it asserts on the table's
  // state exactly as the migration chain alone leaves it, which is the
  // "maintenance worker has never run" condition the dead-man's-switch
  // exists to catch. Placed right after the migration chain applies in
  // beforeAll, before test 1/2 (which never touch this table either).
  it("test 0 (09-REVIEW CR-01): a freshly migrated database, before the maintenance worker has ever run, still lets the watchdog send", async () => {
    // Migration 0040 seeds exactly one sentinel row for id = 1, with
    // last_run_at far enough in the past to trip stale_last_run -- the
    // table must never be genuinely empty in production, because
    // claimAlertSlot's single conditional UPDATE ... WHERE id = 1 matches
    // zero rows (and therefore never claims/sends) against a table that
    // has never had a row written to it.
    const { rows: countRows } = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM partition_maintenance_runs`,
    );
    expect(Number(countRows[0]?.count)).toBe(1);

    const sent: Array<{ to: string; text: string }> = [];
    await checkPartitionHealthAndAlert({
      client: pool,
      now: new Date(),
      operatorEmail: "ops@example.com",
      // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous, matches the async PartitionWatchdogDeps.sendMail signature
      sendMail: async (message) => {
        sent.push(message);
      },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("ops@example.com");
    // The sentinel row's own last_run_at ('epoch') is the "worker never
    // ran" signal made concrete -- it is always stale relative to any real
    // "now", so this reason must always appear here.
    expect(sent[0]?.text).toMatch(/stale_last_run/i);
  });

  it("test 1: the catch-up migration closes the 2026-09-01 deadline with no gap or overlap at the month boundary", async () => {
    const { rows } = await pool.query<PartitionRow>(
      `SELECT c.relname, c.relispartition, pg_get_expr(c.relpartbound, c.oid) AS bound
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = ANY($1)`,
      [["events_2026_08", "events_2026_09", "send_events_2026_08", "send_events_2026_09"]],
    );
    const byName = new Map(rows.map((r) => [r.relname, r]));

    for (const name of ["events_2026_08", "events_2026_09", "send_events_2026_08", "send_events_2026_09"]) {
      const row = byName.get(name);
      expect(row, `${name} should exist after the migration chain`).toBeDefined();
      expect(row?.relispartition, `${name} should be attached (relispartition)`).toBe(true);
    }

    const eventsAugBound = parseBound(byName.get("events_2026_08")!.bound!);
    const eventsSepBound = parseBound(byName.get("events_2026_09")!.bound!);
    expect(eventsSepBound.from, "events_2026_09's lower bound must abut events_2026_08's upper bound").toBe(
      eventsAugBound.to,
    );
  });

  it("test 2: ensurePartitions creates missing months idempotently through CHECK-constraint-first attach", async () => {
    await pool.query(`DROP TABLE events_2027_06`);
    await pool.query(`DROP TABLE send_events_2027_06`);

    const now = new Date("2027-05-15T00:00:00Z");
    const results = await ensurePartitions(pool, PARTITIONED_TABLES, now, LOOKAHEAD_MONTHS);

    const eventsResult = results.find((r) => r.table === "events");
    const sendEventsResult = results.find((r) => r.table === "send_events");
    expect(eventsResult?.created).toContain("events_2027_06");
    expect(sendEventsResult?.created).toContain("send_events_2027_06");

    const allCreated = [...(eventsResult?.created ?? []), ...(sendEventsResult?.created ?? [])];
    expect(allCreated.length).toBeGreaterThan(0);

    for (const name of allCreated) {
      const { rows } = await pool.query<{ relispartition: boolean }>(
        `SELECT relispartition FROM pg_class WHERE relname = $1`,
        [name],
      );
      expect(rows[0]?.relispartition, `${name} must be attached, not freestanding`).toBe(true);
    }

    // No orphaned freestanding table: every events_%/send_events_% relation
    // must be a partition (relispartition = true) after this call.
    const { rows: unattached } = await pool.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND NOT c.relispartition
          AND (c.relname LIKE 'events_%' OR c.relname LIKE 'send_events_%')`,
    );
    expect(unattached.map((r) => r.relname)).toEqual([]);

    const second = await ensurePartitions(pool, PARTITIONED_TABLES, now, LOOKAHEAD_MONTHS);
    for (const r of second) {
      expect(r.created, `a second identical ensurePartitions call must report zero created for ${r.table}`).toEqual(
        [],
      );
    }
  });

  it("test 3: runPartitionMaintenance writes exactly one health row", async () => {
    const now = new Date("2027-05-15T00:00:00Z");
    const snapshot = await runPartitionMaintenance(pool, now, {
      lookaheadMonths: LOOKAHEAD_MONTHS,
      bufferAlertThresholdMonths: BUFFER_ALERT_THRESHOLD_MONTHS,
    });

    expect(snapshot.eventsDefaultCount).toBe(0);
    expect(snapshot.sendEventsDefaultCount).toBe(0);
    expect(snapshot.bufferMonthsRemaining).toBe(Math.min(snapshot.eventsBufferMonths, snapshot.sendEventsBufferMonths));

    const { rows: countRows } = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM partition_maintenance_runs`,
    );
    expect(Number(countRows[0]?.count)).toBe(1);

    const { rows } = await pool.query<{ last_run_at: Date; buffer_months_remaining: number }>(
      `SELECT last_run_at, buffer_months_remaining FROM partition_maintenance_runs WHERE id = 1`,
    );
    expect(rows[0]?.last_run_at).toEqual(now);
    expect(rows[0]?.buffer_months_remaining).toBe(snapshot.bufferMonthsRemaining);
  });

  it("test 4: an exhausted buffer, recorded by one process, produces exactly one alert read by another", async () => {
    await pool.query(`DROP TABLE events_2027_06`);
    await pool.query(`DROP TABLE send_events_2027_06`);

    const now = new Date("2027-05-15T00:00:00Z");
    await runPartitionMaintenance(pool, now, {
      lookaheadMonths: LOOKAHEAD_MONTHS,
      bufferAlertThresholdMonths: BUFFER_ALERT_THRESHOLD_MONTHS,
    });

    const sent: Array<{ to: string; text: string; html?: string }> = [];
    await checkPartitionHealthAndAlert({
      client: pool,
      now,
      operatorEmail: "ops@example.com",
      // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous, matches the async PartitionWatchdogDeps.sendMail signature
      sendMail: async (message) => {
        sent.push(message);
      },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("ops@example.com");
    expect(sent[0]?.text).toBeTruthy();
    expect(sent[0]?.html).toBeUndefined();
    expect(sent[0]?.text).toContain("events");
    expect(sent[0]?.text).toContain("send_events");
    expect(sent[0]?.text).toContain(now.toISOString());
  });

  it("test 5: a healthy state produces zero alert sends", async () => {
    // The previous test's runPartitionMaintenance call already healed the
    // gap it manufactured (ensurePartitions recreates missing months within
    // the same call) -- a fresh run now finds a fully healthy state.
    const now = new Date("2027-05-15T00:10:00Z");
    await runPartitionMaintenance(pool, now, {
      lookaheadMonths: LOOKAHEAD_MONTHS,
      bufferAlertThresholdMonths: BUFFER_ALERT_THRESHOLD_MONTHS,
    });

    const sent: unknown[] = [];
    await checkPartitionHealthAndAlert({
      client: pool,
      now,
      operatorEmail: "ops@example.com",
      // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous, matches the async PartitionWatchdogDeps.sendMail signature
      sendMail: async (message) => {
        sent.push(message);
      },
    });

    expect(sent).toHaveLength(0);
  });
});
