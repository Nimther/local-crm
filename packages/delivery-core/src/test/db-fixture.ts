import { readFileSync, readdirSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// packages/db/migrations relative to this file's location -- same depth as
// apps/worker/src/test/db-fixture.ts / apps/api/src/test/db-fixture.ts
// (packages/delivery-core/src/test -> repo root is also 4 levels up).
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

// Same fixed advisory-lock key convention as apps/api/src/test/db-fixture.ts
// and apps/worker/src/test/db-fixture.ts -- all three suites migrate the SAME
// physical test database, so they must serialize on the same lock to avoid a
// concurrent "column already exists" race if more than one is ever run at once.
const MIGRATION_ADVISORY_LOCK_KEY = 8_472_991;

async function applyPendingMigrations(pool: Pool): Promise<void> {
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
 * Mirrors apps/worker/src/test/db-fixture.ts and apps/api/src/test/db-fixture.ts
 * exactly (duplicated rather than shared: this is test scaffolding, not the
 * tenant-scoping/upsert logic that 02-06 extracted to shared packages to avoid
 * drift).
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
