import { resolveEnvPath } from "../../../scripts/env-path.mjs";
import { createPgPool } from "../src/pool.js";
import { PARTITIONED_TABLES } from "../src/partitions/ensure-partitions.js";
import { relocateAllDefaultRows, type RelocationReport } from "../src/partitions/relocate-default.js";

/**
 * 09-04 task 2 (D-08): a thin operator CLI wrapper around
 * `relocateAllDefaultRows` -- the SAME exported function
 * `boundary-crossing-late-automation.test.ts` (task 3) calls directly, so
 * the documented procedure and the automated test can never diverge.
 *
 * Contains NO relocation logic of its own: month discovery, batching, and
 * the CHECK-constraint-first attach all live in
 * `packages/db/src/partitions/relocate-default.ts`. This file is
 * formatting and process lifecycle only.
 *
 * Constructs its OWN dedicated `Pool`, entirely separate from the app's
 * tenant-scoped `@mega-crm/tenant-context` pool -- a connection that has
 * ever run a tenant-scoped `SET LOCAL app.current_workspace_id` reverts
 * that GUC to `''` (not NULL) once released, which throws inside
 * `contacts`'/`sends`' pre-Phase-10 bare-cast RLS policy. A standalone CLI
 * process's own fresh pool never has that history.
 *
 * 10-06 (SEC-01/SEC-02, checkpoint option-b): ALSO constructs a SECOND,
 * separate `Pool` from `PARTITION_RELOCATION_ADMIN_DATABASE_URL` -- an
 * operator-supplied DSN for a Postgres role capable of bypassing row-level
 * security (BYPASSRLS or superuser), read ONLY here, never by
 * `apps/api`/`apps/worker` (structurally asserted by this package's own
 * test suite, mirroring plan 10-01's P3 pattern for `SCAN_DATABASE_URL`).
 * `relocateAllDefaultRows` needs this second connection for the ATTACH half
 * of each non-empty month it relocates: Postgres's automatic inherited-FK
 * re-validation against `contacts`/`sends` (both FORCE ROW LEVEL SECURITY)
 * requires a connection that can see every tenant's rows, which the
 * ordinary `mega_crm_app`-backed `DATABASE_URL` connection cannot provide
 * now that migration 0043 drops the legacy `app.admin_scan`-gated policy
 * that used to grant it. Held only by this operator-invoked CLI --
 * documented in SPECIFICATION.md §3 and ARCHITECTURE.md §7, and must never
 * be set in any service environment.
 *
 * NEVER wired into `predev`, `pretest`, or any CI workflow (T-09-22) --
 * this changes live partitioned data and runs only when an operator
 * invokes it deliberately.
 *
 * Phase 14 plan 03 (DB-14, D-11): both pools below are now built through
 * `createPgPool` (this had NO error listener at all before this change --
 * one of two scripts this plan found in that state, the other being
 * `replay-webhook-journal.ts`). `createPgPool`'s fail-closed
 * `assertDsnRequestsTls` never fires here: this script runs under `tsx`
 * with no `NODE_ENV=production` set, so an operator running a report or
 * relocation against a local database is never forced onto TLS. The
 * PRODUCTION TLS guarantee for this script's actual traffic comes from
 * whatever `sslmode` the operator's own `DATABASE_URL`/
 * `PARTITION_RELOCATION_ADMIN_DATABASE_URL` carries in the production env
 * file (SPECIFICATION.md §3) -- not from anything this script enforces.
 */

function formatReport(report: RelocationReport): string {
  const lines: string[] = [];

  for (const table of report.tables) {
    lines.push(`\n${table.table}:`);
    if (table.months.length === 0) {
      lines.push("  (no months found in DEFAULT -- nothing to relocate)");
    }
    for (const month of table.months) {
      lines.push(
        `  ${month.month} -> ${month.partitionName}: ${month.rowsMoved} row(s) moved in ${month.batches} batch(es)`,
      );
    }
    lines.push(`  total rows moved: ${table.totalRowsMoved}`);
    lines.push(`  residual DEFAULT count: ${table.residualDefaultCount}`);
  }

  return lines.join("\n");
}

async function main(): Promise<void> {
  // 08-15: the location comes from resolveEnvPath() -- one decision point,
  // overridable with MEGA_CRM_ENV_FILE. Mirrors scripts/migrate-dev.mjs's
  // own tolerant-of-absence load.
  try {
    process.loadEnvFile(resolveEnvPath());
  } catch {
    // .env not present -- rely on already-exported environment variables
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error(
      "DATABASE_URL is required to run the DEFAULT relocation procedure -- set it in .env",
    );
    process.exitCode = 1;
    return;
  }

  // 10-06 (SEC-01/SEC-02, checkpoint option-b): the elevated DSN for the
  // ATTACH step's FK re-validation visibility. Fails fast, before any
  // connection is opened, rather than letting the first non-empty month's
  // ATTACH fail deep inside relocateAllDefaultRows with a spurious FK
  // violation and no actionable message.
  const adminDatabaseUrl = process.env.PARTITION_RELOCATION_ADMIN_DATABASE_URL;
  if (!adminDatabaseUrl) {
    console.error(
      "PARTITION_RELOCATION_ADMIN_DATABASE_URL is required to run the DEFAULT relocation " +
        "procedure -- set it to a DSN for a Postgres role capable of bypassing row-level " +
        "security (e.g. the cluster superuser), held only by the operator running this CLI. " +
        "Never set this variable in any service (apps/api/apps/worker) environment.",
    );
    process.exitCode = 1;
    return;
  }

  // Print only the resolved database NAME, never the full connection
  // string -- the DSN carries credentials (T-09-20).
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
  console.log(`Relocating DEFAULT partition rows on database: ${databaseName}`);

  const pool = createPgPool({ connectionString: databaseUrl, name: "relocate-default-partition-rows" });
  const adminPool = createPgPool({
    connectionString: adminDatabaseUrl,
    name: "relocate-default-partition-rows-admin",
  });
  let report: RelocationReport;
  try {
    report = await relocateAllDefaultRows(pool, adminPool, PARTITIONED_TABLES);
  } finally {
    await pool.end();
    await adminPool.end();
  }

  console.log(formatReport(report));

  // T-09-23: a partial run must never be reported as success. SKIP LOCKED
  // means a concurrent writer can leave rows behind for a month this run
  // already passed -- a non-zero exit tells the operator to re-run rather
  // than silently declaring victory.
  const residualTotal = report.tables.reduce((sum, t) => sum + t.residualDefaultCount, 0);
  if (residualTotal > 0) {
    console.error(
      `\nDEFAULT is not fully empty (residual total: ${residualTotal} row(s)). ` +
        "A concurrent writer may have added rows to a month this run already passed " +
        "-- re-run this command until every residual count reaches zero.",
    );
    process.exitCode = 1;
    return;
  }

  console.log("\nDEFAULT is empty for every discovered month.");
}

main().catch((err: unknown) => {
  console.error("relocate-default-partition-rows failed:", err);
  process.exitCode = 1;
});
