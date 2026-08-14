import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  applyMigrationsUpTo,
  createEphemeralDatabase,
  dropEphemeralDatabase,
  getMigrationsDir,
  killAndAwaitExit,
  listMigrationFiles,
  spawnAndAwaitReady,
} from "@mega-crm/test-support";

import { readShippedMigrations } from "@mega-crm/db/src/migration-journal.js";

/**
 * Phase 14 plan 07, Task 1 -- DB-05, ROADMAP-locked: "kill the migration
 * mid-run and confirm the next deploy proceeds."
 *
 * Reproduce with `npm run failure:migrate-unclean-death` from the repo root.
 *
 * Mirrors `sigkill.test.ts`'s register: a REAL child process, spawned via
 * `spawnAndAwaitReady` (which uses `fork()`, giving the child an IPC
 * channel), killed with a real SIGKILL once it signals it has reached the
 * point of interest. Here that point is "the advisory lock is held, but
 * `migrate()` has not been called yet" -- `scripts/migrate-runner.mjs`'s own
 * `MIGRATE_RUNNER_TEST_PAUSE_AFTER_LOCK` hook (inert unless explicitly
 * enabled; see its definition site) posts a marker the instant the lock is
 * acquired and then never returns, so the kill provably lands inside that
 * window rather than at an arbitrary instant (SPEC R6 -- no sleep, no poll).
 *
 * WHY this is safe by construction, and the one fact this test exists to
 * pin rather than assume: `scripts/migrate-runner.mjs` takes its advisory
 * lock on a DEDICATED `pg.Client` connection, never a pool (plan 14-01's own
 * header comment). A session-scoped Postgres advisory lock dies with its
 * session -- SIGKILL cannot be caught, blocked or ignored, so the process
 * has no path to release the lock explicitly, and Postgres releases it FOR
 * the process the instant the TCP connection drops. This test asserts that
 * fact directly against `pg_locks` rather than merely inferring it from a
 * successful second run, so a future refactor that moved the lock onto a
 * connection with a longer lifetime (e.g. a pool) would fail HERE, loudly,
 * instead of only surfacing as an unrelated hang in some later deploy.
 *
 * The database starts at a PARTIALLY-migrated state (a handful of shipped
 * migrations already applied, mirroring "this deploy adds a few more on top
 * of what a prior deploy shipped") -- not because the freeze point requires
 * it (the freeze lands before `migrate()` is ever called, so it would prove
 * the same three facts starting from an empty database), but because it is
 * the more faithful simulation of what an unclean death mid-deploy actually
 * looks like in production, and it exercises the seeding path
 * (`applyMigrationsUpTo` + a hand-mirrored drizzle journal insert, the same
 * shape `packages/test-support/src/db-fixture.ts`'s own fixture writes) that
 * a partially-migrated ephemeral database needs.
 */
