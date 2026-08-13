import { readFileSync, writeFileSync } from "node:fs";

import type { Pool } from "pg";

import { resolveEnvPath } from "../../../scripts/env-path.mjs";
import { createPgPool } from "../src/pool.js";
import {
  PARTITIONED_TABLES,
  monthPartitionName,
  type PartitionedTableConfig,
} from "../src/partitions/ensure-partitions.js";

/**
 * Phase 14 plan 11 (DB-10), Task 1: the defined verification query set a
 * point-in-time restore is checked against, so "the restore started" and
 * "the restore is correct" are never conflated. Every check below is a
 * composed, independently-callable function so `scripts/restore-drill.sh`
 * (Task 2) and this file's own test can both drive them, and so a broken
 * check is caught on every CI run against an ordinary migrated database
 * (`src/__tests__/verify-restored-database.test.ts`) rather than only
 * discovered mid-drill.
 *
 * CONNECTION ROLE -- this is the one thing every other script in this
 * directory gets to treat as a footnote and this one cannot: the caller
 * MUST supply a connection that BYPASSES row-level security (the cluster
 * superuser -- `postgres` -- or a `BYPASSRLS` role), never the ordinary
 * `mega_crm_app` role `DATABASE_URL` this repo's other operator scripts
 * default to. Phase 10's fail-closed posture (migration 0044) makes
 * `mega_crm_app` either THROW (no `app.current_workspace_id` GUC set) or
 * see ZERO rows (a sentinel GUC) on every FORCE ROW LEVEL SECURITY table --
 * either way, a row count taken through that role is not evidence of
 * anything. On a REAL pgBackRest restore this is not an extra credential to
 * invent: physical backups include `pg_authid`, so the cluster's real
 * `postgres` superuser password restores along with everything else, and
 * `scripts/restore-drill.sh` connects as that role. Reads from
 * `VERIFY_RESTORED_DATABASE_URL`, deliberately NOT `DATABASE_URL` --
 * a different name so this requirement cannot be satisfied by accidentally
 * reusing the app-role DSN already sitting in `.env`.
 *
 * WHAT "ok" MEANS: `verifyRestoredDatabase`'s `ok` is `false` when ANY
 * expected partition is missing, when ANY expected table's RLS posture is
 * not enabled-and-forced, or when a check itself could not run (connection
 * or query failure) -- never printed as a pass in that last case (the
 * failure mode this whole plan exists to avoid: a verifier that reports
 * green because a query returned nothing). Row counts and the baseline diff
 * are reported for the operator to read, not folded into `ok` -- there is
 * no absolute-count invariant this script could assert without knowing the
 * tenant's real traffic pattern; that is exactly what the baseline
 * comparison is for.
 *
 * PARTITION EXPECTATIONS ARE `asOf`-RELATIVE, NOT "now"-relative: a cluster
 * restored to a point in the past legitimately lacks partitions for months
 * after that point (D-11's lookahead is a property of "now", not of every
 * historical moment). Expected coverage is gapless monthly coverage from
 * the EARLIEST attached partition through the month containing `asOf`
 * (default: real now, for an ordinary migrated database) -- a month
 * missing in the MIDDLE of that range is a genuine gap; a month absent
 * only because it is still in the future relative to `asOf` is not.
 *
 * RLS EXPECTED SET mirrors `src/__tests__/migrate-from-empty.test.ts`'s own
 * derivation exactly (every base table carrying a `workspace_id` column is
 * tenant-scoped by construction, minus `RLS_ACCEPT_EXEMPT`) rather than a
 * second, independently-maintained list -- the two must never be able to
 * disagree about what "protected" means. If one changes, check the other.
 *
 * BASELINE FORMAT is deliberately a flat JSON object (`{"<table>":
 * <count>, ...}`), not a richer wrapper -- so it can be produced by plain
 * `psql` against the production database without this script ever needing
 * network access to it. `docker/docker-compose.prod.yml`'s `db` service
 * publishes no port (T-14-43): this script cannot reach production
 * directly, and does not try to. `docs/runbooks/restore-drill.md` documents
 * the exact `docker compose exec -T db psql ...` one-liner (using
 * `query_to_xml` to count every table generically, the same catalog walk
 * this script uses) that produces a file in this exact shape.
 */

export interface RowCountObservation {
  table: string;
  count: number;
}

export interface RowCountsResult {
  observed: RowCountObservation[];
}

/** Catalog-sourced identifiers only ever look like this; refusing anything else is cheap insurance against ever interpolating something else (T-14-SC class discipline, mirrors ensure-partitions.ts's allowlist reasoning). */
const SAFE_TABLE_NAME = /^[a-z_][a-z0-9_]*$/;

