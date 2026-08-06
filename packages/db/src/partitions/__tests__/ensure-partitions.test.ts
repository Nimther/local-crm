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

import {
  BUFFER_ALERT_THRESHOLD_MONTHS,
  LOOKAHEAD_MONTHS,
  PARTITIONED_TABLES,
  attachPartitionCheckFirst,
  computeBufferMonths,
  ensurePartitions,
  monthPartitionName,
} from "../ensure-partitions.js";
import { readLatestMaintenanceRun, runPartitionMaintenance } from "../maintenance-run.js";

/**
 * 09-03 task 3 (DB-01/DB-04): month-boundary, contiguity and
 * calendar-precision coverage for the automation path, against a single
 * ephemeral database provisioned once in `beforeAll` (mirrors
 * migrate-from-empty.test.ts's own-database convention) -- this suite needs
 * to manufacture specific partition states, including missing months, which
 * it must not do to a database another suite shares.
 *
 * `now` is injected as a plain function argument in every call (tests 2-6):
 * `ensurePartitions` and `computeBufferMonths` already take `now` explicitly,
 * which is what makes this suite possible without a fake-timer library --
 * no fake-timer import appears anywhere in this file, and no boundary
 * assertion reads the real clock.
 *
 * Tests run in the numeric order below DELIBERATELY -- this is one shared
 * database, not nine isolated ones, and later tests build on state earlier
 * tests establish (test 1 extends the migrated chain by one month so test 4
 * has a single contiguous run to check; test 6's manufactured gap and test
 * 9's dropped current month must not exist yet when test 4/5 run).
 */

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const EVENTS_TABLE = PARTITIONED_TABLES.find((t) => t.parentTable === "events")!;
const SEND_EVENTS_TABLE = PARTITIONED_TABLES.find((t) => t.parentTable === "send_events")!;

interface ParsedBound {
  from: string;
  to: string;
}

function parseBound(expr: string): ParsedBound {
  const match = /FOR VALUES FROM \(([^)]+)\) TO \(([^)]+)\)/.exec(expr);
  if (!match) {
    throw new Error(`could not parse partition bound expression: ${expr}`);
  }
  return { from: match[1], to: match[2] };
}

/** `to_regclass` existence check -- mirrors ensure-partitions.ts's own private `partitionExists`. */
async function partitionExists(pool: Pool, name: string): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS exists`,
    [`public.${name}`],
  );
  return rows[0]?.exists ?? false;
}

/** The `[month(now) .. month(now) + lookaheadMonths]` partition names for `parentTable`, pure calendar arithmetic. */
function monthlyPartitionNamesInRange(parentTable: string, now: Date, lookaheadMonths: number): string[] {
  const names: string[] = [];
  for (let offset = 0; offset <= lookaheadMonths; offset++) {
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
    names.push(monthPartitionName(parentTable, monthStart));
  }
  return names;
}

/** Presence array for `computeBufferMonths`, read from the real catalog against a fixed partition set. */
async function buildMonthPresence(
  pool: Pool,
  parentTable: string,
  now: Date,
  lookaheadMonths: number,
): Promise<boolean[]> {
  const names = monthlyPartitionNamesInRange(parentTable, now, lookaheadMonths);
  const presence: boolean[] = [];
  for (const name of names) {
    presence.push(await partitionExists(pool, name));
  }
  return presence;
}

async function countMonthlyRelations(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*) AS count
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND (c.relname LIKE 'events_%' OR c.relname LIKE 'send_events_%')`,
  );
  return Number(rows[0]?.count ?? 0);
}

/** Every monthly (non-DEFAULT) child of `table.parentTable`, ordered by relation name, with its parsed bound. */
async function readMonthlyBoundsOrdered(
  pool: Pool,
  table: { parentTable: string; defaultPartition: string },
): Promise<Array<{ relname: string; bound: ParsedBound }>> {
  const { rows } = await pool.query<{ relname: string; bound: string }>(
    `SELECT c.relname, pg_get_expr(c.relpartbound, c.oid) AS bound
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_inherits i ON i.inhrelid = c.oid
       JOIN pg_class p ON p.oid = i.inhparent
      WHERE n.nspname = 'public'
        AND p.relname = $1
        AND c.relispartition
        AND c.relname <> $2
      ORDER BY c.relname`,
    [table.parentTable, table.defaultPartition],
  );
  return rows.map((r) => ({ relname: r.relname, bound: parseBound(r.bound) }));
}

