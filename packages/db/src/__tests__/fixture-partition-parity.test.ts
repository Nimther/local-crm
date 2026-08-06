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
  LOOKAHEAD_MONTHS,
  PARTITIONED_TABLES,
  ensurePartitions,
  monthPartitionName,
} from "../partitions/ensure-partitions.js";

/**
 * 09-03 task 2 (D-05): proves that the SAME post-migration partition step
 * `packages/test-support/src/db-fixture.ts` now runs after the migration
 * loop -- `ensurePartitions(client, PARTITIONED_TABLES, new Date(),
 * LOOKAHEAD_MONTHS)` -- gives a freshly migrated ephemeral database the same
 * rolling partition horizon production has, not the frozen catch-up window
 * migration 0038 bakes in. Without this call, a test database built from the
 * migration chain alone silently routes any insert made outside that frozen
 * window into DEFAULT, defeating any test that asserts partition routing.
 *
 * This suite provisions its OWN database (mirrors
 * migrate-from-empty.test.ts) rather than the one globalSetup hands the
 * workspace, and drives the migration + partition step directly so the
 * assertions below observe exactly what the fixture will do -- names are
 * derived from `monthPartitionName` and the real clock, never hard-coded,
 * so this suite does not rot on the first of a month.
 */

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);

/** The `[currentMonth .. currentMonth + LOOKAHEAD_MONTHS]` partition names for `parentTable`, from the real clock. */
function expectedMonthlyPartitionNames(parentTable: string, now: Date): string[] {
  const names: string[] = [];
  for (let offset = 0; offset <= LOOKAHEAD_MONTHS; offset++) {
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
    names.push(monthPartitionName(parentTable, monthStart));
  }
  return names;
}

describe("fixture partition parity (09-03 task 2, D-05)", () => {
  let pool: Pool;
  let databaseName: string;
  let adminDsn: string;
  let workspaceId: string;
  let contactId: string;

  beforeAll(async () => {
    const created = await createEphemeralDatabase({ workspace: "fixture-partition-parity" });
    databaseName = created.databaseName;
    adminDsn = created.adminDsn;
    // Same UTC-forcing rationale as apps/api's partition-maintenance-tracer
    // test and 09-04's suites: keeps month-boundary arithmetic independent
    // of the local Postgres server's own default session TimeZone.
    pool = new Pool({ connectionString: created.dsn, max: 5, options: "-c timezone=UTC" });

    const files = listMigrationFiles(MIGRATIONS_DIR);
    for (const file of files) {
      await applyMigrationFile(pool, MIGRATIONS_DIR, file);
    }

    workspaceId = randomUUID();
    await pool.query(`INSERT INTO organization (id, name, slug) VALUES ($1, $2, $3)`, [
      workspaceId,
      "Fixture Parity Test Co",
      `fixture-parity-${workspaceId.slice(0, 8)}`,
    ]);

    contactId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
      await client.query(`INSERT INTO contacts (id, workspace_id, external_id) VALUES ($1, $2, $3)`, [
        contactId,
        workspaceId,
        `fixture-parity-contact-${contactId.slice(0, 8)}`,
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
    await pool?.end();
    if (databaseName) await dropEphemeralDatabase(databaseName, adminDsn);
  });

  it("test 1: the real current UTC month plus LOOKAHEAD_MONTHS partitions exist for both tables, after the fixture's own partition step", async () => {
    const now = new Date();
    await ensurePartitions(pool, PARTITIONED_TABLES, now, LOOKAHEAD_MONTHS);

    for (const table of PARTITIONED_TABLES) {
      const expected = expectedMonthlyPartitionNames(table.parentTable, now);
      for (const name of expected) {
        const { rows } = await pool.query<{ exists: boolean }>(
          `SELECT to_regclass($1) IS NOT NULL AS exists`,
          [`public.${name}`],
        );
        expect(rows[0]?.exists, `expected partition ${name} to exist`).toBe(true);
      }
    }
  });

  it("test 2: a row inserted now lands in the dated current-month partition through tableoid::regclass, not DEFAULT", async () => {
    const now = new Date();
    const eventId = randomUUID();

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
      await client.query(
        `INSERT INTO events (id, workspace_id, contact_id, name, properties, occurred_at)
         VALUES ($1, $2, $3, 'fixture_parity_event', '{}'::jsonb, $4::timestamptz)`,
        [eventId, workspaceId, contactId, now],
      );
      const { rows } = await client.query<{ relation: string }>(
        `SELECT tableoid::regclass::text AS relation FROM events WHERE id = $1`,
        [eventId],
      );
      await client.query("COMMIT");

      const expectedRelation = monthPartitionName("events", now);
      expect(rows[0]?.relation).toBe(expectedRelation);
      expect(rows[0]?.relation).not.toBe("events_default");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  });

  it("test 3: zero events_%/send_events_% relations are left unattached (relispartition = false) after the fixture's partition step", async () => {
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

  it("test 4: running the fixture's partition step twice is idempotent -- the second call reports an empty created list", async () => {
    const now = new Date();
    const results = await ensurePartitions(pool, PARTITIONED_TABLES, now, LOOKAHEAD_MONTHS);
    for (const result of results) {
      expect(
        result.created,
        `${result.table} should report an empty created list on the second run`,
      ).toEqual([]);
    }
  });
});
