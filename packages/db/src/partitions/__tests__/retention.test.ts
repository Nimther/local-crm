import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

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
  PARTITION_RETENTION_ENABLE_FLAG,
  PARTITION_RETENTION_MONTHS,
  RETENTION_ELIGIBLE_TABLES,
  RETENTION_ENABLING_VALUE,
  RETENTION_EXCLUDED_TABLES,
  dropExpiredPartitions,
  findExpiredPartitions,
  isRetentionEnabled,
} from "../retention.js";

/**
 * Phase 14 plan 12 (DB-11), Task 1 -- the eligibility walk, the exclusions
 * and `isRetentionEnabled`, against a single ephemeral database provisioned
 * once in `beforeAll` (mirrors ensure-partitions.test.ts's own shared-database
 * convention). Tests run in the documented numeric order DELIBERATELY: this
 * is one shared database, and the drop test (which actually removes a
 * partition) must run only after every read-only eligibility assertion.
 */

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../migrations");

const EVENTS_TABLE = PARTITIONED_TABLES.find((t) => t.parentTable === "events")!;
const SEND_EVENTS_TABLE = PARTITIONED_TABLES.find((t) => t.parentTable === "send_events")!;

/**
 * Attaches a partition with an EXPLICIT name and EXPLICIT bounds (unlike
 * `attachPartitionCheckFirst`, which always derives both from a `Date` via
 * `monthPartitionName`/`monthRangeUtc`) -- needed here to manufacture
 * non-month-aligned probe ranges and deliberately mismatched names, which is
 * exactly what the straddling-boundary and catalog-not-name tests need.
 * Mirrors `attachPartitionCheckFirst`'s own five-statement sequence
 * (including the `app.current_workspace_id` sentinel, required because
 * ATTACH triggers Postgres's own FK re-validation against `contacts`/`sends`
 * regardless of whether the child is empty) exactly, just parameterized
 * differently.
 */
async function attachRawPartition(
  pool: Pool,
  table: PartitionedTableConfig,
  childName: string,
  startLiteral: string,
  endLiteral: string,
): Promise<void> {
  const conn = await pool.connect();
  const constraintName = `excl_${childName}`;
  try {
    await conn.query("BEGIN");
    await conn.query("SELECT set_config('app.current_workspace_id', $1, true)", [
      "00000000-0000-0000-0000-000000000000",
    ]);
    await conn.query(`CREATE TABLE IF NOT EXISTS ${childName} (LIKE ${table.parentTable} INCLUDING ALL)`);
    await conn.query(
      `ALTER TABLE ${table.defaultPartition} ADD CONSTRAINT ${constraintName}
         CHECK (${table.partitionKeyColumn} < '${startLiteral}' OR ${table.partitionKeyColumn} >= '${endLiteral}')
         NOT VALID`,
    );
    await conn.query(`ALTER TABLE ${table.defaultPartition} VALIDATE CONSTRAINT ${constraintName}`);
    await conn.query(
      `ALTER TABLE ${table.parentTable} ATTACH PARTITION ${childName}
         FOR VALUES FROM ('${startLiteral}') TO ('${endLiteral}')`,
    );
    await conn.query(`ALTER TABLE ${table.defaultPartition} DROP CONSTRAINT ${constraintName}`);
    await conn.query("COMMIT");
  } catch (err) {
    await conn.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    conn.release();
  }
}

