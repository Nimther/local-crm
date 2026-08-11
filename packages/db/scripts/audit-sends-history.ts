import { Pool, type PoolClient } from "pg";

import { resolveEnvPath } from "../../../scripts/env-path.mjs";

/**
 * Phase 11, plan 11-02 (DLV-03/ROADMAP pre-migration audit, Pitfall 2) — a
 * strictly read-only operator CLI answering the ROADMAP's pre-migration
 * history questions BEFORE the `reconciling`/`unknown` enum values ship:
 * how many `sends` rows exist per status, how many `failed` rows have no
 * corresponding webhook evidence in `send_events` (the population that
 * would have become `reconciling`/`unknown` had this phase existed
 * earlier), and how many `send_events` rows carry no `send_id` at all (the
 * pre-existing, permanently-orphaned evidence population).
 *
 * Contains NO INSERT, no UPDATE, no DELETE, no ALTER, and no CREATE
 * statement anywhere in this file -- every query below is a plain SELECT
 * (or a set_config('app.current_workspace_id', ...) call, which is a
 * session-configuration read/write of a GUC, not a data mutation). The
 * automated check accompanying this file's <verify> strips comments and
 * greps the remainder for those five keywords, so this constraint is
 * mechanically enforced, not just asserted here.
 *
 * DEVIATION FROM THE ORIGINAL PLAN TEXT (Rule 3, blocking-issue fix,
 * documented in 11-02-SUMMARY.md): the plan's <action> describes connecting
 * with a single `new Pool({ connectionString: process.env.DATABASE_URL })`
 * -- the ordinary `mega_crm_app` role, no `@mega-crm/tenant-context`. That
 * literally cannot answer a CROSS-TENANT question: `sends` and `send_events`
 * both carry `ENABLE + FORCE ROW LEVEL SECURITY` with the fail-closed
 * `workspace_isolation` predicate (migration 0044) that mega_crm_app must
 * satisfy on every query -- a connection that has never called
 * `set_config('app.current_workspace_id', ...)` throws
 * `unrecognized configuration parameter "app.current_workspace_id"` on the
 * FIRST query against either table (empirically confirmed while building
 * this script; not a theoretical concern). Two things fix this without
 * inventing any new grant or migration:
 *
 *   1. `mega_crm_scan` (the dedicated cross-workspace read role Phase 10
 *      introduced) already holds an unrestricted `GRANT SELECT` on `sends`
 *      and `organization` (migration 0042) -- report items 1/4/5 below (the
 *      per-status counts, the per-kind counts, and the oldest/newest
 *      `queued_at`) and the workspace-id enumeration used by item 2 use a
 *      SECOND pool built from `SCAN_DATABASE_URL` for exactly this reason.
 *      `mega_crm_scan` is NOT granted anything on `send_events`, so it
 *      cannot answer items 2/3/6 on its own.
 *   2. For the two counts that need `send_events` (items 2/3/6), this script
 *      loops over every workspace id (read from the scan pool's
 *      `organization` access) and, for each one, opens a dedicated
 *      transaction on the ordinary `DATABASE_URL`/`mega_crm_app` connection
 *      that sets `app.current_workspace_id` via `SET LOCAL` (the exact same
 *      mechanism `@mega-crm/tenant-context`'s `withTenantTransaction` uses
 *      internally) and ALWAYS issues a rollback rather than a commit when
 *      done -- so a copy-paste mistake in a future edit still cannot leave
 *      behind a write, and no new cross-tenant grant on `send_events` is
 *      introduced anywhere in this phase. `@mega-crm/tenant-context` itself
 *      is still not imported, matching the plan's stated intent that this
 *      is a standalone operator script with its own connection lifecycle,
 *      not a caller of the app's shared tenant-scoped pool.
 *
 * Reports counts, timestamps, and status/kind labels ONLY -- never an email
 * address, a contact id, a workspace id, or any payload content (mirrors
 * `relocate-default-partition-rows.ts`'s own discipline of printing only
 * the resolved database NAME, never a full connection string).
 */

