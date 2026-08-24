import { resolveEnvPath } from "../../../scripts/env-path.mjs";
import { createPgPool } from "../src/pool.js";
import { restoreWorkspace, WorkspaceNotDeletedError, WorkspacePurgeStartedError } from "../src/workspace-restore.js";

/**
 * Phase 22 (PRG-05, plan 22-06): a thin operator CLI wrapper around
 * `restoreWorkspace` -- the SAME exported function
 * `packages/db/src/__tests__/workspace-restore.test.ts` calls directly, so
 * the documented procedure and the automated test can never diverge
 * (mirrors `relocate-default-partition-rows.ts`'s own D-08 precedent).
 *
 * Contains NO restore logic of its own: the advisory-lock arbitration, the
 * point-of-no-return refusal and the D-15 campaign flip all live in
 * `packages/db/src/workspace-restore.ts`. This file is argument parsing,
 * formatting and process lifecycle only.
 *
 * Never exposed as a route or a UI action (T-22-06-03) -- operator CLI only.
 * An operator must be able to tell "refused because the purge already
 * started" from "refused because it was never soft-deleted" from the exit
 * output alone, so both refusal branches print the thrown error's own
 * message rather than a generic failure line.
 */

function parseArgs(argv: string[]): { workspaceId?: string } {
  const workspaceId = argv.find((arg) => !arg.startsWith("--"));
  return { workspaceId };
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

  const { workspaceId } = parseArgs(process.argv.slice(2));
  if (!workspaceId) {
    console.error("Usage: db:restore-workspace -- <workspace-id>");
    process.exitCode = 1;
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required to run restore-workspace -- set it in .env");
    process.exitCode = 1;
    return;
  }

  const pool = createPgPool({ connectionString: databaseUrl, name: "restore-workspace-cli" });
  try {
    const result = await restoreWorkspace(workspaceId, { pool });
    console.log(`Workspace ${result.workspaceId} restored at ${result.restoredAt.toISOString()}.`);
    if (result.campaignsFlippedToDraft.length > 0) {
      console.log(
        `Campaign(s) flipped from scheduled to draft (overdue at restore time): ${result.campaignsFlippedToDraft.join(", ")}`,
      );
    } else {
      console.log("No overdue scheduled campaigns needed to be flipped to draft.");
    }
  } catch (err) {
    if (err instanceof WorkspacePurgeStartedError || err instanceof WorkspaceNotDeletedError) {
      console.error(`Restore refused (${err.name}): ${err.message}`);
    } else {
      console.error("restore-workspace failed:", err);
    }
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error("restore-workspace failed:", err);
  process.exitCode = 1;
});