/**
 * Row count for every non-partition base table in `public` -- partitioned
 * PARENT tables are included (Postgres aggregates across their attached
 * children automatically when queried by the parent's own name), their
 * CHILD partitions are excluded (`NOT c.relispartition`) so each table's
 * total is counted exactly once. Enumerated from the catalog, never a
 * hand-typed table list, so a future table is covered without an edit here.
 */
export async function checkRowCounts(pool: Pool): Promise<RowCountsResult> {
  const { rows } = await pool.query<{ relname: string }>(
    `SELECT c.relname
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p')
        AND NOT c.relispartition
      ORDER BY c.relname`,
  );

  const observed: RowCountObservation[] = [];
  for (const { relname } of rows) {
    if (!SAFE_TABLE_NAME.test(relname)) {
      throw new Error(
        `checkRowCounts: refusing to count table "${relname}" -- its name does not match the identifier shape every real catalog-sourced table name has`,
      );
    }
    const { rows: countRows } = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM "${relname}"`,
    );
    observed.push({ table: relname, count: Number(countRows[0]?.count ?? 0) });
  }
  return { observed };
}

export interface PartitionCheckResult {
  table: string;
  ok: boolean;
  /** Every monthly (non-DEFAULT) child currently attached, sorted. */
  attached: string[];
  /** Expected-but-absent monthly partition names, in chronological order. Empty when `ok`. */
  missing: string[];
}

/**
 * Which expected monthly partitions of `tables` (default: `PARTITIONED_TABLES`
 * -- `events`/`send_events`) are present and attached as of `asOf`, and
 * names any that are missing. Enumerates from `pg_inherits`/`pg_class` --
 * the SAME catalog walk `src/partitions/__tests__/ensure-partitions.test.ts`
 * already uses to assert attached partitions -- never a table-name-pattern
 * guess, which would pass on a cluster missing exactly the partitions that
 * matter.
 */
export async function checkPartitions(
  pool: Pool,
  tables: readonly PartitionedTableConfig[] = PARTITIONED_TABLES,
  asOf: Date = new Date(),
): Promise<PartitionCheckResult[]> {
  const results: PartitionCheckResult[] = [];

  for (const table of tables) {
    const { rows } = await pool.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_inherits i ON i.inhrelid = c.oid
         JOIN pg_class p ON p.oid = i.inhparent
        WHERE n.nspname = 'public'
          AND p.relname = $1
          AND c.relispartition
          AND c.relname <> $2
        ORDER BY c.relname`,
      [table.parentTable, table.defaultPartition],
    );

    const monthlyNamePattern = new RegExp(`^${table.parentTable}_(\\d{4})_(\\d{2})$`);
    const attachedMonths = new Map<string, { year: number; month: number }>();
    for (const { relname } of rows) {
      const match = monthlyNamePattern.exec(relname);
      if (!match) continue; // a non-monthly child would be unexpected given the allowlist; never asserted here, only counted.
      attachedMonths.set(relname, { year: Number(match[1]), month: Number(match[2]) });
    }

    const attached = [...attachedMonths.keys()].sort();

    if (attached.length === 0) {
      results.push({
        table: table.parentTable,
        ok: false,
        attached: [],
        missing: [`${table.parentTable}: no monthly partitions attached at all`],
      });
      continue;
    }

    let earliest = { year: Number.POSITIVE_INFINITY, month: Number.POSITIVE_INFINITY };
    for (const m of attachedMonths.values()) {
      if (m.year < earliest.year || (m.year === earliest.year && m.month < earliest.month)) {
        earliest = m;
      }
    }

    const asOfMonth = { year: asOf.getUTCFullYear(), month: asOf.getUTCMonth() + 1 };

    const missing: string[] = [];
    const cursor = { ...earliest };
    while (cursor.year < asOfMonth.year || (cursor.year === asOfMonth.year && cursor.month <= asOfMonth.month)) {
      const expectedName = monthPartitionName(table.parentTable, new Date(Date.UTC(cursor.year, cursor.month - 1, 1)));
      if (!attachedMonths.has(expectedName)) missing.push(expectedName);

      cursor.month += 1;
      if (cursor.month > 12) {
        cursor.month = 1;
        cursor.year += 1;
      }
    }

    results.push({ table: table.parentTable, ok: missing.length === 0, attached, missing });
  }

  return results;
}

/**
 * Phase 13 (CMP-09, migration 0058, T-13-09-03, disposition: accept).
 * MUST mirror `src/__tests__/migrate-from-empty.test.ts`'s own
 * `RLS_ACCEPT_EXEMPT` exactly -- see that file's header comment for the
 * full rationale (`reputation_alert_state` is platform-internal, never a
 * tenant-facing surface, reviewed and deliberate). Duplicated rather than
 * imported because that file is a `__tests__` module, not a shared library
 * -- if one changes, check the other.
 */
