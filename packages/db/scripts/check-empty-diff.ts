import fs from "node:fs";
import path from "node:path";

import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";

/**
 * Phase 14 plan 05 (DB-07), Task 2: the ROADMAP's empty-diff smoke test --
 * `drizzle-kit generate` against the current schema must produce nothing
 * new. Exposed as `npm run db:check-empty-diff` (for an operator, and for
 * this plan's own runbook) AND consumed directly by
 * `src/__tests__/migration-empty-diff.test.ts` (the CI-enforced copy) --
 * ONE implementation, two callers, mirroring migration-tiers.ts's
 * `MIGRATION_TIERS` and migration-journal.ts's `readShippedMigrations`
 * pattern already established in this plan/phase.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT (RESEARCH.md Pitfall D -- repeated
 * here AND in the test file AND in the runbook, because an operator
 * mid-incident is exactly the person who will otherwise misread a green
 * result as "the live database matches the code"):
 *
 *   `drizzle-kit generate`'s diff engine compares the CURRENT TypeScript
 *   schema (packages/db/src/schema/*.ts) against the newest snapshot file
 *   under packages/db/migrations/meta/ -- it NEVER connects to, queries, or
 *   even knows about a live database. A manual `ALTER TABLE` run directly
 *   against production would pass this check cleanly, because nothing here
 *   ever looks at production. The check answers exactly one question:
 *   "does the code and the migration history agree with each other" -- not
 *   "does the database agree with either of them". The live-database proof
 *   is the separate `migrate-from-empty.test.ts` chain-application test
 *   (applies every shipped migration to a genuinely empty database); both
 *   checks are required, and neither substitutes for the other.
 *
 * MECHANISM: uses drizzle-kit's own programmatic API
 * (`generateDrizzleJson`/`generateMigration`, exported from `drizzle-kit/api`)
 * rather than shelling out to the `drizzle-kit generate` CLI. The CLI's
 * `writeResult` step is what actually WRITES a new migration/snapshot/journal
 * entry to disk when the diff is non-empty (verified by reading
 * node_modules/drizzle-kit/bin.cjs directly) -- calling the API functions
 * directly means this check can NEVER accidentally write into the
 * repository (T-14-25), because it never calls that function at all. Nothing
 * here needs `DATABASE_URL` or a `dbCredentials` connection either --
 * `drizzle.config.ts` throws without `DATABASE_URL` only because ITS module
 * body eagerly requires it; this script never imports that config file,
 * loading the schema/snapshot files directly instead (confirmed empirically
 * during this plan's execution: `drizzle-kit generate --dialect postgresql
 * --schema ... --out ...` with no `--config` and no `DATABASE_URL` set at
 * all still correctly reports "No schema changes, nothing to migrate").
 *
 * ONLY consumes the LAST snapshot file in `meta/` (sorted by filename),
 * confirmed by reading `preparePrevSnapshot` in node_modules/drizzle-kit
 * (`snapshots[snapshots.length - 1]`) -- this is why the snapshot backfill
 * this plan performs is exactly ONE new file (`0062_snapshot.json`), not all
 * ~52 missing historical snapshots: drizzle-kit's diff algorithm was never
 * going to read the other 51 regardless of whether they existed.
 */

const DB_ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_MIGRATIONS_DIR = path.join(DB_ROOT, "migrations");
const DEFAULT_SCHEMA_DIR = path.join(DB_ROOT, "src/schema");

export interface EmptyDiffResult {
  empty: boolean;
  sqlStatements: string[];
  /** The snapshot file the current schema was diffed against -- the ONLY file drizzle-kit's own diff engine reads. */
  comparedAgainstSnapshot: string;
  /** Count of entries in meta/_journal.json -- every shipped migration, regardless of whether it has its own snapshot file. */
  shippedMigrationCount: number;
  /** Count of *_snapshot.json files under meta/ -- always <= shippedMigrationCount when the history predates consistent snapshot generation. */
  snapshotFileCount: number;
}

/**
 * Dynamically imports every schema file and merges their exports -- the same
 * shape drizzle-kit's own CLI passes to `generateDrizzleJson`.
 *
 * NOT cache-busted: relies on the ordinary ESM module cache. Every real
 * invocation (`npm run db:check-empty-diff`, or CI) starts a fresh Node
 * process with an empty module cache, so this is never stale in production.
 * A caller that needs to check TWO DIFFERENT schema states within one
 * long-lived process (this plan's own negative-case test) must therefore
 * point `schemaDir` at two DIFFERENT directories rather than mutating one
 * directory's files in place between calls -- see
 * migration-empty-diff.test.ts's own comment on this for why.
 */
