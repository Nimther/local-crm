import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * 08-09 (QG-05) — the one mechanism that applies migration files.
 *
 * Factored out of `db-fixture.ts` so the fixture and the two migration tests
 * share it rather than each growing their own loop. The advisory lock, the
 * `_test_migrations_applied` tracking table and the per-process memoization
 * stay in the fixture: those are about running the chain ONCE across concurrent
 * test processes, which is a different concern from applying a file.
 *
 * Deliberately not drizzle-kit's snapshot diffing. Only 11 of the 38 migrations
 * have a snapshot in `packages/db/migrations/meta`, so its diff baseline is
 * incomplete and a check built on it would be reporting on a third of the
 * chain while appearing to cover all of it (RESEARCH Pitfall 3).
 */

/** Anything that can execute a raw SQL string — a `pg` Pool or PoolClient. */
export interface MigrationClient {
  query(queryText: string): Promise<unknown>;
}

/**
 * Every migration must carry a zero-padded numeric prefix.
 *
 * `readdirSync().sort()` is lexicographic, so it produces the correct order
 * only because all 38 files happen to be padded. A future `9_fix.sql` would
 * sort BEFORE `10_...` and apply out of order — silently, with nothing
 * downstream noticing until a deploy failed. Rejecting the filename is the only
 * place that can catch it, because by the time the list is returned the
 * information is gone.
 */
const PADDED_PREFIX = /^\d{4,}_/;

/** The `.sql` migration filenames in `dir`, in application order. */
export function listMigrationFiles(dir: string): string[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (!PADDED_PREFIX.test(file)) {
      throw new Error(
        `Migration "${file}" has no zero-padded numeric prefix. ` +
          "Filename order IS application order here, and lexicographic sorting only " +
          "agrees with numeric order while every name is padded — `9_x.sql` would run " +
          "before `10_x.sql`. Rename it to match the 0000_ convention.",
      );
    }
  }

  return files;
}

/**
 * Apply one migration file as a single `query` call — one implicit transaction
 * per file, matching both drizzle-kit migrate's behaviour and the runner this
 * repo already had (RESEARCH Pitfall 4).
 */
export async function applyMigrationFile(
  client: MigrationClient,
  dir: string,
  filename: string,
): Promise<void> {
  const sql = readFileSync(path.join(dir, filename), "utf8");
  await client.query(sql);
}

/**
 * Apply files in order through and including `lastFilename`.
 * Returns what was applied, so a caller can assert the run was not vacuous.
 */
export async function applyMigrationsUpTo(
  client: MigrationClient,
  dir: string,
  lastFilename: string,
): Promise<string[]> {
  const files = listMigrationFiles(dir);
  const index = files.indexOf(lastFilename);
  if (index === -1) {
    throw new Error(`Checkpoint migration "${lastFilename}" is not in ${dir}`);
  }

  const applied = files.slice(0, index + 1);
  for (const file of applied) {
    await applyMigrationFile(client, dir, file);
  }
  return applied;
}

/**
 * Apply every file strictly after `afterFilename`.
 * Returns what was applied — the list is the point: run B asserts it is
 * non-empty, which is what stops a green that migrated nothing.
 */
export async function applyRemainingMigrations(
  client: MigrationClient,
  dir: string,
  afterFilename: string,
): Promise<string[]> {
  const files = listMigrationFiles(dir);
  const index = files.indexOf(afterFilename);
  if (index === -1) {
    throw new Error(`Checkpoint migration "${afterFilename}" is not in ${dir}`);
  }

  const applied = files.slice(index + 1);
  for (const file of applied) {
    await applyMigrationFile(client, dir, file);
  }
  return applied;
}
