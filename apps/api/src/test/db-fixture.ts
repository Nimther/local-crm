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

async function applyPendingMigrations(pool: Pool): Promise<void> {
  await pool.query(`
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
    const { rows } = await pool.query<{ exists: boolean }>(
      "SELECT true as exists FROM _test_migrations_applied WHERE filename = $1",
      [file]
    );
    if (rows.length > 0) continue;

    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    await pool.query(sql);
    await pool.query("INSERT INTO _test_migrations_applied (filename) VALUES ($1)", [file]);
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
