import fs from "node:fs";
import path from "node:path";

/**
 * Phase 14 plan 01 (D-05/D-12/D-13, DB-05/DB-06, OPS-04/OPS-05) — the ONE
 * definition of "a migration is applied", shared by the one-shot migrate
 * runner (`scripts/migrate-runner.mjs`, which calls drizzle-orm's own
 * `migrate()` and lets IT decide what to apply) and `/readyz`'s independent
 * applied-vs-shipped check (`apps/api/src/modules/ops/health.ts`, which uses
 * THIS module's `assertMigrationsCurrent`). A second, hand-invented
 * comparison here is exactly the A4 risk RESEARCH.md flags — `/readyz`
 * reporting ready against a schema drizzle's own migrator still considers
 * pending.
 *
 * RESOLVED (RESEARCH.md Open Question 1 / Assumption A4): read directly from
 * the installed `drizzle-orm@0.45.2` source
 * (`node_modules/drizzle-orm/pg-core/dialect.js`, `PgDialect.migrate`) rather
 * than from documentation prose alone. The migrator does NOT decide pending
 * status by hash-set membership — the `hash` column it writes is forensic
 * only and is never read back to decide what to apply. It is a
 * TIMESTAMP-CUTOFF comparison:
 *
 *   1. `migrate()` reads only the SINGLE LATEST row from
 *      `"drizzle"."__drizzle_migrations"`
 *      (`order by created_at desc limit 1`).
 *   2. For every migration in `meta/_journal.json` order, it applies the
 *      migration and inserts a journal row IF AND ONLY IF
 *      `lastDbMigration.created_at < migration.folderMillis` — i.e. the
 *      shipped journal entry's `when` (epoch ms) is strictly greater than
 *      the currently-applied set's newest `created_at`.
 *   3. `__drizzle_migrations` columns are: `id` (serial), `hash` (text),
 *      `created_at` (bigint — epoch MILLISECONDS, not a timestamptz; it
 *      stores the journal's own `when` value verbatim).
 *
 * This module reuses exactly that mechanism: "pending" = every shipped
 * journal entry whose `when` is strictly greater than the max `created_at`
 * currently recorded. A hash-set-membership comparison would be a DIFFERENT
 * definition of "applied" than the migrator's own — exactly what D-13
 * forbids.
 */

const MIGRATIONS_SCHEMA = "drizzle";
const MIGRATIONS_TABLE = "__drizzle_migrations";

/** Postgres error code for "relation does not exist" — used to distinguish "never migrated" from a real query failure. */
const RELATION_DOES_NOT_EXIST = "42P01";

/**
 * Absolute path to `packages/db/migrations`, resolved from
 * `import.meta.dirname` so it is correct both from a workspace test (running
 * against `src/`) and from inside a container image (which preserves the
 * same `packages/db/src` <-> `packages/db/migrations` sibling layout —
 * `packages/db` ships no compiled `dist/`, see its `tsconfig.json`'s
 * `noEmit: true`, so this file is read as source everywhere it runs).
 */
export const DRIZZLE_MIGRATIONS_FOLDER = path.resolve(import.meta.dirname, "../migrations");

/** One entry from `packages/db/migrations/meta/_journal.json` — the file drizzle-orm's own `readMigrationFiles` reads, not a `readdirSync` of `*.sql`. */
export interface ShippedMigration {
  tag: string;
  /** Epoch milliseconds — the journal's own `when` field. */
  when: number;
  idx: number;
}

/** One row of `"drizzle"."__drizzle_migrations"`, as the migrator itself writes it. */
export interface AppliedMigrationRow {
  hash: string;
  /** Epoch milliseconds — the column is `bigint`, storing the shipped entry's `when` verbatim. */
  createdAt: number;
}

interface JournalFileEntry {
  idx: number;
  when: number;
  tag: string;
  breakpoints?: boolean;
}

interface JournalFile {
  entries: JournalFileEntry[];
}

/**
 * Parses `migrations/meta/_journal.json` — the journal file itself, not a
 * directory listing — because the journal is what the migrator itself reads
 * (`drizzle-orm/migrator.js`'s `readMigrationFiles`).
 */