async function partitionExists(pool: Pool, name: string): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS exists`, [
    `public.${name}`,
  ]);
  return rows[0]?.exists ?? false;
}

describe("retention (14-12, DB-11)", () => {
  let pool: Pool;
  let partitionPool: Pool;
  let databaseName: string;
  let adminDsn: string;

  beforeAll(async () => {
    const created = await createEphemeralDatabase({ workspace: "partition-retention" });
    databaseName = created.databaseName;
    adminDsn = created.adminDsn;
    pool = new Pool({ connectionString: created.dsn, max: 5, options: "-c timezone=UTC" });
    partitionPool = new Pool({ connectionString: created.dsn, max: 5, options: "-c timezone=UTC" });

    const files = listMigrationFiles(MIGRATIONS_DIR);
    for (const file of files) {
      await applyMigrationFile(pool, MIGRATIONS_DIR, file);
    }

    // events probes -- one contiguous, non-overlapping run entirely BEFORE
    // the real migrated partition timeline (which starts 2026-07-01), so
    // none of these can ever collide with a real month partition. Boundary
    // used against these three (see the "straddling" test below) is
    // 2020-03-01 (now=2021-03-01, retentionMonths=12).
    await attachRawPartition(
      partitionPool,
      EVENTS_TABLE,
      "events_retention_probe_1",
      "2020-01-01 00:00:00+00",
      "2020-02-01 00:00:00+00",
    ); // entirely before the boundary -- eligible
    await attachRawPartition(
      partitionPool,
      EVENTS_TABLE,
      "events_retention_probe_2_straddle",
      "2020-02-01 00:00:00+00",
      "2020-03-02 00:00:00+00",
    ); // starts before the boundary, ends ONE DAY after it -- must never be returned
    await attachRawPartition(
      partitionPool,
      EVENTS_TABLE,
      "events_retention_probe_3",
      "2020-03-02 00:00:00+00",
      "2020-04-01 00:00:00+00",
    ); // entirely after the boundary -- not eligible

    // events probe with a deliberately UNEXPECTED name but an eligible
    // range -- proves the walk is catalog-driven, not name-derived.
    await attachRawPartition(
      partitionPool,
      EVENTS_TABLE,
      "events_totally_unexpected_child_name",
      "2019-01-01 00:00:00+00",
      "2019-02-01 00:00:00+00",
    );

    // events probe with an ELIGIBLE-LOOKING name (mimics
    // monthPartitionName's own `<table>_<year>_<month>` convention for a
    // year that would otherwise be long-expired) but a RECENT, ineligible
    // range -- proves a name-parsing implementation would get this wrong
    // and this one does not.
    await attachRawPartition(
      partitionPool,
      EVENTS_TABLE,
      "events_2020_06",
      "2027-07-01 00:00:00+00",
      "2027-08-01 00:00:00+00",
    );

    // send_events probe -- isolated from the events probes above, its own
    // boundary (now=2019-06-01, retentionMonths=... see the exact-boundary
    // test), testing the exact-equality edge of the "<=" comparison.
    await attachRawPartition(
      partitionPool,
      SEND_EVENTS_TABLE,
      "send_events_retention_probe_exact",
      "2019-01-01 00:00:00+00",
      "2019-06-01 00:00:00+00",
    );
  }, 60_000);

  afterAll(async () => {
    await partitionPool?.end();
    await pool?.end();
    if (databaseName) await dropEphemeralDatabase(databaseName, adminDsn);
  });

  it("test 1: only whole partitions strictly older than the horizon are returned (real migrated timeline)", async () => {
    // Real migrated partitions span 2026-07 through 2027-06 (migrations
    // 0007/0020/0038). now=2027-08-15, retentionMonths=12 -> boundary =
    // 2026-08-01. Only events_2026_07/send_events_2026_07 (end 2026-08-01)
    // qualify; every later real month does not.
    const now = new Date(Date.UTC(2027, 7, 15));
    const expired = await findExpiredPartitions(partitionPool, [EVENTS_TABLE, SEND_EVENTS_TABLE], now, 12);
    const names = expired.map((e) => e.partitionName);

    expect(names).toContain("events_2026_07");
    expect(names).toContain("send_events_2026_07");
    expect(names).not.toContain("events_2026_08");
    expect(names).not.toContain("send_events_2026_08");
    for (let m = 9; m <= 12; m++) {
      expect(names).not.toContain(`events_2026_${String(m).padStart(2, "0")}`);
    }
    for (let m = 1; m <= 6; m++) {
      expect(names).not.toContain(`events_2027_${String(m).padStart(2, "0")}`);
    }
  });

  it("test 2: a partition straddling the horizon boundary by one day is never returned, even though its start is old", async () => {
    const now = new Date(Date.UTC(2021, 2, 1)); // 2021-03-01
    const expired = await findExpiredPartitions(partitionPool, [EVENTS_TABLE], now, 12);
    const names = expired.map((e) => e.partitionName);

    expect(names).toContain("events_retention_probe_1");
    expect(names).not.toContain("events_retention_probe_2_straddle");
    expect(names).not.toContain("events_retention_probe_3");
  });

  it("test 3: a partition ending EXACTLY at the horizon boundary is eligible (inclusive <=, exclusive TO bound)", async () => {
    // now=2019-06-01, retentionMonths=0 -> boundary = 2019-06-01, exactly
    // send_events_retention_probe_exact's own end.
    const now = new Date(Date.UTC(2019, 5, 1));
    const expired = await findExpiredPartitions(partitionPool, [SEND_EVENTS_TABLE], now, 0);
    const names = expired.map((e) => e.partitionName);

    expect(names).toContain("send_events_retention_probe_exact");
  });

  it("test 4: the DEFAULT partition is never returned, even under a horizon aggressive enough to catch everything else", async () => {
    const now = new Date(Date.UTC(2030, 0, 1));
    const expired = await findExpiredPartitions(partitionPool, [EVENTS_TABLE, SEND_EVENTS_TABLE], now, 0);
    const names = expired.map((e) => e.partitionName);

    expect(names).not.toContain(EVENTS_TABLE.defaultPartition);
    expect(names).not.toContain(SEND_EVENTS_TABLE.defaultPartition);
  });

  it("test 5: enumeration is catalog-driven, not name-derived -- an unexpected name with an eligible range is found, an eligible-looking name with an ineligible range is not", async () => {
    const now = new Date(Date.UTC(2019, 6, 1)); // 2019-07-01, retentionMonths=0 -> boundary 2019-07-01
    const expired = await findExpiredPartitions(partitionPool, [EVENTS_TABLE], now, 0);
    const names = expired.map((e) => e.partitionName);

    // Unexpected name (does not match `<table>_<year>_<month>` at all),
    // eligible range (ends 2019-02-01, well before the 2019-07-01 boundary).
    expect(names).toContain("events_totally_unexpected_child_name");

    // Eligible-LOOKING name ("events_2020_06" reads like a long-expired
    // month), but its REAL range (2027-07 to 2027-08) is nowhere near
    // eligible under this boundary -- a name-parsing implementation would
    // wrongly return this; the catalog-driven walk does not.
    expect(names).not.toContain("events_2020_06");
  });

  it("test 6: no table outside RETENTION_ELIGIBLE_TABLES is ever returned -- an excluded table refuses rather than silently enumerating", async () => {
    const now = new Date(Date.UTC(2030, 0, 1));
    for (const excludedName of RETENTION_EXCLUDED_TABLES) {
      const bogusTable: PartitionedTableConfig = {
        parentTable: excludedName,
        defaultPartition: `${excludedName}_default`,
        partitionKeyColumn: "occurred_at",
      };
      await expect(findExpiredPartitions(partitionPool, [bogusTable], now, 0)).rejects.toThrow(
        new RegExp(`refusing to enumerate "${excludedName}"`),
      );
    }
  });

  it("test 7: RETENTION_ELIGIBLE_TABLES contains exactly the two partitioned event tables and is disjoint from RETENTION_EXCLUDED_TABLES", () => {
    const eligibleNames = RETENTION_ELIGIBLE_TABLES.map((t) => t.parentTable);
    expect(new Set(eligibleNames)).toEqual(new Set(["events", "send_events"]));
    for (const name of eligibleNames) {
      expect(RETENTION_EXCLUDED_TABLES).not.toContain(name);
    }
  });

  it("test 8: dropExpiredPartitions is a no-op returning [] when nothing is eligible", async () => {
    const now = new Date(Date.UTC(1999, 0, 1)); // long before every real/probe partition -- nothing qualifies
    const drops = await dropExpiredPartitions(partitionPool, [EVENTS_TABLE, SEND_EVENTS_TABLE], now, 0);
    expect(drops).toEqual([]);
  });

  it("test 9: dropExpiredPartitions drops exactly what the finder returned and records name/range/horizon; the straddling partition survives", async () => {
    const now = new Date(Date.UTC(2021, 2, 1)); // same boundary as test 2 (2020-03-01)
    expect(await partitionExists(pool, "events_retention_probe_1")).toBe(true);
    expect(await partitionExists(pool, "events_retention_probe_2_straddle")).toBe(true);

    const drops = await dropExpiredPartitions(partitionPool, [EVENTS_TABLE], now, 12);
    const probe1Drop = drops.find((d) => d.partitionName === "events_retention_probe_1");

    expect(probe1Drop).toBeDefined();
    expect(probe1Drop?.parentTable).toBe("events");
    expect(probe1Drop?.rangeStart.toISOString()).toBe("2020-01-01T00:00:00.000Z");
    expect(probe1Drop?.rangeEnd.toISOString()).toBe("2020-02-01T00:00:00.000Z");
    expect(probe1Drop?.horizonMonths).toBe(12);
    expect(drops.find((d) => d.partitionName === "events_retention_probe_2_straddle")).toBeUndefined();

    // The dropped partition is genuinely gone; the straddling one survives untouched.
    expect(await partitionExists(pool, "events_retention_probe_1")).toBe(false);
    expect(await partitionExists(pool, "events_retention_probe_2_straddle")).toBe(true);
  });

  it("test 10: dropExpiredPartitions issues no row-level DELETE anywhere in the module (the drop IS the deletion mechanism)", () => {
    const source = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../retention.ts"), "utf8");
    const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(/delete\s+from/i.test(withoutComments)).toBe(false);
  });
});

describe("isRetentionEnabled (14-12, DB-11)", () => {
  it("is false when the flag is unset", () => {
    expect(isRetentionEnabled({})).toBe(false);
  });

  it("is false for any value other than the exact enabling value", () => {
    expect(isRetentionEnabled({ [PARTITION_RETENTION_ENABLE_FLAG]: "1" })).toBe(false);
    expect(isRetentionEnabled({ [PARTITION_RETENTION_ENABLE_FLAG]: "TRUE" })).toBe(false);
    expect(isRetentionEnabled({ [PARTITION_RETENTION_ENABLE_FLAG]: "yes" })).toBe(false);
    expect(isRetentionEnabled({ [PARTITION_RETENTION_ENABLE_FLAG]: "" })).toBe(false);
  });

  it("is true only for the exact enabling value", () => {
    expect(isRetentionEnabled({ [PARTITION_RETENTION_ENABLE_FLAG]: RETENTION_ENABLING_VALUE })).toBe(true);
  });

  it("PARTITION_RETENTION_MONTHS is the versioned 12-month horizon constant D-08 names", () => {
    expect(PARTITION_RETENTION_MONTHS).toBe(12);
  });
});
