import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createEphemeralDatabase, dropEphemeralDatabase } from "@mega-crm/test-support";

/**
 * 09-REVIEW WR-01: migration 0038's 20 `CREATE TABLE ... PARTITION OF`
 * statements are plain DDL, not the CHECK-constraint-first sequence
 * `attachPartitionCheckFirst` uses for every other attach in this codebase
 * (CONVENTIONS.md's "Partition maintenance" section names 0038 as the ONE
 * sanctioned exception -- duplicating that sequence here a second time is
 * exactly what that rule forbids). That makes this migration safe ONLY
 * while `events_default`/`send_events_default` are still empty, which is
 * only guaranteed before 2026-09-01 (the literal boundary this migration's
 * own partitions start at). After that boundary, an empty DEFAULT partition
 * is still safe to attach around, while a non-empty one must keep failing
 * closed. This suite proves both sides of that boundary.
 *
 * Postgres's `now()` cannot be faked from a test without a server-side
 * extension this repository does not depend on, so this suite executes the
 * REAL migration file's own guard clause directly (extracted verbatim, not
 * retyped) against real partition tables in an ephemeral Postgres. Replacing
 * only the cutoff literal with a definitely-past date keeps the test stable
 * after the real deadline and exercises the exact shipped state predicate.
 */

const MIGRATION_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations/0038_partition_catchup_and_maintenance_runs.sql",
);

const CUTOFF_LITERAL = "2026-09-01 00:00:00+00";

/** Extracts the `DO $$ ... END $$;` guard block that immediately precedes the first `CREATE TABLE`. */
function extractGuardBlock(migrationSql: string): string {
  const match = /DO \$\$[\s\S]*?END \$\$;/.exec(migrationSql);
  if (!match) {
    throw new Error(
      "migration 0038 no longer contains a `DO $$ ... END $$;` guard block -- " +
        "09-REVIEW WR-01's deadline guard is missing (or its shape changed enough that this " +
        "regex no longer finds it; update the regex deliberately if so).",
    );
  }
  return match[0];
}

describe("migration 0038 deadline guard (09-REVIEW WR-01)", () => {
  let pool: Pool;
  let databaseName: string;
  let adminDsn: string;
  let migrationSql: string;
  let guardBlock: string;

  beforeAll(async () => {
    migrationSql = readFileSync(MIGRATION_PATH, "utf8");
    guardBlock = extractGuardBlock(migrationSql);

    const created = await createEphemeralDatabase({ workspace: "migration-0038-guard" });
    databaseName = created.databaseName;
    adminDsn = created.adminDsn;
    pool = new Pool({ connectionString: created.dsn, max: 2 });

    await pool.query(`
      CREATE TABLE events (occurred_at timestamptz NOT NULL) PARTITION BY RANGE (occurred_at);
      CREATE TABLE events_default PARTITION OF events DEFAULT;
      CREATE TABLE send_events (occurred_at timestamptz NOT NULL) PARTITION BY RANGE (occurred_at);
      CREATE TABLE send_events_default PARTITION OF send_events DEFAULT;
    `);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE events_default, send_events_default");
  });

  afterAll(async () => {
    await pool?.end();
    if (databaseName) await dropEphemeralDatabase(databaseName, adminDsn);
  });

  it("test 1: the migration file names the exact 2026-09-01 cutoff in its guard clause", () => {
    expect(guardBlock).toContain(CUTOFF_LITERAL);
    expect(guardBlock).toMatch(/RAISE EXCEPTION/i);
  });

  it("test 2: post-cutoff application is allowed when both DEFAULT partitions are empty", async () => {
    const postCutoffGuard = guardBlock.replace(CUTOFF_LITERAL, "2000-01-01 00:00:00+00");
    expect(postCutoffGuard).not.toBe(guardBlock);

    await expect(pool.query(postCutoffGuard)).resolves.toBeDefined();
  });

  it("test 3: post-cutoff application fails closed when events_default holds a row", async () => {
    await pool.query("INSERT INTO events_default (occurred_at) VALUES ('2030-01-01T00:00:00Z')");
    const postCutoffGuard = guardBlock.replace(CUTOFF_LITERAL, "2000-01-01 00:00:00+00");

    await expect(pool.query(postCutoffGuard)).rejects.toThrow(/refuses to apply/i);
  });

  it("test 4: post-cutoff application fails closed when send_events_default holds a row", async () => {
    await pool.query("INSERT INTO send_events_default (occurred_at) VALUES ('2030-01-01T00:00:00Z')");
    const postCutoffGuard = guardBlock.replace(CUTOFF_LITERAL, "2000-01-01 00:00:00+00");

    await expect(pool.query(postCutoffGuard)).rejects.toThrow(/refuses to apply/i);
  });
});