export const RLS_ACCEPT_EXEMPT = new Set(["reputation_alert_state"]);

export interface RlsCheckResult {
  ok: boolean;
  /** Every tenant-scoped (workspace_id-bearing) table this check evaluated. */
  checked: string[];
  /** Tenant-scoped tables that are not both RLS-enabled and RLS-forced, minus `RLS_ACCEPT_EXEMPT`. Empty when `ok`. */
  unprotected: string[];
}

/**
 * Every tenant-scoped table's RLS posture -- both `relrowsecurity` (enabled)
 * and `relforcerowsecurity` (forced, so even the table owner is bound by
 * policy). FORCE matters as much as ENABLE: a restored cluster with RLS
 * enabled but not forced looks healthy and leaks across tenants the moment
 * anything connects as the table owner (`mega_crm_app`). "Tenant-scoped" is
 * derived from the schema (any base table carrying a `workspace_id`
 * column), not a hand-maintained list, so a future table is covered without
 * an edit here -- the exact mechanism `migrate-from-empty.test.ts` already
 * established for this same assertion elsewhere in the codebase.
 */
export async function checkRlsPosture(pool: Pool): Promise<RlsCheckResult> {
  const { rows } = await pool.query<{
    table_name: string;
    relrowsecurity: boolean;
    relforcerowsecurity: boolean;
  }>(
    `SELECT c.relname AS table_name, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p')
        AND NOT c.relispartition
        AND EXISTS (
          SELECT 1 FROM information_schema.columns col
           WHERE col.table_schema = 'public'
             AND col.table_name = c.relname
             AND col.column_name = 'workspace_id'
        )
      ORDER BY c.relname`,
  );

  const checked = rows.map((r) => r.table_name);
  const unprotected = rows
    .filter((r) => (!r.relrowsecurity || !r.relforcerowsecurity) && !RLS_ACCEPT_EXEMPT.has(r.table_name))
    .map((r) => r.table_name);

  return { ok: unprotected.length === 0, checked, unprotected };
}

/** Flat table-name -> row-count map. See this file's header comment for why the shape is this simple (plain `psql` must be able to produce it against production, which publishes no port this script could otherwise reach). */
export type Baseline = Record<string, number>;

/** Captures a baseline FROM a reachable database -- used against a pre-drill snapshot or, when connectivity allows, directly against production. */
export async function captureRowCountBaseline(pool: Pool): Promise<Baseline> {
  const { observed } = await checkRowCounts(pool);
  const baseline: Baseline = {};
  for (const o of observed) baseline[o.table] = o.count;
  return baseline;
}

export function loadBaselineFile(filePath: string): Baseline {
  return JSON.parse(readFileSync(filePath, "utf8")) as Baseline;
}