export function readShippedMigrations(
  migrationsFolder: string = DRIZZLE_MIGRATIONS_FOLDER,
): ShippedMigration[] {
  const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
  const raw = fs.readFileSync(journalPath, "utf8");
  const journal = JSON.parse(raw) as JournalFile;
  return journal.entries.map((entry) => ({ tag: entry.tag, when: entry.when, idx: entry.idx }));
}

/**
 * Thrown by `assertMigrationsCurrent` when the drizzle migrations table does
 * not exist. A database that has never been migrated is a HARD FAILURE, not
 * a silently-empty comparison that would otherwise report "0 pending" for a
 * completely unmigrated database.
 */
export class MigrationsTableMissingError extends Error {
  constructor() {
    super(
      `"${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" does not exist — this database has never been migrated`,
    );
    this.name = "MigrationsTableMissingError";
  }
}

/** Thrown by `assertMigrationsCurrent` when one or more shipped migrations have not been applied yet. */
export class MigrationsPendingError extends Error {
  readonly pendingTags: string[];

  constructor(pendingTags: string[]) {
    super(`${String(pendingTags.length)} shipped migration(s) not yet applied: ${pendingTags.join(", ")}`);
    this.name = "MigrationsPendingError";
    this.pendingTags = pendingTags;
  }
}

/** Anything that can run a parameterised query — a `pg` `Pool`, `Client`, or `PoolClient` all satisfy this. */
export interface QueryableClient {
  query<T = unknown>(queryText: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

function isRelationMissing(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === RELATION_DOES_NOT_EXIST
  );
}

/**
 * Reads every row of drizzle's own migrations journal table, oldest to
 * newest. Throws `MigrationsTableMissingError` when the table (or its
 * `drizzle` schema) does not exist yet — Postgres error code `42P01` —
 * rather than returning an empty array, which would be indistinguishable
 * from "fully migrated with nothing recorded" (a state that cannot actually
 * occur, since the table is created together with the first migration's
 * insert, but is kept as an explicit distinct failure mode per this module's
 * own tests).
 */
export async function readAppliedMigrations(client: QueryableClient): Promise<AppliedMigrationRow[]> {
  try {
    const { rows } = await client.query<{ hash: string; created_at: string }>(
      `select hash, created_at from "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" order by created_at asc`,
    );
    return rows.map((row) => ({ hash: row.hash, createdAt: Number(row.created_at) }));
  } catch (err) {
    if (isRelationMissing(err)) {
      throw new MigrationsTableMissingError();
    }
    throw err;
  }
}

/**
 * Pure, no I/O — Tests 2-4 need no database at all. Reuses the migrator's own
 * timestamp-cutoff definition (see this module's header comment): every
 * shipped entry whose `when` is strictly greater than the newest applied
 * `createdAt` is pending. An empty `applied` list makes every shipped entry
 * pending (cutoff defaults to `-Infinity`).
 */
export function findPendingMigrations(
  shipped: ShippedMigration[],
  applied: AppliedMigrationRow[],
): ShippedMigration[] {
  const cutoff = applied.reduce((max, row) => Math.max(max, row.createdAt), Number.NEGATIVE_INFINITY);
  return shipped.filter((migration) => migration.when > cutoff);
}

/**
 * The one call `/readyz`'s readiness check (and the onRequest guard, plan
 * 14-01 Task 3) makes. Throws rather than returning a boolean — a database
 * whose currency cannot be proven is a hard failure, never a silent `false`:
 *
 * - `MigrationsTableMissingError` when the journal table itself is absent
 *   (never migrated).
 * - `MigrationsPendingError`, carrying the pending tag list, when one or more
 *   shipped migrations have not been applied.
 *
 * Resolves with no value when every shipped migration is applied.
 */
export async function assertMigrationsCurrent(
  client: QueryableClient,
  migrationsFolder: string = DRIZZLE_MIGRATIONS_FOLDER,
): Promise<void> {
  const shipped = readShippedMigrations(migrationsFolder);
  const applied = await readAppliedMigrations(client); // throws MigrationsTableMissingError if absent
  const pending = findPendingMigrations(shipped, applied);
  if (pending.length > 0) {
    throw new MigrationsPendingError(pending.map((migration) => migration.tag));
  }
}