export async function loadCurrentSchemaImports(
  schemaDir: string = DEFAULT_SCHEMA_DIR,
): Promise<Record<string, unknown>> {
  const files = fs.readdirSync(schemaDir).filter((entry) => entry.endsWith(".ts"));
  const imports: Record<string, unknown> = {};
  for (const file of files) {
    const mod = (await import(path.join(schemaDir, file))) as Record<string, unknown>;
    Object.assign(imports, mod);
  }
  return imports;
}

/** The snapshot filenames under `meta/`, sorted -- mirrors drizzle-kit's own `prepareOutFolder` (`readdirSync(meta).filter(!startsWith('_')).sort()`). */
export function listSnapshotFiles(metaDir: string): string[] {
  return fs
    .readdirSync(metaDir)
    .filter((entry) => !entry.startsWith("_"))
    .sort();
}

/**
 * Runs the empty-diff check against the given migrations/schema directories
 * (defaults to this repository's real `packages/db/migrations` and
 * `packages/db/src/schema`). Never writes anything -- only reads snapshot
 * JSON and schema TS files, and calls drizzle-kit's own pure diff functions.
 */
export async function checkEmptyDiff(options?: {
  migrationsDir?: string;
  schemaDir?: string;
}): Promise<EmptyDiffResult> {
  const migrationsDir = options?.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  const schemaDir = options?.schemaDir ?? DEFAULT_SCHEMA_DIR;
  const metaDir = path.join(migrationsDir, "meta");

  const snapshotFiles = listSnapshotFiles(metaDir);
  const lastSnapshotFile = snapshotFiles[snapshotFiles.length - 1];
  if (lastSnapshotFile === undefined) {
    throw new Error(`checkEmptyDiff: no snapshot files found under ${metaDir}`);
  }
  const prev = JSON.parse(fs.readFileSync(path.join(metaDir, lastSnapshotFile), "utf8")) as {
    id: string;
    [key: string]: unknown;
  };

  const journal = JSON.parse(fs.readFileSync(path.join(metaDir, "_journal.json"), "utf8")) as {
    entries: unknown[];
  };

  const imports = await loadCurrentSchemaImports(schemaDir);
  const cur = generateDrizzleJson(imports, prev.id);
  const sqlStatements = await generateMigration(prev, cur);

  return {
    empty: sqlStatements.length === 0,
    sqlStatements,
    comparedAgainstSnapshot: lastSnapshotFile,
    shippedMigrationCount: journal.entries.length,
    snapshotFileCount: snapshotFiles.length,
  };
}

/** Guards the CLI body so importing this module for tests never executes `main()` (mirrors scripts/audit-missing-constraints.ts's `isDirectInvocation`). */
function isDirectInvocation(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === `file://${entry}` || import.meta.url.endsWith(entry);
}

async function main(): Promise<void> {
  const result = await checkEmptyDiff();
  console.log(
    `Compared current schema (packages/db/src/schema/*.ts) against ${result.comparedAgainstSnapshot} ` +
      `(${String(result.shippedMigrationCount)} shipped migrations, ${String(result.snapshotFileCount)} snapshot file(s) under meta/).`,
  );
  if (result.empty) {
    console.log("OK: drizzle-kit generate produces no new migration -- schema and snapshot history agree.");
    console.log(
      "NOTE: this proves schema<->snapshot parity only, never live-database parity -- see " +
        "src/__tests__/migration-empty-diff.test.ts and docs/runbooks/migration-rollback-and-roll-forward.md.",
    );
    return;
  }
  console.error(
    `FAIL: ${String(result.sqlStatements.length)} pending SQL statement(s) -- the current schema has drifted ` +
      `from ${result.comparedAgainstSnapshot} without a matching migration file:`,
  );
  console.error(result.sqlStatements.join("\n--\n"));
  process.exitCode = 1;
}

if (isDirectInvocation()) {
  main().catch((err: unknown) => {
    console.error("db:check-empty-diff crashed:", err);
    process.exitCode = 1;
  });
}