export function saveBaselineFile(filePath: string, baseline: Baseline): void {
  writeFileSync(filePath, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
}

export interface BaselineDiffEntry {
  table: string;
  baselineCount: number | null;
  observedCount: number | null;
  delta: number | null;
}

/**
 * Per-table difference against a captured baseline -- informational, not a
 * pass/fail signal (see this file's header comment on why). Covers the
 * union of both table sets, so a table present in one but not the other is
 * reported as such rather than silently dropped.
 */
export function diffRowCountsAgainstBaseline(
  observed: readonly RowCountObservation[],
  baseline: Baseline,
): BaselineDiffEntry[] {
  const observedMap = new Map(observed.map((o) => [o.table, o.count]));
  const tableNames = new Set([...observedMap.keys(), ...Object.keys(baseline)]);

  return [...tableNames].sort().map((table) => {
    const baselineCount = table in baseline ? baseline[table] : null;
    const observedCount = observedMap.has(table) ? observedMap.get(table)! : null;
    const delta = baselineCount !== null && observedCount !== null ? observedCount - baselineCount : null;
    return { table, baselineCount, observedCount, delta };
  });
}

export interface VerifyOptions {
  /** The point-in-time the restore was targeting -- drives partition-expectation coverage. Defaults to real now (an ordinary migrated database's own expected state). */
  asOf?: Date;
  baseline?: Baseline;
  partitionedTables?: readonly PartitionedTableConfig[];
}

export interface VerifyResult {
  ok: boolean;
  /** Set only when a check itself could not complete (connection or query failure) -- `ok` is always `false` in that case, and none of the fields below are populated. */
  error?: string;
  rowCounts?: RowCountsResult;
  partitions?: PartitionCheckResult[];
  rls?: RlsCheckResult;
  baselineDiff?: BaselineDiffEntry[];
}

/**
 * The one reporting shell composing every check above. Never throws --
 * a connection or query failure is caught and turned into `{ ok: false,
 * error }`, so the caller (this file's `main`, or `scripts/restore-drill.sh`
 * via the exit code) always gets an explicit answer, never a hang or an
 * uncaught rejection that could be mistaken for "nothing went wrong".
 */
export async function verifyRestoredDatabase(pool: Pool, options: VerifyOptions = {}): Promise<VerifyResult> {
  try {
    const rowCounts = await checkRowCounts(pool);
    const partitions = await checkPartitions(pool, options.partitionedTables, options.asOf ?? new Date());
    const rls = await checkRlsPosture(pool);
    const baselineDiff = options.baseline
      ? diffRowCountsAgainstBaseline(rowCounts.observed, options.baseline)
      : undefined;

    const ok = rls.ok && partitions.every((p) => p.ok);

    return { ok, rowCounts, partitions, rls, baselineDiff };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function formatReport(result: VerifyResult): string {
  const lines: string[] = [];
  lines.push("Restored-database verification (DB-10):");

  if (result.error) {
    lines.push(`ERROR: verification could not complete -- ${result.error}`);
    return lines.join("\n");
  }

  lines.push("");
  lines.push("Row counts:");
  for (const o of result.rowCounts?.observed ?? []) {
    lines.push(`  ${o.table}: ${o.count}`);
  }

  if (result.baselineDiff) {
    lines.push("");
    lines.push("Baseline diff (observed vs. captured baseline):");
    for (const d of result.baselineDiff) {
      lines.push(
        `  ${d.table}: baseline=${d.baselineCount ?? "(absent)"} observed=${d.observedCount ?? "(absent)"} delta=${d.delta ?? "(n/a)"}`,
      );
    }
  }

  lines.push("");
  lines.push("Partitions:");
  for (const p of result.partitions ?? []) {
    lines.push(
      `  ${p.table}: ${p.ok ? "OK" : `MISSING (${p.missing.join(", ")})`} -- ${String(p.attached.length)} attached`,
    );
  }

  lines.push("");
  lines.push("RLS posture:");
  lines.push(`  checked ${String(result.rls?.checked.length ?? 0)} tenant-scoped table(s)`);
  if (result.rls && result.rls.unprotected.length > 0) {
    lines.push(`  NOT enabled-and-forced: ${result.rls.unprotected.join(", ")}`);
  }

  lines.push("");
  lines.push(result.ok ? "OK: restored database verification passed." : "FAIL: restored database verification failed.");
  return lines.join("\n");
}

interface CliArgs {
  baselinePath?: string;
  asOf?: Date;
  captureBaselineTo?: string;
}

/** Mirrors scripts/replay-webhook-journal.ts's own `--flag=value` parsing convention. */
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (const arg of argv) {
    if (arg.startsWith("--baseline=")) {
      args.baselinePath = arg.slice("--baseline=".length);
    } else if (arg.startsWith("--as-of=")) {
      const raw = arg.slice("--as-of=".length);
      const parsed = new Date(raw);
      if (Number.isNaN(parsed.getTime())) {
        throw new Error(`--as-of value "${raw}" is not a valid date/time`);
      }
      args.asOf = parsed;
    } else if (arg.startsWith("--capture-baseline=")) {
      args.captureBaselineTo = arg.slice("--capture-baseline=".length);
    } else {
      throw new Error(`verify-restored-database: unrecognized argument "${arg}"`);
    }
  }
  return args;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required to run this script -- see this file's own header comment for why it must be a superuser/BYPASSRLS DSN, never DATABASE_URL.`);
    process.exitCode = 1;
    throw new Error(`${name} not set`);
  }
  return value;
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile(resolveEnvPath());
  } catch {
    // .env not present -- rely on already-exported environment variables.
  }

  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = requireEnv("VERIFY_RESTORED_DATABASE_URL");
  const pool = createPgPool({ connectionString: databaseUrl, name: "verify-restored-database" });

  try {
    if (args.captureBaselineTo) {
      const baseline = await captureRowCountBaseline(pool);
      saveBaselineFile(args.captureBaselineTo, baseline);
      console.log(
        `Captured row-count baseline (${String(Object.keys(baseline).length)} table(s)) to ${args.captureBaselineTo}`,
      );
      return;
    }

    const baseline = args.baselinePath ? loadBaselineFile(args.baselinePath) : undefined;
    const result = await verifyRestoredDatabase(pool, { asOf: args.asOf, baseline });
    console.log(formatReport(result));
    if (!result.ok) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

/** Guards the CLI body so importing this module for tests never executes `main()` (mirrors scripts/audit-missing-constraints.ts's `isDirectInvocation`). */
function isDirectInvocation(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === `file://${entry}` || import.meta.url.endsWith(entry);
}

if (isDirectInvocation()) {
  main().catch((err: unknown) => {
    console.error("verify-restored-database failed:", err);
    process.exitCode = 1;
  });
}
