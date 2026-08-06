import { Pool } from "pg";

import { resolveEnvPath } from "../../../scripts/env-path.mjs";
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
 * tenant-scoped `@mega-crm/tenant-context` pool -- required by
 * `attachPartitionCheckFirst`'s admin-scan invariant (see
 * `ensure-partitions.ts`'s and migration `0039`'s comments): a connection
 * that has ever run a tenant-scoped `SET LOCAL app.current_workspace_id`
 * reverts that GUC to `''` (not NULL) once released, which throws inside
 * `contacts`'/`sends`' pre-Phase-10 bare-cast RLS policy. A standalone CLI
 * process's own fresh pool never has that history.
 *
 * NEVER wired into `predev`, `pretest`, or any CI workflow (T-09-22) --
 * this changes live partitioned data and runs only when an operator
 * invokes it deliberately.
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

  // Print only the resolved database NAME, never the full connection
  // string -- the DSN carries credentials (T-09-20).
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
  console.log(`Relocating DEFAULT partition rows on database: ${databaseName}`);

  const pool = new Pool({ connectionString: databaseUrl });
  let report: RelocationReport;
  try {
    report = await relocateAllDefaultRows(pool, PARTITIONED_TABLES);
  } finally {
    await pool.end();
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