describe("ensure-partitions (09-03 task 3, DB-01/DB-04)", () => {
  let pool: Pool;
  let partitionPool: Pool;
  let databaseName: string;
  let adminDsn: string;
  let workspaceId: string;
  let contactId: string;

  beforeAll(async () => {
    const created = await createEphemeralDatabase({ workspace: "ensure-partitions-boundary" });
    databaseName = created.databaseName;
    adminDsn = created.adminDsn;
    // Same UTC-forcing rationale as apps/api's partition-maintenance-tracer
    // and 09-04's suites: keeps every boundary/precision assertion below
    // independent of the local Postgres server's own default session
    // TimeZone.
    pool = new Pool({ connectionString: created.dsn, max: 5, options: "-c timezone=UTC" });

    // Dedicated pool for every ensurePartitions/attachPartitionCheckFirst/
    // runPartitionMaintenance call below -- NEVER shared with `pool`, which
    // this suite also uses for tenant-scoped seeding (SET LOCAL
    // app.current_workspace_id). 09-04's own deviation report documents why:
    // a connection recycled from a tenant-scoped transaction reverts
    // app.current_workspace_id to '' (not NULL), and contacts'/sends'
    // PRE-PHASE-10 bare-cast RLS policies throw on that the moment ATTACH
    // PARTITION triggers Postgres's automatic inherited-FK re-validation --
    // independent of the admin-scan policy migration 0039 adds. Matches
    // relocate-default.test.ts's and boundary-crossing-late-automation.test.ts's
    // own two-pool discipline exactly.
    partitionPool = new Pool({ connectionString: created.dsn, max: 5, options: "-c timezone=UTC" });

    const files = listMigrationFiles(MIGRATIONS_DIR);
    for (const file of files) {
      await applyMigrationFile(pool, MIGRATIONS_DIR, file);
    }

    workspaceId = randomUUID();
    await pool.query(`INSERT INTO organization (id, name, slug) VALUES ($1, $2, $3)`, [
      workspaceId,
      "Ensure Partitions Boundary Test Co",
      `ensure-partitions-boundary-${workspaceId.slice(0, 8)}`,
    ]);

    contactId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
      await client.query(`INSERT INTO contacts (id, workspace_id, external_id) VALUES ($1, $2, $3)`, [
        contactId,
        workspaceId,
        `ensure-partitions-boundary-contact-${contactId.slice(0, 8)}`,
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
    await partitionPool?.end();
    await pool?.end();
    if (databaseName) await dropEphemeralDatabase(databaseName, adminDsn);
  });

  it("test 1: ensurePartitions run twice in a row creates nothing on the second call (DB-01 idempotency)", async () => {
    // April 2027 is within the migrated chain (0007/0020 + 0038 cover
    // 2026-07..2027-06), so this call's lookahead window (Apr/May/Jun/Jul
    // 2027) is missing only the trailing month -- July 2027, one month past
    // migration 0038's ceiling. The first call extends the chain by exactly
    // that one contiguous month; the second call is a genuine no-op.
    const now = new Date(Date.UTC(2027, 3, 15, 12, 0, 0));

    const firstRun = await ensurePartitions(partitionPool, PARTITIONED_TABLES, now, LOOKAHEAD_MONTHS);
    const eventsFirst = firstRun.find((r) => r.table === "events");
    const sendEventsFirst = firstRun.find((r) => r.table === "send_events");
    expect(eventsFirst?.created).toEqual(["events_2027_07"]);
    expect(sendEventsFirst?.created).toEqual(["send_events_2027_07"]);

    const relationCountBefore = await countMonthlyRelations(pool);

    const secondRun = await ensurePartitions(partitionPool, PARTITIONED_TABLES, now, LOOKAHEAD_MONTHS);
    for (const r of secondRun) {
      expect(r.created, `${r.table} must report an empty created list on the second identical call`).toEqual([]);
    }

    const relationCountAfter = await countMonthlyRelations(pool);
    expect(relationCountAfter).toBe(relationCountBefore);
  });

  it("test 2: a month rollover (2026-08-31T23:59:59Z vs 2026-09-01T00:00:01Z) yields the same partition set apart from the trailing month", async () => {
    const before = new Date("2026-08-31T23:59:59.000Z");
    const after = new Date("2026-09-01T00:00:01.000Z");

    await ensurePartitions(partitionPool, PARTITIONED_TABLES, before, LOOKAHEAD_MONTHS);
    const eventsBefore = monthlyPartitionNamesInRange("events", before, LOOKAHEAD_MONTHS);
    const sendEventsBefore = monthlyPartitionNamesInRange("send_events", before, LOOKAHEAD_MONTHS);

    await ensurePartitions(partitionPool, PARTITIONED_TABLES, after, LOOKAHEAD_MONTHS);
    const eventsAfter = monthlyPartitionNamesInRange("events", after, LOOKAHEAD_MONTHS);
    const sendEventsAfter = monthlyPartitionNamesInRange("send_events", after, LOOKAHEAD_MONTHS);

    for (const name of [...eventsBefore, ...eventsAfter, ...sendEventsBefore, ...sendEventsAfter]) {
      expect(await partitionExists(pool, name), `expected ${name} to exist`).toBe(true);
    }

    expect(eventsBefore).toContain("events_2026_09");
    expect(sendEventsBefore).toContain("send_events_2026_09");
    expect(eventsAfter).toContain("events_2026_09");
    expect(sendEventsAfter).toContain("send_events_2026_09");

    // The window slides forward by exactly one month across the boundary:
    // the later `now`'s set drops the earliest month and gains one new
    // trailing month; every month in between is identical.
    expect(eventsAfter.slice(0, eventsAfter.length - 1)).toEqual(eventsBefore.slice(1));
    expect(eventsAfter[eventsAfter.length - 1]).not.toEqual(eventsBefore[0]);
    expect(sendEventsAfter.slice(0, sendEventsAfter.length - 1)).toEqual(sendEventsBefore.slice(1));
  });

  it("test 3: a row at the exact month boundary lands in the correct dated partition through tableoid::regclass, not its neighbor", async () => {
    const eventIdSep = randomUUID();
    const eventIdAug = randomUUID();

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
      await client.query(
        `INSERT INTO events (id, workspace_id, contact_id, name, properties, occurred_at)
         VALUES ($1, $2, $3, 'boundary_event_sep', '{}'::jsonb, '2026-09-01T00:00:00.000Z'::timestamptz)`,
        [eventIdSep, workspaceId, contactId],
      );
      await client.query(
        `INSERT INTO events (id, workspace_id, contact_id, name, properties, occurred_at)
         VALUES ($1, $2, $3, 'boundary_event_aug', '{}'::jsonb, '2026-08-31T23:59:59.999Z'::timestamptz)`,
        [eventIdAug, workspaceId, contactId],
      );
      const { rows } = await client.query<{ id: string; relation: string }>(
        `SELECT id::text, tableoid::regclass::text AS relation FROM events WHERE id = ANY($1)`,
        [[eventIdSep, eventIdAug]],
      );
      await client.query("COMMIT");

      const byId = new Map(rows.map((r) => [r.id, r.relation]));
      expect(byId.get(eventIdSep), "2026-09-01T00:00:00.000Z must land in events_2026_09").toBe("events_2026_09");
      expect(byId.get(eventIdAug), "2026-08-31T23:59:59.999Z must land in events_2026_08").toBe("events_2026_08");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  });

  it("test 4: adjacent monthly partitions abut exactly -- no gap, no overlap -- across the migration/function seam, for both tables", async () => {
    for (const table of PARTITIONED_TABLES) {
      const bounds = await readMonthlyBoundsOrdered(pool, table);
      expect(bounds.length, `${table.parentTable} should have more than one monthly partition`).toBeGreaterThan(1);

      for (let i = 1; i < bounds.length; i++) {
        expect(
          bounds[i].bound.from,
          `${bounds[i].relname}'s lower bound must abut ${bounds[i - 1].relname}'s upper bound`,
        ).toBe(bounds[i - 1].bound.to);
      }
    }
  });

  it("test 5: calendar-integer buffer arithmetic is identical at the first, mid, and last instant of a 28/30/31-day month", async () => {
    const instants: Date[] = [
      // January 2027 -- 31 days
      new Date(Date.UTC(2027, 0, 1, 0, 0, 0, 0)),
      new Date(Date.UTC(2027, 0, 16, 12, 0, 0, 0)),
      new Date(Date.UTC(2027, 0, 31, 23, 59, 59, 999)),
      // February 2027 -- 28 days (2027 is not a leap year)
      new Date(Date.UTC(2027, 1, 1, 0, 0, 0, 0)),
      new Date(Date.UTC(2027, 1, 14, 12, 0, 0, 0)),
      new Date(Date.UTC(2027, 1, 28, 23, 59, 59, 999)),
      // April 2027 -- 30 days
      new Date(Date.UTC(2027, 3, 1, 0, 0, 0, 0)),
      new Date(Date.UTC(2027, 3, 15, 12, 0, 0, 0)),
      new Date(Date.UTC(2027, 3, 30, 23, 59, 59, 999)),
    ];

    const buffers: number[] = [];
    for (const now of instants) {
      const presence = await buildMonthPresence(pool, "events", now, LOOKAHEAD_MONTHS);
      buffers.push(computeBufferMonths(presence));
    }

    const [first, ...rest] = buffers;
    expect(rest.every((b) => b === first), `expected all nine calls to return ${first}, got ${JSON.stringify(buffers)}`).toBe(true);
  });

  it("test 6: a gap stops the consecutive-months walk -- the buffer reflects the gap, not the raw count of surviving future partitions (Pitfall 2)", async () => {
    // Manufacture a non-contiguous set: drop March 2027 while February and
    // April both remain. A naive "how many future partitions exist" count
    // would see 4 (Jan/Feb/Apr/May/Jun all present bar March) and report a
    // healthy buffer; the correct walk stops at the first gap.
    await pool.query(`DROP TABLE events_2027_03`);

    const now = new Date(Date.UTC(2027, 0, 15, 12, 0, 0)); // January 2027
    const presence = await buildMonthPresence(pool, "events", now, 5); // Jan..Jun 2027
    expect(presence).toEqual([true, true, false, true, true, true]);

    const buffer = computeBufferMonths(presence);
    expect(buffer, "the walk must stop at the March gap, reporting a buffer of 1 (Jan + Feb - 1), not 4").toBe(1);
  });

  it("test 7: buffer_months_remaining is the minimum of the two per-table buffers, while each per-table column keeps its own value", async () => {
    // events: full LOOKAHEAD_MONTHS coverage (Jan..Apr 2028) -> buffer 3.
    for (let offset = 0; offset <= LOOKAHEAD_MONTHS; offset++) {
      const monthStart = new Date(Date.UTC(2028, offset, 1));
      const monthEnd = new Date(Date.UTC(2028, offset + 1, 1));
      await attachPartitionCheckFirst(partitionPool, EVENTS_TABLE, monthStart, monthEnd);
    }

    // send_events: only Jan/Feb 2028 -> buffer 1. runPartitionMaintenance's
    // own ensurePartitions call self-heals March/April as PART OF this same
    // run, but the RECORDED buffer reflects the state before that heal
    // (09-01's own pre-run-measurement decision) -- so the assertion below
    // still sees the pre-heal gap, not a "fixed itself so it's fine now" 3.
    for (let offset = 0; offset <= 1; offset++) {
      const monthStart = new Date(Date.UTC(2028, offset, 1));
      const monthEnd = new Date(Date.UTC(2028, offset + 1, 1));
      await attachPartitionCheckFirst(partitionPool, SEND_EVENTS_TABLE, monthStart, monthEnd);
    }

    const now = new Date(Date.UTC(2028, 0, 15, 12, 0, 0));
    const snapshot = await runPartitionMaintenance(partitionPool, now, {
      lookaheadMonths: LOOKAHEAD_MONTHS,
      bufferAlertThresholdMonths: BUFFER_ALERT_THRESHOLD_MONTHS,
    });

    expect(snapshot.eventsBufferMonths).toBe(3);
    expect(snapshot.sendEventsBufferMonths).toBe(1);
    expect(snapshot.bufferMonthsRemaining).toBe(1);
    expect(snapshot.bufferMonthsRemaining).not.toBe(snapshot.eventsBufferMonths);

    const recorded = await readLatestMaintenanceRun(pool);
    expect(recorded?.eventsBufferMonths).toBe(3);
    expect(recorded?.sendEventsBufferMonths).toBe(1);
    expect(recorded?.bufferMonthsRemaining).toBe(1);

    // The self-heal actually happened: send_events now has March/April too.
    expect(await partitionExists(pool, "send_events_2028_03")).toBe(true);
    expect(await partitionExists(pool, "send_events_2028_04")).toBe(true);
  });

  it("test 8: no events_%/send_events_% relation is left freestanding (relispartition = false) after every call above", async () => {
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

  it("test 9: a dropped current-month partition yields a buffer below the alert threshold, not a positive buffer derived from surviving future months", async () => {
    // A missing current-month partition means rows are landing in DEFAULT
    // right now -- the correct reported buffer is below the alert threshold,
    // never a positive number salvaged from the future months that still
    // exist. The walk starts at the current month (index 0) for exactly
    // this reason.
    await pool.query(`DROP TABLE events_2028_01`);

    const now = new Date(Date.UTC(2028, 0, 15, 12, 0, 0));
    const presence = await buildMonthPresence(pool, "events", now, LOOKAHEAD_MONTHS);
    expect(presence[0], "the current month (January 2028) must be absent").toBe(false);
    // February/March/April 2028 (test 7's own coverage plus its self-heal) are still present.
    expect(presence.slice(1).every(Boolean), "the surviving future months must still be present").toBe(true);

    const buffer = computeBufferMonths(presence);
    expect(buffer).toBeLessThan(BUFFER_ALERT_THRESHOLD_MONTHS);
  });
});
