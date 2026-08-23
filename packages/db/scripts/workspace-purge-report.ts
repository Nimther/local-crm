import { resolveEnvPath } from "../../../scripts/env-path.mjs";
import { createPgPool } from "../src/pool.js";
import { buildWorkspacePurgeReport, formatWorkspacePurgeReport } from "../src/workspace-purge-report.js";

/**
 * Phase 22 (PRG-01, D-07, plan 22-06): a thin operator CLI wrapper around
 * `buildWorkspacePurgeReport` -- the SAME exported function
 * `packages/db/src/__tests__/workspace-restore.test.ts` calls directly, so
 * the documented procedure and the automated test can never diverge
 * (mirrors `relocate-default-partition-rows.ts`'s own D-08 precedent).
 *
 * Contains NO census logic of its own: the per-table counts, the
 * eligibility predicate and the no-PII formatting all live in
 * `packages/db/src/workspace-purge-report.ts`. This file is argument
 * parsing and process lifecycle only.
 *
 * With no argument, prints the census for every eligible workspace; with a
 * workspace id, prints that one workspace's census regardless of its own
 * eligibility (an operator previewing timing before the retention window
 * elapses). Read-only end to end -- see the report module's own header.
 */

function parseArgs(argv: string[]): { workspaceId?: string } {
  const workspaceId = argv.find((arg) => !arg.startsWith("--"));
  return { workspaceId };
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile(resolveEnvPath());
  } catch {
    // .env not present -- rely on already-exported environment variables
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required to run workspace-purge-report -- set it in .env");
    process.exitCode = 1;
    return;
  }

  const { workspaceId } = parseArgs(process.argv.slice(2));
  const pool = createPgPool({ connectionString: databaseUrl, name: "workspace-purge-report-cli" });
  try {
    const report = await buildWorkspacePurgeReport({ pool }, workspaceId ? { workspaceId } : { allEligible: true });
    console.log(formatWorkspacePurgeReport(report));
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error("workspace-purge-report failed:", err);
  process.exitCode = 1;
});
