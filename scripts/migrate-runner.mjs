#!/usr/bin/env node
// Phase 14 plan 01 (D-05/D-12, DB-05): the one-shot migrate step -- registered
// as `npm run migrate:prod`, run by the deploy container (later plans wire it
// into compose/deploy.sh).
//
// Routes around the drizzle-kit CLI's documented hang under Node v26 in this
// repo's own sandbox (see scripts/migrate-dev.mjs's own header) by applying
// migrations PROGRAMMATICALLY via drizzle-orm's own `migrate()` -- verified
// (packages/db/src/migration-journal.ts's header comment, read directly from
// the installed drizzle-orm@0.45.2 source) to write to the exact SAME
// "drizzle"."__drizzle_migrations" journal the CLI writes to, so dev (CLI)
// and prod (this runner) can never disagree about what "applied" means.
//
// DB-05 (RESEARCH.md Pitfall A): the advisory lock is taken AND released on
// ONE DEDICATED pg.Client, never a Pool -- a session-scoped lock acquired on
// one pooled connection and "released" from a different one silently no-ops
// and holds the lock for the pool's entire lifetime. This is the mechanistic
// reason this script never imports Pool/createPgPool, and never will.
//
// Never a blocking pg_advisory_lock, and never falls through to migrating
// after a failed lock acquisition -- a stuck migration under a blocking lock
// would hang the whole deploy silently rather than failing loudly.
//
// No dependencies beyond `pg` + `drizzle-orm` (both already pinned) and this
// repo's own env-path convention.

import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { resolveEnvPath } from "./env-path.mjs";
import { DRIZZLE_MIGRATIONS_FOLDER } from "@mega-crm/db/src/migration-journal.js";

// 08-15: the location comes from resolveEnvPath() -- one decision point,
// overridable with MEGA_CRM_ENV_FILE. Node's own env-file loading does NOT
// override variables already present in process.env, so a DATABASE_URL a
// caller (or a test) has already exported/set wins over whatever this file
// contains.
try {
  process.loadEnvFile(resolveEnvPath());
} catch {
  // No configuration file -- rely on already-exported environment variables
  // (CI, containers: every variable is exported directly).
}

if (!process.env.DATABASE_URL) {
  console.error(
    "migrate-runner: DATABASE_URL is required -- set it in the resolved env file or export it directly",
  );
  process.exit(1);
}

/**
 * D-05: an arbitrary but VERSIONED int8 advisory-lock key. Changing this
 * number later would let a differently-keyed runner run concurrently with an
 * old one and defeat the mutual-exclusion guarantee entirely -- it may never
 * change without a migration-window plan. Deliberately distinct from
 * packages/test-support's OWN `MIGRATION_ADVISORY_LOCK_KEY` (8_472_991, used
 * only by the test fixture's migration-applying lock) so a test process and a
 * real migrate-runner invocation can never contend for the same lock.
 */
export const MIGRATION_ADVISORY_LOCK_KEY = 1_405_001;

/**
 * Overridable via env var for the concurrency test (plan 14-01 Task 2) only
 * -- production always runs with these defaults. The default budget is
 * 10 attempts * 3s = 30s of bounded waiting: comfortably longer than any
 * migration in this repo's own chain has ever taken (the full 62-migration
 * history applies in well under a second against an empty database per
 * `npm run test:migrations`), while still failing loudly inside a normal
 * deploy window rather than hanging it indefinitely.
 */
export const MIGRATION_LOCK_MAX_ATTEMPTS = Number(process.env.MIGRATION_LOCK_MAX_ATTEMPTS ?? 10);
export const MIGRATION_LOCK_RETRY_DELAY_MS = Number(process.env.MIGRATION_LOCK_RETRY_DELAY_MS ?? 3_000);

