import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { assertTestDatabaseUrl, createEphemeralDatabase, dropEphemeralDatabase } from "@mega-crm/test-support";

import { readShippedMigrations } from "../migration-journal.js";
import { newestAutoReversibleTier, tierFor } from "../migration-tiers.js";

/**
 * Phase 14 plan 05 (DB-07), Task 3 -- the rollback/roll-forward rehearsal.
 *
 * There are no down migrations in this repository (D-15) and this file does
 * not invent any. Instead: apply the full history to an ephemeral database
 * (never a developer's or production database -- guarded below, before any
 * DDL), fingerprint the schema, revert the trailing auto-reversible tier by
 * its own hand-derived inverse DDL (MIGRATION_INVERSES, next to this
 * comment), roll forward again using the SAME applier production uses
 * (`scripts/migrate-runner.mjs`, spawned as a real child process -- not
 * imported, per plan 14-01's own precedent in migrate-runner-advisory-
 * lock.test.ts, since a `.ts` test importing a plain `.mjs` script fails
 * `tsc` with no declaration file), and assert the fingerprint is identical.
 *
 * MIGRATION_INVERSES is a per-tag registry, not a generic SQL-DDL inverter.
 * A generic inverter (parse arbitrary DDL, derive its opposite) is a much
 * larger and riskier undertaking than this plan's scope justifies; the
 * concrete, mechanically-checkable property this rehearsal actually needs is
 * narrower: EVERY tag that is ever in the trailing auto-reversible run must
 * have a HAND-VERIFIED inverse recorded here, or the rehearsal throws rather
 * than guessing. `inverseFor` throwing for an unregistered tag is not a gap
 * to silently patch -- per this plan's own instruction, it is evidence the
 * tag's tier is wrong, and the fix belongs in migration-tiers.ts, not here.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const MIGRATE_RUNNER_PATH = path.join(REPO_ROOT, "scripts/migrate-runner.mjs");

interface InverseStep {
  description: string;
  sql: string;
}

/**
 * One entry per tag that has EVER appeared in `newestAutoReversibleTier()`'s
 * trailing run. Derived by reading each migration's own SQL (not guessed):
 *
 * - 0062_member_unique_org_user: adds ONLY a unique index promoted to a
 *   named constraint (`member_organization_user_unique`), both sharing one
 *   name (the migration's own header explains why). Dropping the constraint
 *   drops its backing index automatically in Postgres -- one statement
 *   fully reverses everything this migration added, and destroys no data
 *   (the underlying `member` rows are untouched; only the uniqueness
 *   enforcement is removed).
 * - 0063_partition_retention_drops (Phase 14 plan 12, DB-11): adds three
 *   columns to `partition_maintenance_runs` (all with defaults, so dropping
 *   them destroys only the retention-run bookkeeping this same migration
 *   introduced, never pre-existing data) and creates a brand-new table,
 *   `partition_retention_drops`, with its own index. Reverting means
 *   dropping exactly those four objects -- nothing this migration's inverse
 *   touches existed before this migration ran.
 */
const MIGRATION_INVERSES: Record<string, InverseStep[]> = {
  "0062_member_unique_org_user": [
    {
      description:
        "drop member_organization_user_unique (the constraint AND its backing index -- Postgres drops both together)",
      sql: `ALTER TABLE member DROP CONSTRAINT member_organization_user_unique;`,
    },
  ],
  "0063_partition_retention_drops": [
    {
      description: "drop partition_retention_drops (its own index drops automatically with the table)",
      sql: `DROP TABLE partition_retention_drops;`,
    },
    {
      description:
        "drop the three retention columns this migration added to partition_maintenance_runs (retention_status, retention_error, partitions_dropped)",
      sql: `ALTER TABLE partition_maintenance_runs
              DROP COLUMN retention_status,
              DROP COLUMN retention_error,
              DROP COLUMN partitions_dropped;`,
    },
  ],
};

function inverseFor(tag: string): InverseStep[] {
  const steps = MIGRATION_INVERSES[tag];
  if (steps === undefined) {
    throw new Error(
      `migration-rollback-rehearsal: no mechanically-derivable inverse is registered for "${tag}" in ` +
        `MIGRATION_INVERSES (packages/db/src/__tests__/migration-rollback-rehearsal.test.ts). ` +
        `newestAutoReversibleTier() classified it auto-reversible, but nobody has hand-verified an inverse ` +
        `for it yet -- per this plan's own instruction, treat this as evidence the tier classification in ` +
        `migration-tiers.ts is wrong, not as a gap to silently work around here.`,
    );
  }
  return steps;
}

interface SchemaFingerprint {
  columns: { table: string; column: string; dataType: string; nullable: boolean }[];
  constraints: { name: string; table: string; definition: string }[];
  indexes: { name: string; table: string; definition: string }[];
  enums: { type: string; label: string }[];
}

/**
 * Deterministically ordered so a diff between two fingerprints is stable and
 * readable -- covers tables/columns (with type and nullability), constraints,
 * indexes and enum values, per this plan's own required coverage. Reads only
 * `information_schema`/`pg_catalog` system tables, which are PUBLIC-readable
 * regardless of RLS (same reasoning as `scripts/audit-missing-constraints.ts`).
 */