interface StatusCount {
  status: string;
  count: string;
}

interface KindCount {
  kind: string;
  count: string;
}

interface QueuedAtBounds {
  oldest: Date | null;
  newest: Date | null;
}

interface WorkspaceRow {
  id: string;
}

interface FailedEvidenceCounts {
  failedNoEvidence: number;
  failedWithEvidence: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(
      `${name} is required to run the sends-history audit -- set it in .env (see SPECIFICATION.md §3).`,
    );
    process.exitCode = 1;
    throw new Error(`${name} not set`);
  }
  return value;
}

/**
 * Runs `fn` inside a transaction scoped to `workspaceId` via the SAME
 * `SET LOCAL app.current_workspace_id` mechanism `@mega-crm/tenant-context`
 * uses, on a plain `mega_crm_app` connection -- and ALWAYS finishes with a
 * rollback, never a commit, regardless of whether `fn` throws. Every query
 * this script runs through here is a plain read, so the rollback changes
 * nothing observable; it exists purely as a second, structural line of
 * defense (mirrors this file's header comment) against a future edit
 * accidentally adding a write here and having it persist.
 */
async function withWorkspaceReadOnly<T>(
  pool: Pool,
  workspaceId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
    const result = await fn(client);
    await client.query("ROLLBACK");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Per-workspace contribution to items 2/3: how many of this workspace's
 * `failed` sends have zero rows in `send_events`, versus at least one. Uses
 * `EXISTS` (not a `LEFT JOIN`) so a `failed` send with more than one
 * matching event row is still counted exactly once.
 */
async function failedEvidenceCountsForWorkspace(
  pool: Pool,
  workspaceId: string,
): Promise<FailedEvidenceCounts> {
  return withWorkspaceReadOnly(pool, workspaceId, async (client) => {
    const { rows } = await client.query<{ failed_no_evidence: string; failed_with_evidence: string }>(
      `SELECT
         count(*) FILTER (
           WHERE NOT EXISTS (SELECT 1 FROM send_events se WHERE se.send_id = sends.id)
         )::text AS failed_no_evidence,
         count(*) FILTER (
           WHERE EXISTS (SELECT 1 FROM send_events se WHERE se.send_id = sends.id)
         )::text AS failed_with_evidence
       FROM sends
       WHERE status = 'failed'`,
    );
    return {
      failedNoEvidence: Number(rows[0]?.failed_no_evidence ?? 0),
      failedWithEvidence: Number(rows[0]?.failed_with_evidence ?? 0),
    };
  });
}

/** Per-workspace contribution to item 6: `send_events` rows with no `send_id` at all. */
async function orphanedEventsCountForWorkspace(pool: Pool, workspaceId: string): Promise<number> {
  return withWorkspaceReadOnly(pool, workspaceId, async (client) => {
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM send_events WHERE send_id IS NULL`,
    );
    return Number(rows[0]?.count ?? 0);
  });
}

function formatReport(
  statusCounts: StatusCount[],
  total: number,
  kindCounts: KindCount[],
  bounds: QueuedAtBounds,
  failedEvidence: FailedEvidenceCounts,
  orphanedEventsCount: number,
): string {
  const lines: string[] = [];

  lines.push("sends.status counts:");
  for (const row of statusCounts) {
    lines.push(`  ${row.status.padEnd(12)} ${row.count}`);
  }
  lines.push(`  ${"TOTAL".padEnd(12)} ${String(total)}`);

  lines.push("");
  lines.push("sends.kind counts:");
  for (const row of kindCounts) {
    lines.push(`  ${row.kind.padEnd(12)} ${row.count}`);
  }

  lines.push("");
  lines.push("sends.queued_at range:");
  lines.push(`  oldest: ${bounds.oldest ? bounds.oldest.toISOString() : "(no rows)"}`);
  lines.push(`  newest: ${bounds.newest ? bounds.newest.toISOString() : "(no rows)"}`);

  lines.push("");
  lines.push("status = 'failed' rows, by whether send_events has a matching row:");
  lines.push(`  no matching send_events   ${String(failedEvidence.failedNoEvidence)}`);
  lines.push(`  has matching send_events  ${String(failedEvidence.failedWithEvidence)}`);

  lines.push("");
  lines.push("send_events rows with a null send_id (never correlatable to any send):");
  lines.push(`  ${String(orphanedEventsCount)}`);

  return lines.join("\n");
}

async function main(): Promise<void> {
  // 08-15: the location comes from resolveEnvPath() -- one decision point,
  // mirroring relocate-default-partition-rows.ts's own tolerant-of-absence load.
  try {
    process.loadEnvFile(resolveEnvPath());
  } catch {
    // No configuration file present -- rely on already-exported environment variables.
  }

  const databaseUrl = requireEnv("DATABASE_URL");
  const scanDatabaseUrl = requireEnv("SCAN_DATABASE_URL");

  const appPool = new Pool({ connectionString: databaseUrl });
  // CR-03 precedent (see @mega-crm/db's own pool.on): without this listener
  // an idle-connection termination surfaces as an uncaught 'error' event and
  // crashes the process.
  appPool.on("error", (err) => {
    console.error("idle pg pool client error (connection dropped) -- app pool", err);
  });

  const scanPool = new Pool({ connectionString: scanDatabaseUrl });
  scanPool.on("error", (err) => {
    console.error("idle pg pool client error (connection dropped) -- scan pool", err);
  });

  try {
    const [statusCountsResult, totalResult, kindCountsResult, boundsResult, workspacesResult] =
      await Promise.all([
        scanPool.query<StatusCount>(
          `SELECT status::text AS status, count(*)::text AS count FROM sends GROUP BY status ORDER BY status`,
        ),
        scanPool.query<{ count: string }>(`SELECT count(*)::text AS count FROM sends`),
        scanPool.query<KindCount>(
          `SELECT kind, count(*)::text AS count FROM sends GROUP BY kind ORDER BY kind`,
        ),
        scanPool.query<{ oldest: Date | null; newest: Date | null }>(
          `SELECT min(queued_at) AS oldest, max(queued_at) AS newest FROM sends`,
        ),
        scanPool.query<WorkspaceRow>(`SELECT id FROM organization`),
      ]);

    const total = Number(totalResult.rows[0]?.count ?? 0);
    const bounds: QueuedAtBounds = {
      oldest: boundsResult.rows[0]?.oldest ?? null,
      newest: boundsResult.rows[0]?.newest ?? null,
    };

    let failedNoEvidence = 0;
    let failedWithEvidence = 0;
    let orphanedEventsCount = 0;
    for (const { id: workspaceId } of workspacesResult.rows) {
      const evidence = await failedEvidenceCountsForWorkspace(appPool, workspaceId);
      failedNoEvidence += evidence.failedNoEvidence;
      failedWithEvidence += evidence.failedWithEvidence;
      orphanedEventsCount += await orphanedEventsCountForWorkspace(appPool, workspaceId);
    }

    console.log(
      formatReport(
        statusCountsResult.rows,
        total,
        kindCountsResult.rows,
        bounds,
        { failedNoEvidence, failedWithEvidence },
        orphanedEventsCount,
      ),
    );

    console.log("");
    console.log(
      "This run made no writes -- every read above ran through a plain SELECT or a rolled-back " +
        "transaction. Reclassifying any of the rows reported here is out of scope for this phase " +
        "(Pitfall 2): the enum-add migrations that follow this audit change no historical row's status.",
    );
  } finally {
    await appPool.end();
    await scanPool.end();
  }
}

main().catch((err: unknown) => {
  console.error("audit-sends-history failed:", err);
  process.exitCode = 1;
});
