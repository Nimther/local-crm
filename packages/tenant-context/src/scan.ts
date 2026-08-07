import { Pool } from "pg";
import type { PoolClient } from "pg";

/**
 * Phase 10 (SEC-01/SEC-02, D-01/D-02) — the one audited entry point for
 * cross-workspace reads.
 *
 * Mirrors `withTenantTransaction`'s BEGIN/COMMIT/ROLLBACK + release-with-error
 * discipline exactly (see index.ts), with two deliberate differences:
 *
 *   (a) the pool is built LAZILY inside `getScanPool()` from
 *       `process.env.SCAN_DATABASE_URL`, never at module load -- importing
 *       this package from the API process constructs nothing, because the
 *       API's env schema never declares SCAN_DATABASE_URL (P3);
 *   (b) there is no AsyncLocalStorage check and no
 *       `set_config('app.current_workspace_id', ...)` call at all -- role
 *       identity (mega_crm_scan, NOBYPASSRLS, owns no tables, grant/policy
 *       -scoped) is the access-control boundary here, not a session GUC.
 */
let scanPool: Pool | undefined;

function getScanPool(): Pool {
  const dsn = process.env.SCAN_DATABASE_URL;
  if (!dsn) {
    throw new Error(
      "SCAN_DATABASE_URL is required to run a cross-workspace scan -- this " +
        "process's env schema does not declare it if it should never run scans",
    );
  }
  if (!scanPool) {
    scanPool = new Pool({ connectionString: dsn });
    // Same CR-03 discipline as the tenant pool in index.ts: without this
    // listener an idle-connection termination surfaces as an uncaught
    // 'error' event and crashes the process.
    scanPool.on("error", (err) => {
      console.error("idle scan pool client error (connection dropped)", err);
    });
  }
  return scanPool;
}

/**
 * Runs `fn` inside a transaction on the dedicated scan pool. Always releases
 * the client in `finally` so a broken/aborted connection is never silently
 * kept alive in the pool.
 */
export async function withCrossWorkspaceScan<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getScanPool().connect();
  let releaseWithError: Error | undefined;
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      releaseWithError = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
    }
    throw err;
  } finally {
    client.release(releaseWithError);
  }
}

/** Test teardown only -- ends the lazily-constructed scan pool and clears the module-level handle. */
export async function closeScanPool(): Promise<void> {
  if (scanPool) {
    await scanPool.end();
    scanPool = undefined;
  }
}
