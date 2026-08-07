import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";

import { assertTestDatabaseUrl } from "./guard.js";
import { applyMigrationFile, listMigrationFiles } from "./migration-runner.js";
import { AUTH_ROLE, buildRoleDsn, SCAN_ROLE } from "./provision-db.js";

// Deep specifier, not the package root (09-03 task 2, D-05): `packages/db/src/index.ts`
// constructs a Drizzle client at import time and throws when DATABASE_URL is
// unset, and this module is reachable from contexts that evaluate before
// global-setup.ts has published the ephemeral DSN. Reaching the partition
// module directly avoids that initialisation entirely -- the same precedent
// as apps/api/src/kms/local-provider.ts's `@mega-crm/kms/src/local-provider.js`.
import {
  ensurePartitions,
  LOOKAHEAD_MONTHS,
  PARTITIONED_TABLES,
} from "@mega-crm/db/src/partitions/ensure-partitions.js";

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

    // 09-03 (D-05): migrations create FROZEN partition months (migration
    // 0038's catch-up window), so a test database built from the chain alone
    // routes every insert made outside that frozen window into the DEFAULT
    // partition. Tests would still pass -- DEFAULT is a valid catch-all --
    // while silently no longer exercising partition routing at all. Calling
    // the production code path here means a fresh test database always
    // carries the same rolling horizon production has, and the
    // partition-creation code is exercised by every DB-touching suite in the
    // repository rather than only by its own unit test.
    //
    // Passed `pool`, not the locally-scoped `client`: `attachPartitionCheckFirst`
    // needs its own genuinely fresh, dedicated connection per month (via the
    // structural `PartitionClient.connect()`), which only a `Pool` -- not an
    // already-connected `PoolClient` -- can hand out. `pool.connect()` opens a
    // NEW physical connection, but the mutual exclusion this section still
    // needs across concurrent vitest worker processes holds regardless of
    // which connection performs the DDL: it comes from `client`'s own
    // session-scoped advisory lock, held from `pg_advisory_lock` above through
    // to the `finally` block's `pg_advisory_unlock` below -- a second process
    // calling `pg_advisory_lock` with the same key blocks until THIS session
    // releases it, which does not happen until after this call returns.
    //
    // No try/catch: a partition-creation failure during fixture setup must
    // fail the test run loudly. A fixture that silently proceeded without
    // partitions would reintroduce exactly the drift this call closes.
    await ensurePartitions(pool, PARTITIONED_TABLES, new Date(), LOOKAHEAD_MONTHS);
  } finally {
    // 08-REVIEW WR-01: release unconditionally. If the unlock query itself
    // throws (e.g. the connection was already dropped by the server), the
    // outer finally must still release the client back to the pool -- a
    // leaked checked-out client makes `pool.end()` (and therefore the
    // `beforeAll` awaiting `ensureTestDbMigrated()`) hang until hookTimeout,
    // rather than failing fast with the real error.
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);
    } finally {
      client.release();
    }
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

/**
 * Phase 10 (SEC-01/SEC-05, D-01/D-04) — the scan/auth-role equivalents of
 * `getTestDatabaseUrl()`.
 *
 * Both go THROUGH `getTestDatabaseUrl()` first, so the dev-DSN fail-closed
 * guard still applies before any role swap happens — only the username and
 * password change; the database (already validated) stays identical.
 */
function swapRole(testUrl: string, role: string): string {
  const url = new URL(testUrl);
  const databaseName = url.pathname.replace(/^\//, "");
  return buildRoleDsn(testUrl, databaseName, role, process.env.TEST_APP_DB_PASSWORD ?? "mega_crm_dev_pw");
}

/** The scan-role DSN for the SAME ephemeral database `getTestDatabaseUrl()` returns. */
export function getScanTestDatabaseUrl(): string {
  return swapRole(getTestDatabaseUrl(), SCAN_ROLE);
}

/** The auth-role DSN for the SAME ephemeral database `getTestDatabaseUrl()` returns. */
export function getAuthTestDatabaseUrl(): string {
  return swapRole(getTestDatabaseUrl(), AUTH_ROLE);
}

/** The absolute migrations directory this fixture applies from. Exported for path assertions. */
export function getMigrationsDir(): string {
  return MIGRATIONS_DIR;
}