describe("failure injection: migration runner killed mid-run (DB-05, ROADMAP-locked)", () => {
  let databaseName: string;
  let adminDsn: string;
  let ephemeralDsn: string;
  let probePool: Pool;
  const MIGRATIONS_DIR = getMigrationsDir();

  const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../..");
  const MIGRATE_RUNNER_PATH = path.join(REPO_ROOT, "scripts/migrate-runner.mjs");

  /**
   * MUST match `scripts/migrate-runner.mjs`'s own exported marker string.
   * Duplicated here, not imported -- the runner is a plain `.mjs` file with
   * no type declarations for this `.ts` test to import cleanly (the same
   * constraint `migrate-runner-advisory-lock.test.ts` documents for
   * `MIGRATION_ADVISORY_LOCK_KEY`).
   */
  const MIGRATE_RUNNER_TEST_PAUSE_MARKER = "migrate-runner:test-paused-after-lock";
  const MIGRATION_ADVISORY_LOCK_KEY = 1_405_001;

  beforeAll(async () => {
    const created = await createEphemeralDatabase({ workspace: "migrate-unclean-death" });
    databaseName = created.databaseName;
    adminDsn = created.adminDsn;
    ephemeralDsn = created.dsn;
    probePool = new Pool({ connectionString: ephemeralDsn, max: 3 });

    // --- seed a PARTIALLY-migrated starting state --------------------------
    const files = listMigrationFiles(MIGRATIONS_DIR);
    const checkpointIndex = Math.min(5, files.length - 2);
    const checkpointFile = files[checkpointIndex];

    const client = await probePool.connect();
    try {
      const applied = await applyMigrationsUpTo(client, MIGRATIONS_DIR, checkpointFile);

      // Mirror drizzle's own journal (packages/test-support/src/db-fixture.ts's
      // identical shape) so drizzle-orm's migrate() -- which decides "pending"
      // by a timestamp cutoff against this table, never by re-diffing the
      // schema -- agrees that exactly these migrations are already applied.
      await client.query(`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
          id SERIAL PRIMARY KEY,
          hash text NOT NULL,
          created_at bigint
        )
      `);
      const shippedByTag = new Map(readShippedMigrations(MIGRATIONS_DIR).map((m) => [m.tag, m.when]));
      for (const file of applied) {
        const tag = file.replace(/\.sql$/, "");
        const when = shippedByTag.get(tag);
        if (when === undefined) {
          throw new Error(`test setup failure: no shipped journal entry for "${tag}"`);
        }
        const contents = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
        const hash = createHash("sha256").update(contents).digest("hex");
        await client.query(`INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ($1, $2)`, [
          hash,
          when,
        ]);
      }
      expect(applied.length, "test setup failure: the checkpoint must leave migrations pending for the runner").toBeGreaterThan(0);
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await probePool?.end();
    if (databaseName) await dropEphemeralDatabase(databaseName, adminDsn);
  });

  it("a runner SIGKILLed the instant it holds the lock leaves no lock behind, and a second runner drives the journal to the full shipped set", async () => {
    // --- kill a real process, frozen right after it takes the lock ---------
    const child = await spawnAndAwaitReady({
      entrypoint: MIGRATE_RUNNER_PATH,
      readyMessage: MIGRATE_RUNNER_TEST_PAUSE_MARKER,
      env: {
        DATABASE_URL: ephemeralDsn,
        MIGRATE_RUNNER_TEST_PAUSE_AFTER_LOCK: "1",
      },
    });

    const exit = await killAndAwaitExit(child);
    expect(exit.signal, "the runner must have been killed, not have exited on its own").toBe("SIGKILL");
    expect(exit.code).toBeNull();

    // --- fact 1: no advisory lock for the migration key survives the kill --
    const { rows: lockRows } = await probePool.query(
      `SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = 0 AND objid = $1`,
      [MIGRATION_ADVISORY_LOCK_KEY],
    );
    expect(
      lockRows,
      "a session-scoped advisory lock must die with its connection -- one surviving row means a future refactor moved the lock onto something that outlives the process",
    ).toEqual([]);

    // --- fact 2: the journal contains no entry for a migration that did not
    // fully apply -- the killed process froze BEFORE migrate() was ever
    // called, so the journal must be UNCHANGED from the partially-migrated
    // seed state, never partially advanced.
    const { rows: journalRowsAfterKill } = await probePool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "drizzle"."__drizzle_migrations"`,
    );
    const seededCount = Math.min(6, listMigrationFiles(MIGRATIONS_DIR).length - 1);
    expect(Number(journalRowsAfterKill[0].count)).toBe(seededCount);

    // --- fact 3: a second runner acquires the lock and drives the journal to
    // the full shipped set, exiting 0 -- the scenario fails if it cannot.
    const secondRun = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const proc = spawn(process.execPath, [MIGRATE_RUNNER_PATH], {
        env: { ...process.env, DATABASE_URL: ephemeralDsn },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      proc.on("error", reject);
      proc.on("exit", (code) => resolve({ code, stderr }));
    });

    expect(secondRun.code, `second runner must exit 0; stderr: ${secondRun.stderr}`).toBe(0);

    const shipped = readShippedMigrations(MIGRATIONS_DIR);
    const { rows: finalJournalRows } = await probePool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "drizzle"."__drizzle_migrations"`,
    );
    expect(
      Number(finalJournalRows[0].count),
      "the second runner must drive the journal to the FULL shipped migration set, not stop partway",
    ).toBe(shipped.length);

    // No advisory lock leaks past the successful second run either.
    const { rows: finalLockRows } = await probePool.query(
      `SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = 0 AND objid = $1`,
      [MIGRATION_ADVISORY_LOCK_KEY],
    );
    expect(finalLockRows).toEqual([]);
  }, 60_000);
});