/**
 * 14-07 Task 1 (DB-05, ROADMAP-locked unclean-death scenario) -- TEST-ONLY
 * pause hook, inert unless `MIGRATE_RUNNER_TEST_PAUSE_AFTER_LOCK=1` is
 * explicitly set in the environment. No production invocation of this
 * script ever sets that variable, so this branch is dead code on every real
 * deploy; it exists solely so a test can land a SIGKILL deterministically
 * inside the "lock held, migrate() not yet called" window without a sleep or
 * a poll (mirrors `apps/worker/src/test/harness/sigkill-entrypoint.ts`'s
 * marker-then-never-settle pattern, one level up at the process level: this
 * script must be spawned via `fork()`, not `spawn()`, for `process.send` to
 * exist at all -- `packages/test-support/src/harness/spawn-and-kill.ts`'s
 * `spawnAndAwaitReady` already forks).
 */
export const MIGRATE_RUNNER_TEST_PAUSE_MARKER = "migrate-runner:test-paused-after-lock";


/**
 * Applies every pending migration in `packages/db/migrations` against
 * `databaseUrl`, under a dedicated-connection bounded-retry advisory lock.
 * Propagates any failure (lock exhaustion, a failing migration statement) as
 * a rejected promise -- the caller (this file's own CLI entrypoint, or a
 * test) decides what a non-zero exit means.
 */
export async function runMigrations(databaseUrl) {
  // A dedicated pg.Client, NOT a Pool -- see this file's header. The lock's
  // session-level lifetime must equal this one connection's lifetime.
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  let locked = false;
  try {
    for (let attempt = 0; attempt < MIGRATION_LOCK_MAX_ATTEMPTS && !locked; attempt++) {
      const { rows } = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [
        MIGRATION_ADVISORY_LOCK_KEY,
      ]);
      locked = rows[0].locked;
      if (!locked && attempt < MIGRATION_LOCK_MAX_ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, MIGRATION_LOCK_RETRY_DELAY_MS));
      }
    }

    if (!locked) {
      // Never falls through to migrating -- DB-05's loud-failure requirement.
      throw new Error(
        `migrate-runner: could not acquire advisory lock ${String(MIGRATION_ADVISORY_LOCK_KEY)} after ${String(
          MIGRATION_LOCK_MAX_ATTEMPTS,
        )} attempts -- another migration run is likely stuck; investigate before retrying (this runner never falls back to a blocking pg_advisory_lock)`,
      );
    }

    // TEST-ONLY (see MIGRATE_RUNNER_TEST_PAUSE_MARKER's own doc comment
    // above): posts the marker the INSTANT the lock is held, before
    // migrate() is ever called, then never returns on its own -- only a
    // real kill signal ends this process. A timer here would land at an
    // arbitrary instant and prove nothing (SPEC R6); the marker lets the
    // caller kill provably inside the window instead.
    if (process.env.MIGRATE_RUNNER_TEST_PAUSE_AFTER_LOCK === "1") {
      process.send?.(MIGRATE_RUNNER_TEST_PAUSE_MARKER);
      await new Promise(() => {
        /* intentionally never resolved -- the caller SIGKILLs this process */
      });
    }

    const db = drizzle(client);
    await migrate(db, { migrationsFolder: DRIZZLE_MIGRATIONS_FOLDER });
  } finally {
    if (locked) {
      // Best-effort explicit release: the connection closing right after
      // also releases the session-scoped lock, but an explicit unlock makes
      // the intent visible, matching this repo's "close what you open" style.
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK_KEY]).catch(() => {});
    }
    await client.end();
  }
}

// Only run when invoked directly (`node scripts/migrate-runner.mjs`), never
// when imported -- plan 14-01's own e2e test imports `runMigrations` and
// calls it directly against an ephemeral database; Task 2's concurrency test
// spawns this file as a real child process, which DOES hit this branch.
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations(process.env.DATABASE_URL)
    .then(() => {
      console.log("migrate-runner: all pending migrations applied (or none were pending)");
      process.exit(0);
    })
    .catch((err) => {
      console.error("migrate-runner: FAILED --", err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
