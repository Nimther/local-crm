import { readFileSync, readdirSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// packages/db/migrations relative to this file's location
const MIGRATIONS_DIR = path.resolve(__dirname, "../../../../packages/db/migrations");

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (!TEST_DATABASE_URL) {
  throw new Error(
    "TEST_DATABASE_URL (or DATABASE_URL, via vitest.config.ts test.env) must be set. " +
      "It must point at a non-superuser Postgres role so Row-Level Security is genuinely " +
      "enforced during tests — see .env.example."
  );
}

let migratedPromise: Promise<void> | null = null;

// Arbitrary fixed key for the advisory lock below -- any int8 works, it just
// needs to be the same constant across every process taking the lock.
const MIGRATION_ADVISORY_LOCK_KEY = 8_472_991;

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
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const { rows } = await client.query<{ exists: boolean }>(
        "SELECT true as exists FROM _test_migrations_applied WHERE filename = $1",
        [file]
      );
      if (rows.length > 0) continue;

      const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      await client.query(sql);
      await client.query("INSERT INTO _test_migrations_applied (filename) VALUES ($1)", [file]);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);
    client.release();
  }
}

/** The test database's connection string (non-superuser role). */
export function getTestDatabaseUrl(): string {
  return TEST_DATABASE_URL as string;
}

/**
 * Applies every committed SQL migration (schema + RLS policies) to the test
 * database exactly once per test process, tracked in `_test_migrations_applied`.
 * Uses a plain, from-scratch SQL runner (not drizzle-kit's own migrate CLI) so
 * the test fixture has no dependency on drizzle-kit's journal files existing
 * yet — it just applies every `.sql` file under packages/db/migrations, in
 * filename order, exactly like drizzle-kit migrate does against the live DB.
 */
export function ensureTestDbMigrated(): Promise<void> {
  if (!migratedPromise) {
    const pool = new Pool({ connectionString: TEST_DATABASE_URL });
    migratedPromise = applyPendingMigrations(pool).finally(() => pool.end());
  }
  return migratedPromise;
}

/** A fresh pg Pool pointed at the test database. Caller owns its lifecycle (must `.end()`). */
export function createTestPool(): Pool {
  return new Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
}

/** Truncates every tenant-scoped domain table between test files, preserving migration history. */
export async function resetTestData(pool: Pool): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
      workspace_sendgrid_keys,
      invitation,
      member,
      organization,
      session,
      account,
      "user"
    RESTART IDENTITY CASCADE
  `);
}
