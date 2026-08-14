import type { Pool } from "pg";

import { resolveEnvPath } from "../../../scripts/env-path.mjs";
import { createPgPool } from "../src/pool.js";

/**
 * Phase 14 (DB-12, Pitfall 17), Task 1: a read-only, live-database
 * introspection report answering RESEARCH.md's Open Question 2 with
 * evidence rather than a repeat of its own static schema read. Queries
 * `pg_constraint`/`pg_index`/`pg_class` directly against a migrated
 * database and prints, per table, the unique/primary-key constraints
 * Postgres actually enforces -- so the result can be diffed against what
 * `packages/db/src/schema/*.ts` declares, by eye, for this plan's decision.
 *
 * CONNECTION ROLE: `DATABASE_URL` / `mega_crm_app` (the ordinary app role),
 * NOT `AUTH_DATABASE_URL`/`mega_crm_auth` and NOT a per-workspace loop.
 * Reasoning, established from the grants before this file was written
 * (grepped `packages/db/migrations/*.sql` for `GRANT`, per this plan's own
 * <read_first>):
 *
 *   - This script reads ONLY `pg_catalog` system tables (`pg_constraint`,
 *     `pg_index`, `pg_class`, `pg_namespace`) -- never a data row of any
 *     table it reports on. Postgres grants `SELECT` on every `pg_catalog`
 *     relation to `PUBLIC` by default, so no table-level GRANT (migration
 *     0045's `member`/`invitation` SELECT-only re-grant to `mega_crm_app`,
 *     or `mega_crm_auth`'s full CRUD) is even relevant here -- ANY login
 *     role can run this exact query.
 *   - `member` and `invitation` (and `organization`, `user`, `session`) are
 *     Better Auth tables behind Phase 10's SEC-05 trust boundary and carry
 *     NO row-level security at all (migration 0045's header: "RLS is
 *     deliberately NOT used here"). There is therefore no fail-closed GUC
 *     to satisfy and no reason to loop per-workspace the way migration
 *     0057's duplicate guard does for `send_events` (which IS
 *     `FORCE ROW LEVEL SECURITY`, a genuinely different situation this
 *     script does not have).
 *   - `DATABASE_URL`/`mega_crm_app` is chosen over `AUTH_DATABASE_URL` only
 *     because it is the plainer, already-required-everywhere connection for
 *     a script that touches no table data; `count-member-duplicates.ts`
 *     (this plan's other script) uses `AUTH_DATABASE_URL`/`mega_crm_auth`
 *     instead, because THAT script needs an actual `DELETE` grant on
 *     `member`, which only `mega_crm_auth` holds (migration 0045 line 43 vs
 *     line 70 -- `mega_crm_app` is SELECT-only on `member`/`invitation`).
 *
 * Exit code is always 0 regardless of findings -- an evidence tool for the
 * operator and for this plan's Task 2 decision, not a CI gate. Prints table
 * names, column names, constraint/index names and booleans only -- no row
 * data, no PII (T-14-10).
 */

const TABLES: { schema: string; table: string }[] = [
  { schema: "public", table: "contacts" },
  { schema: "public", table: "workspace_sendgrid_keys" },
  { schema: "public", table: "workspace_send_settings" },
  { schema: "public", table: "session" },
  { schema: "public", table: "organization" },
  { schema: "public", table: "user" },
  { schema: "public", table: "member" },
  { schema: "public", table: "invitation" },
];

interface ConstraintRow {
  table_name: string;
  constraint_name: string;
  constraint_type: string; // 'p' | 'u'
  columns: string[];
  index_name: string | null;
  indisvalid: boolean | null;
}

export interface TableConstraintReport {
  table: string;
  constraints: {
    name: string;
    type: "primary key" | "unique";
    columns: string[];
    indexName: string | null;
    indexValid: boolean | null;
  }[];
}

/**
 * For one table, every primary-key/unique constraint Postgres actually
 * enforces, plus the backing index's name and `pg_index.indisvalid` --
 * the specific state (Pitfall 17) that looks enforced and is not.
 */
export async function auditTable(pool: Pool, schema: string, table: string): Promise<TableConstraintReport> {
  const { rows } = await pool.query<ConstraintRow>(
    `SELECT
       cl.relname AS table_name,
       con.conname AS constraint_name,
       con.contype::text AS constraint_type,
       array(
         SELECT attname::text
           FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
          ORDER BY k.ord
       ) AS columns,
       idx.relname AS index_name,
       pi.indisvalid AS indisvalid
     FROM pg_constraint con
     JOIN pg_class cl ON cl.oid = con.conrelid
     JOIN pg_namespace ns ON ns.oid = cl.relnamespace
     LEFT JOIN pg_index pi ON pi.indexrelid = con.conindid
     LEFT JOIN pg_class idx ON idx.oid = pi.indexrelid
    WHERE ns.nspname = $1
      AND cl.relname = $2
      AND con.contype IN ('p', 'u')
    ORDER BY con.conname`,
    [schema, table],
  );

  return {
    table,
    constraints: rows.map((r) => ({
      name: r.constraint_name,
      type: r.constraint_type === "p" ? "primary key" : "unique",
      columns: r.columns,
      indexName: r.index_name,
      indexValid: r.indisvalid,
    })),
  };
}

export async function auditAllTables(
  pool: Pool,
  tables: { schema: string; table: string }[] = TABLES,
): Promise<TableConstraintReport[]> {
  const reports: TableConstraintReport[] = [];
  for (const { schema, table } of tables) {
    reports.push(await auditTable(pool, schema, table));
  }
  return reports;
}

function formatReport(reports: TableConstraintReport[]): string {
  const lines: string[] = [];
  lines.push("Live pg_constraint/pg_index inventory (DB-12, Pitfall 17):");
  lines.push("(indexValid=false is an INVALID unique index -- enforces nothing, reports no error)");
  lines.push("");
  for (const report of reports) {
    lines.push(`${report.table}:`);
    if (report.constraints.length === 0) {
      lines.push("  (no primary-key or unique constraint found)");
    }
    for (const c of report.constraints) {
      lines.push(
        `  ${c.type.padEnd(11)} ${c.name} (${c.columns.join(", ")}) -- index ${c.indexName ?? "(none)"}, indisvalid=${String(c.indexValid)}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required to run this script -- set it in .env (see SPECIFICATION.md §3).`);
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

  const databaseUrl = requireEnv("DATABASE_URL");
  // Phase 14 plan 03 (DB-14, D-11): built through the shared factory; not
  // in this plan's own <files_modified> list -- found by the acceptance
  // grep's repo-wide scope, migrated for the same reason as the five named
  // scripts.
  const pool = createPgPool({ connectionString: databaseUrl, name: "audit-missing-constraints" });

  try {
    const reports = await auditAllTables(pool);
    console.log(formatReport(reports));
  } finally {
    await pool.end();
  }
}

/** Guards the CLI body so importing this module for tests never executes `main()` (mirrors scripts/lint-migrations.mjs's `isDirectInvocation`). */
function isDirectInvocation(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === `file://${entry}` || import.meta.url.endsWith(entry);
}

if (isDirectInvocation()) {
  main().catch((err: unknown) => {
    console.error("audit-missing-constraints failed:", err);
    process.exitCode = 1;
  });
}
