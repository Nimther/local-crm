import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyMigrationFile,
  createEphemeralDatabase,
  dropEphemeralDatabase,
  listMigrationFiles,
} from "@mega-crm/test-support";

import { PARTITIONED_TABLES, type PartitionedTableConfig } from "../ensure-partitions.js";
import {
  RELOCATE_ADVISORY_LOCK_KEY,
  RELOCATE_BATCH_SIZE,
  countDefaultRowsForTable,
  discoverDefaultMonths,
  relocateAllDefaultRows,
  type RelocationReport,
} from "../relocate-default.js";

/**
 * 09-04 task 1 (DB-03/DB-04, D-08/D-09): the batched DEFAULT relocation
 * core against a real ephemeral Postgres. Provisions its own database
 * (mirrors packages/db/src/__tests__/migrate-from-empty.test.ts) so the full
 * migration chain -- including 0038's catch-up partitions -- is what
 * determines which months land in DEFAULT.
 *
 * 0038 pre-creates events/send_events partitions for 2026-09 through
 * 2027-06 inclusive, so this suite deliberately seeds months OUTSIDE that
 * window (2027-07 onward, plus a 2031-04 far-future timestamp) -- any
 * occurred_at in those months has nowhere to go but DEFAULT.
 */

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const EVENTS_TABLE: PartitionedTableConfig = PARTITIONED_TABLES.find((t) => t.parentTable === "events")!;
const SEND_EVENTS_TABLE: PartitionedTableConfig = PARTITIONED_TABLES.find(
  (t) => t.parentTable === "send_events",
)!;

// Months used by this suite, deliberately outside migration 0038's
// pre-created 2026-09..2027-06 range so every seeded row lands in DEFAULT.
const MONTH_A = new Date(Date.UTC(2027, 6, 15, 12, 0, 0)); // 2027-07
const MONTH_B = new Date(Date.UTC(2027, 7, 15, 12, 0, 0)); // 2027-08
const MONTH_WILD = new Date(Date.UTC(2031, 3, 15, 12, 0, 0)); // 2031-04 (D-09 far-future)
const MONTH_BATCH = new Date(Date.UTC(2027, 8, 15, 12, 0, 0)); // 2027-09 (batching test)
const MONTH_BOTH = new Date(Date.UTC(2027, 9, 15, 12, 0, 0)); // 2027-10 (both-tables test)

