import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEphemeralDatabase, dropEphemeralDatabase } from "@mega-crm/test-support";

import { readShippedMigrations } from "../migration-journal.js";

/**
 * Phase 14 plan 01, Task 2 (DB-05) -- pins the migrate runner's exactly-once
 * guarantee under real concurrency, and its loud, never-fall-through failure
 * when the advisory lock cannot be acquired.
 *
 * The runner is spawned as a REAL CHILD PROCESS (`node scripts/migrate-runner.mjs`)
 * throughout -- the exit code and the dedicated-connection lifetime are the
 * properties under test, and an in-process import proves neither. This also
 * sidesteps `.mjs` having no type declarations for a `.ts` test file to
 * import cleanly (RESEARCH/Task 1's own readyz.test.ts hit the same
 * constraint).
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const MIGRATE_RUNNER_PATH = path.join(REPO_ROOT, "scripts/migrate-runner.mjs");

/**
 * MUST match `scripts/migrate-runner.mjs`'s own `MIGRATION_ADVISORY_LOCK_KEY`
 * constant. Duplicated here (not imported) because the runner is a plain
 * `.mjs` file with no type declarations for a `.ts` test to import cleanly.
 */
const MIGRATION_ADVISORY_LOCK_KEY = 1_405_001;

/**
 * SHORT retry budget, used as the env override on both children in the
 * concurrency test. The winner applies the full migration chain in well
 * under a second (per `npm run test:migrations` timing); a LOSER retrying at
 * the runner's production defaults (10 attempts * 3s = 30s) could still be
 * waiting when the winner finishes and releases the lock, then acquire it
 * itself, apply nothing (already current), and ALSO exit 0 -- silently
 * defeating "exactly one exits non-zero". Both children get the identical
 * short override; `pg_try_advisory_lock` still guarantees exactly one
 * INITIAL winner regardless of the budget either side is configured with.
 */
const FAST_RETRY_ENV = {
  MIGRATION_LOCK_MAX_ATTEMPTS: "2",
  MIGRATION_LOCK_RETRY_DELAY_MS: "50",
};

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function spawnRunner(env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MIGRATE_RUNNER_PATH], {
      env: { ...process.env, ...env },
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

describe("migrate-runner.mjs: exactly-once under real concurrency", () => {
  let databaseName: string;
  let adminDsn: string;
  let ephemeralDsn: string;
  let probePool: Pool;

  beforeAll(async () => {
    const created = await createEphemeralDatabase({ workspace: "migrate-runner-concurrency" });
    databaseName = created.databaseName;
    adminDsn = created.adminDsn;
    ephemeralDsn = created.dsn;
    probePool = new Pool({ connectionString: ephemeralDsn, max: 3 });
  });

  afterAll(async () => {
    await probePool?.end();
    if (databaseName) await dropEphemeralDatabase(databaseName, adminDsn);
  });

  it("two runners spawned simultaneously against one un-migrated database apply the chain exactly once; exactly one exits 0, the loser names the lock and never claims to have applied anything; no advisory lock leaks past a successful run", async () => {
    // Launch both without awaiting the first (real concurrency, not a
    // sequential await-then-await that would never race).
    const runA = spawnRunner({ DATABASE_URL: ephemeralDsn, ...FAST_RETRY_ENV });
    const runB = spawnRunner({ DATABASE_URL: ephemeralDsn, ...FAST_RETRY_ENV });
    const [resultA, resultB] = await Promise.all([runA, runB]);

    const codes = [resultA.code, resultB.code];
    expect(codes.filter((code) => code === 0), `expected exactly one 0 exit, got codes ${codes.join(",")}`).toHaveLength(1);
    expect(codes.filter((code) => code !== 0), `expected exactly one non-zero exit, got codes ${codes.join(",")}`).toHaveLength(1);

    const loser = resultA.code === 0 ? resultB : resultA;
    expect(loser.stderr).toMatch(/advisory lock/i);
    expect(loser.stderr).not.toMatch(/applied/i);

    // Every shipped tag recorded EXACTLY once -- no duplicate application.
    const shipped = readShippedMigrations();
    const { rows: appliedRows } = await probePool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "drizzle"."__drizzle_migrations"`,
    );
    expect(Number(appliedRows[0].count)).toBe(shipped.length);

    // No advisory lock with our key remains held past the successful run.
    const { rows: lockRows } = await probePool.query(
      `SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = 0 AND objid = $1`,
      [MIGRATION_ADVISORY_LOCK_KEY],
    );
    expect(lockRows).toEqual([]);
  });
});

describe("migrate-runner.mjs: loud failure when the lock is held by a foreign session", () => {
  let databaseName: string;
  let adminDsn: string;
  let ephemeralDsn: string;
  let probePool: Pool;
  let foreignClient: Client;

  beforeAll(async () => {
    const created = await createEphemeralDatabase({ workspace: "migrate-runner-foreign-lock" });
    databaseName = created.databaseName;
    adminDsn = created.adminDsn;
    ephemeralDsn = created.dsn;
    probePool = new Pool({ connectionString: ephemeralDsn, max: 2 });
  });

  afterAll(async () => {
    await foreignClient?.end().catch(() => {});
    await probePool?.end();
    if (databaseName) await dropEphemeralDatabase(databaseName, adminDsn);
  });

  it("exhausts its bounded retry budget and exits non-zero without applying anything while a foreign session holds the lock; a subsequent run succeeds once the lock is released", async () => {
    // A separate long-lived session takes the lock BEFORE the runner ever
    // tries -- the blocking form is legitimate here, on a test-owned client
    // simulating "a foreign session already holds it"; the plan's
    // never-blocking prohibition applies only to scripts/migrate-runner.mjs
    // itself.
    foreignClient = new Client({ connectionString: ephemeralDsn });
    await foreignClient.connect();
    await foreignClient.query("SELECT pg_advisory_lock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);

    const blocked = await spawnRunner({ DATABASE_URL: ephemeralDsn, ...FAST_RETRY_ENV });
    expect(blocked.code).not.toBe(0);
    expect(blocked.stderr).toMatch(/advisory lock/i);

    // Never proceeded to migrate: the drizzle journal schema was never even
    // created (the throw happens before `migrate()` is called).
    const { rows: beforeRows } = await probePool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.schemata WHERE schema_name = 'drizzle'`,
    );
    expect(Number(beforeRows[0].count)).toBe(0);

    // Release the foreign lock -- the next invocation must now succeed and
    // apply the full pending set normally.
    await foreignClient.query("SELECT pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);

    const succeeded = await spawnRunner({ DATABASE_URL: ephemeralDsn, ...FAST_RETRY_ENV });
    expect(succeeded.code).toBe(0);

    const shipped = readShippedMigrations();
    const { rows: afterRows } = await probePool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "drizzle"."__drizzle_migrations"`,
    );
    expect(Number(afterRows[0].count)).toBe(shipped.length);
  });
});
