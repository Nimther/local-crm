import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
 * own partitions start at). This suite proves the migration refuses to
 * apply at all once that boundary has passed, converting a silent
 * twenty-partition ACCESS EXCLUSIVE lock storm into a loud, immediate
 * migration failure.
 *
 * Postgres's `now()` cannot be faked from a test without a server-side
 * extension this repository does not depend on, so this suite executes the
 * REAL migration file's own guard clause directly (extracted verbatim, not
 * retyped) against a real ephemeral Postgres -- proving two things about
 * the actual shipped SQL: (1) it is silent today (the real "now" is before
 * 2026-09-01), and (2) substituting only the cutoff literal for a
 * definitely-past date makes it raise, proving the guard's polarity is
 * correct.
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
  });

  afterAll(async () => {
    await pool?.end();
    if (databaseName) await dropEphemeralDatabase(databaseName, adminDsn);
  });

  it("test 1: the migration file names the exact 2026-09-01 cutoff in its guard clause", () => {
    expect(guardBlock).toContain(CUTOFF_LITERAL);
    expect(guardBlock).toMatch(/RAISE EXCEPTION/i);
  });

  it("test 2: the guard, as shipped, does not trip today (real \"now\" is before the cutoff)", async () => {
    await expect(pool.query(guardBlock)).resolves.toBeDefined();
  });

  it("test 3: the exact same guard, with only the cutoff literal moved into the past, raises", async () => {
    const pastCutoffGuard = guardBlock.replace(CUTOFF_LITERAL, "2000-01-01 00:00:00+00");
    // Sanity: the substitution must actually have found and replaced the
    // literal, or this test would vacuously pass by re-running the
    // never-trips original.
    expect(pastCutoffGuard).not.toBe(guardBlock);

    await expect(pool.query(pastCutoffGuard)).rejects.toThrow(/must not apply|refuses to apply/i);
  });
});