function monthLabel(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function seedEvents(
  pool: Pool,
  workspaceId: string,
  contactId: string,
  occurredAt: Date,
  count: number,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
    await client.query(
      `INSERT INTO events (id, workspace_id, contact_id, name, properties, occurred_at)
       SELECT gen_random_uuid(), $1, $2, 'relocate_test_event', '{}'::jsonb, $3::timestamptz
         FROM generate_series(1, $4)`,
      [workspaceId, contactId, occurredAt, count],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function seedSendEvents(
  pool: Pool,
  workspaceId: string,
  occurredAt: Date,
  count: number,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
    await client.query(
      `INSERT INTO send_events (id, workspace_id, sg_event_id, event_type, payload, occurred_at)
       SELECT gen_random_uuid(), $1, 'sg-evt-' || gen_random_uuid()::text, 'delivered', '{}'::jsonb, $2::timestamptz
         FROM generate_series(1, $3)`,
      [workspaceId, occurredAt, count],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Direct-by-name query against a PARTITION (not the parent) -- bypasses RLS
 * the same way `countDefaultRowsForTable`/`maintenance-run.ts`'s
 * `countDefaultRows` already rely on (partitions do not enforce the parent's
 * RLS policy unless accessed THROUGH the parent). Safe here because a
 * partition name is never ambiguous about which physical table it counts.
 */
async function countRelation(pool: Pool, relation: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(`SELECT count(*) AS count FROM ${relation}`);
  return Number(rows[0]?.count ?? 0);
}

/**
 * Counts the PARENT table's total row count -- unlike a partition, querying
 * the parent by name DOES enforce `workspace_isolation` RLS, so this must
 * run inside a tenant-scoped transaction (SET LOCAL app.current_workspace_id)
 * exactly like ordinary application code, never a bare `pool.query`.
 */
async function countParentRows(pool: Pool, workspaceId: string, parentTable: string): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
    const { rows } = await client.query<{ count: string }>(`SELECT count(*) AS count FROM ${parentTable}`);
    await client.query("COMMIT");
    return Number(rows[0]?.count ?? 0);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

function tableReport(report: RelocationReport, table: string) {
  const found = report.tables.find((t) => t.table === table);
  if (!found) throw new Error(`relocation report missing table "${table}"`);
  return found;
}

describe("relocate-default (09-04 task 1, DB-03/DB-04)", () => {
  let pool: Pool;
  let relocationPool: Pool;
  let databaseName: string;
  let adminDsn: string;
  let workspaceId: string;
  let contactId: string;

  let totalEventsBeforeRelocation: number;

  beforeAll(async () => {
    const created = await createEphemeralDatabase({ workspace: "relocate-default" });
    databaseName = created.databaseName;
    adminDsn = created.adminDsn;
    // Same UTC-forcing rationale as apps/api's partition-maintenance-tracer
    // test: keeps month-boundary arithmetic independent of the local
    // Postgres server's own default session TimeZone.
    pool = new Pool({ connectionString: created.dsn, max: 5, options: "-c timezone=UTC" });

    // A SEPARATE pool for every call into relocate-default.ts, mirroring
    // production: the maintenance worker/CLI script that calls
    // ensurePartitions/attachPartitionCheckFirst constructs its own
    // dedicated pool, never sharing physical connections with the app's
    // tenant-scoped `@mega-crm/tenant-context` pool. `pool` above (used for
    // seeding via SET LOCAL app.current_workspace_id) must never be handed
    // to a relocate-default.ts function -- a connection recycled from a
    // tenant-scoped transaction reverts `app.current_workspace_id` to ''
    // (not NULL), and contacts'/sends' PRE-PHASE-10 bare-cast RLS policies
    // (pinned by packages/tenant-context/src/__tests__/tenant-context.test.ts)
    // throw on that, independent of the admin-scan policy migration 0039
    // adds (see that migration's own comment, and ensure-partitions.ts's).
    relocationPool = new Pool({ connectionString: created.dsn, max: 5, options: "-c timezone=UTC" });

    const files = listMigrationFiles(MIGRATIONS_DIR);
    for (const file of files) {
      await applyMigrationFile(pool, MIGRATIONS_DIR, file);
    }

    workspaceId = randomUUID();
    await pool.query(`INSERT INTO organization (id, name, slug) VALUES ($1, $2, $3)`, [
      workspaceId,
      "Relocate Test Co",
      `relocate-test-${workspaceId.slice(0, 8)}`,
    ]);

    contactId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
      await client.query(`INSERT INTO contacts (id, workspace_id, external_id) VALUES ($1, $2, $3)`, [
        contactId,
        workspaceId,
        `relocate-contact-${contactId.slice(0, 8)}`,
      ]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }, 60_000);

  afterAll(async () => {
    await relocationPool?.end();
    await pool?.end();
    if (databaseName) await dropEphemeralDatabase(databaseName, adminDsn);
  });

  it("test 1: discovers exactly the months seeded into DEFAULT, including a far-future one (D-09)", async () => {
    await seedEvents(pool, workspaceId, contactId, MONTH_A, 5);
    await seedEvents(pool, workspaceId, contactId, MONTH_B, 5);
    await seedEvents(pool, workspaceId, contactId, MONTH_WILD, 5);

    totalEventsBeforeRelocation = await countParentRows(pool, workspaceId, "events");

    const months = await discoverDefaultMonths(relocationPool, EVENTS_TABLE);
    expect(months.map(monthLabel)).toEqual(["2027-07", "2027-08", "2031-04"]);
  });

  let firstRunReport: RelocationReport;

  it("test 2: a month far outside any expected window is relocated like any other (D-09)", async () => {
    firstRunReport = await relocateAllDefaultRows(relocationPool, PARTITIONED_TABLES);

    const { rows } = await pool.query<{ relispartition: boolean }>(
      `SELECT relispartition FROM pg_class WHERE relname = 'events_2031_04'`,
    );
    expect(rows[0]?.relispartition, "events_2031_04 must exist and be attached").toBe(true);
    expect(await countRelation(pool, "events_2031_04")).toBe(5);

    // The report names every table passed in, even one with nothing to move
    // (send_events had no seeded DEFAULT rows at this point) -- a report
    // that silently omitted an all-zero table would be indistinguishable
    // from one that never checked it.
    expect(firstRunReport.tables.map((t) => t.table).sort()).toEqual(["events", "send_events"]);
    expect(tableReport(firstRunReport, "send_events").months).toEqual([]);
  });

  it("test 3: both DEFAULT partitions hold zero rows after the run", async () => {
    expect(await countDefaultRowsForTable(relocationPool, EVENTS_TABLE)).toBe(0);
    expect(await countDefaultRowsForTable(relocationPool, SEND_EVENTS_TABLE)).toBe(0);
  });

  it("test 4: row counts are conserved -- parent total unchanged, each destination matches what was seeded", async () => {
    const totalAfter = await countParentRows(pool, workspaceId, "events");
    expect(totalAfter).toBe(totalEventsBeforeRelocation);

    expect(await countRelation(pool, "events_2027_07")).toBe(5);
    expect(await countRelation(pool, "events_2027_08")).toBe(5);
    expect(await countRelation(pool, "events_2031_04")).toBe(5);
  });

  it("test 5: a month with more rows than RELOCATE_BATCH_SIZE is moved in more than one batch, and counts still conserve", async () => {
    const seededCount = RELOCATE_BATCH_SIZE + 1;
    await seedEvents(pool, workspaceId, contactId, MONTH_BATCH, seededCount);
    const totalBefore = await countParentRows(pool, workspaceId, "events");

    const report = await relocateAllDefaultRows(relocationPool, [EVENTS_TABLE]);
    const eventsReport = tableReport(report, "events");
    const monthReport = eventsReport.months.find((m) => m.month === "2027-09");

    expect(monthReport, "expected a report entry for 2027-09").toBeDefined();
    expect(monthReport!.batches).toBeGreaterThan(1);
    expect(monthReport!.rowsMoved).toBe(seededCount);
    expect(eventsReport.residualDefaultCount).toBe(0);

    expect(await countRelation(pool, "events_2027_09")).toBe(seededCount);
    expect(await countParentRows(pool, workspaceId, "events")).toBe(totalBefore);
  });

  it("test 6: zero events_%/send_events_% relations are left freestanding (not attached)", async () => {
    const { rows } = await pool.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND NOT c.relispartition
          AND (c.relname LIKE 'events_%' OR c.relname LIKE 'send_events_%')`,
    );
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it("test 7: no leftover exclusion CHECK constraint remains on either DEFAULT partition", async () => {
    const { rows } = await pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid IN ('events_default'::regclass, 'send_events_default'::regclass)
          AND contype = 'c'
          AND conname LIKE 'excl_%'`,
    );
    expect(rows.map((r) => r.conname)).toEqual([]);
  });

  it("test 8: a second run against an already-empty DEFAULT reports zero months/rows and throws nothing", async () => {
    const report = await relocateAllDefaultRows(relocationPool, PARTITIONED_TABLES);

    for (const t of report.tables) {
      expect(t.months, `${t.table} should report zero months on an idempotent re-run`).toEqual([]);
      expect(t.totalRowsMoved).toBe(0);
      expect(t.residualDefaultCount).toBe(0);
    }
  });

  it("test 9: a run seeded with rows in both DEFAULT partitions relocates both, and the report names both tables", async () => {
    await seedEvents(pool, workspaceId, contactId, MONTH_BOTH, 3);
    await seedSendEvents(pool, workspaceId, MONTH_BOTH, 4);

    const report = await relocateAllDefaultRows(relocationPool, PARTITIONED_TABLES);

    const eventsReport = tableReport(report, "events");
    const sendEventsReport = tableReport(report, "send_events");

    expect(eventsReport.months.map((m) => m.month)).toContain("2027-10");
    expect(sendEventsReport.months.map((m) => m.month)).toContain("2027-10");
    expect(eventsReport.residualDefaultCount).toBe(0);
    expect(sendEventsReport.residualDefaultCount).toBe(0);

    expect(await countRelation(pool, "events_2027_10")).toBe(3);
    expect(await countRelation(pool, "send_events_2027_10")).toBe(4);
  });

  it("test 10 (09-REVIEW WR-02): refuses to start while another invocation already holds the relocation advisory lock", async () => {
    // CREATE TABLE IF NOT EXISTS is not atomic against genuine concurrency
    // -- two sessions can both pass the existence check and both attempt
    // the CREATE, one raising a duplicate-relation error. Rather than race
    // two real concurrent invocations (flaky by construction), this
    // deterministically simulates "another invocation is already running"
    // by holding the exact same advisory lock relocateAllDefaultRows
    // itself takes, on a separate session, before calling it.
    const holder = await relocationPool.connect();
    try {
      const { rows } = await holder.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS locked",
        [RELOCATE_ADVISORY_LOCK_KEY],
      );
      expect(rows[0]?.locked, "test setup: the holder session must acquire the lock first").toBe(true);

      await expect(relocateAllDefaultRows(relocationPool, PARTITIONED_TABLES)).rejects.toThrow(
        /already in progress|advisory lock/i,
      );
    } finally {
      await holder.query("SELECT pg_advisory_unlock($1)", [RELOCATE_ADVISORY_LOCK_KEY]);
      holder.release();
    }

    // The lock is now free again -- a normal run must still succeed
    // afterward (this is not a permanent deadlock).
    const report = await relocateAllDefaultRows(relocationPool, PARTITIONED_TABLES);
    for (const t of report.tables) {
      expect(t.residualDefaultCount).toBe(0);
    }
  });
});