async function fingerprintSchema(pool: Pool): Promise<SchemaFingerprint> {
  const columnsRes = await pool.query<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
  }>(
    `SELECT table_name, column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, column_name`,
  );
  const constraintsRes = await pool.query<{ conname: string; table_name: string; definition: string }>(
    `SELECT con.conname AS conname,
            con.conrelid::regclass::text AS table_name,
            pg_get_constraintdef(con.oid) AS definition
       FROM pg_constraint con
       JOIN pg_namespace n ON n.oid = con.connamespace
      WHERE n.nspname = 'public'
      ORDER BY con.conname, table_name`,
  );
  const indexesRes = await pool.query<{ indexname: string; tablename: string; indexdef: string }>(
    `SELECT indexname, tablename, indexdef
       FROM pg_indexes
      WHERE schemaname = 'public'
      ORDER BY indexname`,
  );
  const enumsRes = await pool.query<{ typname: string; enumlabel: string }>(
    `SELECT t.typname AS typname, e.enumlabel AS enumlabel
       FROM pg_enum e
       JOIN pg_type t ON t.oid = e.enumtypid
       JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public'
      ORDER BY t.typname, e.enumsortorder`,
  );

  return {
    columns: columnsRes.rows.map((r) => ({
      table: r.table_name,
      column: r.column_name,
      dataType: r.data_type,
      nullable: r.is_nullable === "YES",
    })),
    constraints: constraintsRes.rows.map((r) => ({ name: r.conname, table: r.table_name, definition: r.definition })),
    indexes: indexesRes.rows.map((r) => ({ name: r.indexname, table: r.tablename, definition: r.indexdef })),
    enums: enumsRes.rows.map((r) => ({ type: r.typname, label: r.enumlabel })),
  };
}

/** Names exactly which object differs, rather than relying on a raw object diff. */
function describeFingerprintDiff(before: SchemaFingerprint, after: SchemaFingerprint): string[] {
  const diffs: string[] = [];
  const sections: (keyof SchemaFingerprint)[] = ["columns", "constraints", "indexes", "enums"];
  for (const section of sections) {
    const beforeSet = new Set(before[section].map((item) => JSON.stringify(item)));
    const afterSet = new Set(after[section].map((item) => JSON.stringify(item)));
    for (const item of beforeSet) {
      if (!afterSet.has(item)) diffs.push(`MISSING after roll-forward (${section}): ${item}`);
    }
    for (const item of afterSet) {
      if (!beforeSet.has(item)) diffs.push(`EXTRA after roll-forward (${section}): ${item}`);
    }
  }
  return diffs;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Spawns the REAL production migrate step as a child process -- see this file's header for why not an import. */
function spawnMigrateRunner(databaseUrl: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MIGRATE_RUNNER_PATH], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function deleteJournalRowsFor(pool: Pool, tags: string[]): Promise<void> {
  const shipped = readShippedMigrations();
  const whens = tags.map((tag) => {
    const entry = shipped.find((e) => e.tag === tag);
    if (entry === undefined) {
      throw new Error(`migration-rollback-rehearsal: tag "${tag}" is not in the shipped journal`);
    }
    return entry.when;
  });
  await pool.query(`DELETE FROM "drizzle"."__drizzle_migrations" WHERE created_at = ANY($1::bigint[])`, [whens]);
}

const TRAILING_RUN = newestAutoReversibleTier();

describe("migration rollback/roll-forward rehearsal (DB-07)", () => {
  if (TRAILING_RUN.length === 0) {
    // D-15: skip with an explicit, named reason -- never a silent pass over
    // zero work. If the newest shipped migration is forward-only, there is
    // nothing in the trailing auto-reversible tier to rehearse; the
    // forward-only tier's recovery path is restore-based (see the runbook),
    // not something this DDL-only rehearsal can exercise.
    it.skip(
      "SKIPPED: newestAutoReversibleTier() is empty -- the newest shipped migration is forward-only, nothing to rehearse. See docs/runbooks/migration-rollback-and-roll-forward.md for the forward-only recovery path.",
      () => {
        /* intentionally empty -- the reason lives in this test's own name */
      },
    );
    return;
  }

  it(
    "applies the full history, reverts the trailing auto-reversible run, rolls forward via the production runner, and asserts identical schema fingerprints",
    async () => {
      for (const tag of TRAILING_RUN) {
        expect(tierFor(tag), `${tag} must be classified auto-reversible to be in the trailing run`).toBe(
          "auto-reversible",
        );
      }

      const created = await createEphemeralDatabase({ workspace: "migration-rehearsal" });
      const pool = new Pool({ connectionString: created.dsn, max: 2 });
      try {
        // GUARD FIRST, before a single DDL statement (T-14-22): the DSN must
        // be one this rehearsal's own provisioner created. Reuses Phase 8's
        // fail-closed convention (packages/test-support/src/guard.ts) rather
        // than inventing a second check.
        assertTestDatabaseUrl(created.dsn, process.env.GSD_DEV_DATABASE_URL ?? process.env.DATABASE_URL);

        // --- apply the full shipped history, via the real production runner ---
        const initialApply = await spawnMigrateRunner(created.dsn);
        expect(initialApply.code, `initial full-chain apply failed:\n${initialApply.stderr}`).toBe(0);

        const before = await fingerprintSchema(pool);

        // --- revert the trailing run, newest first ---
        for (const tag of [...TRAILING_RUN].reverse()) {
          for (const step of inverseFor(tag)) {
            await pool.query(step.sql);
          }
        }
        await deleteJournalRowsFor(pool, TRAILING_RUN);

        // --- roll forward again, via the SAME production runner ---
        const rollForward = await spawnMigrateRunner(created.dsn);
        expect(rollForward.code, `roll-forward failed:\n${rollForward.stderr}`).toBe(0);

        const after = await fingerprintSchema(pool);

        const diffs = describeFingerprintDiff(before, after);
        expect(diffs, diffs.length > 0 ? `schema fingerprint mismatch after revert + roll-forward:\n${diffs.join("\n")}` : undefined).toEqual(
          [],
        );
      } finally {
        await pool.end();
        await dropEphemeralDatabase(created.databaseName, created.adminDsn);
      }
    },
  );
});
