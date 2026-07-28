import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";

import { assertTestDatabaseUrl } from "./guard.js";
import { applyMigrationFile, listMigrationFiles } from "./migration-runner.js";

/**
 * 08-06 (QG-04, D-13) — the ONE migration-applying test fixture.
 *
 * Consolidated from three near-identical copies that lived in
 * apps/api/src/test, apps/worker/src/test and packages/delivery-core/src/test.
 * Those three files are now thin shims that re-export from here and keep only
 * their own workspace-specific seed helpers.
 *
 * The one substantive change during consolidation: the copies each resolved
 * their DSN by falling back from the test connection string to the dev one
 * whenever the former was unset.
 * That fallback is precisely the defect SPEC R4 names — a test entrypoint that
 * bypasses globalSetup would silently connect to the developer's dev database.
 * It is gone, and this module now runs the guard itself (D-14 layer b): even a
 * caller that never went through globalSetup cannot reach the dev database.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// packages/test-support/src -> repo root is THREE levels up, not four: the
// three former copies each sat one level deeper (apps/*/src/test).
const MIGRATIONS_DIR = path.resolve(__dirname, "../../../packages/db/migrations");

let migratedPromise: Promise<void> | null = null;

/**
 * Arbitrary fixed key for the advisory lock below -- any int8 works, it just
 * needs to be the same constant across every process taking the lock.
 *
 * Exported so later plans reference the constant rather than re-typing the
 * number.
 */
export const MIGRATION_ADVISORY_LOCK_KEY = 8_472_991;

/**
 * Resolve the test DSN, lazily.
 *
 * Lazy is load-bearing: vitest `globalSetup` assigns TEST_DATABASE_URL AFTER
 * the config module has already been evaluated, so a module-level constant
 * would capture the value from before provisioning ran.
 *
 * There is deliberately no `??` fallback to DATABASE_URL anywhere in this file.
 */
export function getTestDatabaseUrl(): string {
  const testUrl = process.env.TEST_DATABASE_URL;

  // Compare against the TRUE dev DSN. When globalSetup ran it stashed the
  // original value in GSD_DEV_DATABASE_URL before overwriting DATABASE_URL with
  // the ephemeral DSN — comparing against DATABASE_URL there would compare the
  // test DSN to itself and throw on every run. When globalSetup did NOT run
  // (the bypass case this layer exists for), DATABASE_URL still holds the real
  // dev value and is the right comparand.
  //
  // Note this is the guard's comparison ARGUMENT, never a connection string:
  // nothing in this file falls back to the dev DSN to connect with.
  const devUrl = process.env.GSD_DEV_DATABASE_URL ?? process.env.DATABASE_URL;

  // Throws when unset/empty, when the name lacks the mega_crm_test prefix, or
  // when it resolves to the same physical database as the dev DSN.
  assertTestDatabaseUrl(testUrl, devUrl);
  return testUrl as string;
}

async function applyPendingMigrations(pool: Pool): Promise<void> {
  // 01-04 fix: each vitest test FILE runs in its own worker process (its own
  // module registry), so the `migratedPromise` cache below is only
  // per-process, not per-suite -- every test file's `beforeAll` calls this
  // independently. When two files' migration runs raced against a genuinely
  // pending migration (verified: 0002_invitation_created_at.sql, the first
  // migration added since this fixture started being exercised by more than
  // one file with real pending work), both workers observed "not yet
  // applied" before either recorded it, and both ran the same `ALTER TABLE
  // ADD COLUMN`, so the second one failed with "column already exists".
  // A session-scoped Postgres advisory lock serializes the whole
  // check-then-apply-then-record sequence across concurrent processes.
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS _test_migrations_applied (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    mkdirSync(MIGRATIONS_DIR, { recursive: true });
    // 08-09: listing and per-file application now come from migration-runner.ts,
    // so the fixture and the two migration tests share one mechanism. The
    // zero-padded-filename check that used to be a comment here is enforced
    // inside listMigrationFiles.
    const files = listMigrationFiles(MIGRATIONS_DIR);

    for (const file of files) {
      const { rows } = await client.query<{ exists: boolean }>(
        "SELECT true as exists FROM _test_migrations_applied WHERE filename = $1",
        [file],
      );
      if (rows.length > 0) continue;

      await applyMigrationFile(client, MIGRATIONS_DIR, file);
      await client.query("INSERT INTO _test_migrations_applied (filename) VALUES ($1)", [file]);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);
    client.release();
  }
}

/**
 * Applies every committed SQL migration (schema + RLS policies) to the test
 * database exactly once per test process, tracked in `_test_migrations_applied`.
 */
export function ensureTestDbMigrated(): Promise<void> {
  if (!migratedPromise) {
    const pool = new Pool({ connectionString: getTestDatabaseUrl() });
    migratedPromise = applyPendingMigrations(pool).finally(() => pool.end());
  }
  return migratedPromise;
}

/** A fresh pg Pool pointed at the test database. Caller owns its lifecycle (must `.end()`). */
export function createTestPool(): Pool {
  return new Pool({ connectionString: getTestDatabaseUrl(), max: 5 });
}

/** The absolute migrations directory this fixture applies from. Exported for path assertions. */
export function getMigrationsDir(): string {
  return MIGRATIONS_DIR;
}
