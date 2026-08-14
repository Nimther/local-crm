import type { Pool } from "pg";

import { resolveEnvPath } from "../../../scripts/env-path.mjs";
import { createPgPool } from "../src/pool.js";

/**
 * Phase 13 (CMP-07, plan 13-07), Task 1: the operator-invoked companion to
 * migration 0057's re-based dedup key `(workspace_id, send_id, event_type,
 * occurred_at)`. Two responsibilities in one script, gated by `--resolve`:
 *
 *   - default (read-only): reports, per workspace and in total, how many
 *     groups of `send_events` rows collide under the NEW key and how many
 *     rows would need deleting to resolve them. This is the "blast radius"
 *     0057's own Step 0 guard refuses to proceed past.
 *   - `--resolve`: the actual bounded, per-batch-committing DELETE. This
 *     is NOT expressible inside the migration itself (REVIEWS.md MEDIUM
 *     finding, migration 0057's own header): a `DO $$ ... END $$;` block in
 *     this repo's migration runner is one transaction end to end, so it
 *     cannot COMMIT per batch, and the `--> statement-breakpoint` convention
 *     provides no loop construct at all. Moving the delete out here follows
 *     the Phase 9 D-08 precedent
 *     (`relocate-default-partition-rows.ts`/`relocate-default.ts`): row-level
 *     bulk mutation over a partitioned table is operator-invoked, batched,
 *     and never scheduled.
 *
 * Filters to `send_id IS NOT NULL` throughout (both modes): a null `send_id`
 * row is exempt from the new key's dedup guarantee by construction --
 * Postgres treats NULL as always distinct in a unique index, so two orphan
 * rows never collide under the new key regardless of how many exist. Counting
 * or deleting them here would report/touch rows the migration's own
 * constraint never rejects.
 *
 * Cross-tenant read access follows `audit-sends-history.ts`'s established
 * pattern rather than inventing a new one: `mega_crm_scan` has no grant on
 * `send_events` (migration 0042 names only flow_runs/flows/contacts/sends/
 * organization), so a platform-wide question about `send_events` cannot be
 * answered from the scan pool directly. Instead, this script enumerates
 * every workspace id via the scan pool (`organization`, which
 * `mega_crm_scan` CAN read) and, for each workspace, opens a
 * tenant-scoped transaction on the ordinary `mega_crm_app`/`DATABASE_URL`
 * connection (`SET LOCAL app.current_workspace_id`, the exact mechanism
 * `@mega-crm/tenant-context`'s `withTenantTransaction` uses internally) --
 * ROLLBACK for the read-only count, real COMMIT per batch for `--resolve`.
 * No new database GRANT is introduced anywhere in this file.
 */

interface WorkspaceRow {
  id: string;
}

export interface WorkspaceDuplicateCount {
  workspaceId: string;
  groups: number;
  rowsToResolve: number;
}

export interface DuplicateCountReport {
  perWorkspace: WorkspaceDuplicateCount[];
  totalGroups: number;
  totalRowsToResolve: number;
}

export interface WorkspaceResolveResult {
  workspaceId: string;
  deletedCount: number;
  batches: number;
}

export interface ResolveReport {
  perWorkspace: WorkspaceResolveResult[];
  totalDeleted: number;
  totalBatches: number;
}

/**
 * Counts, for ONE workspace, how many `(workspace_id, send_id, event_type,
 * occurred_at)` groups have more than one row (`groups`) and how many rows
 * would need deleting to leave exactly one row per group (`rowsToResolve`,
 * `sum(count - 1)` over those groups). Read-only: opens a transaction purely
 * to scope `SET LOCAL app.current_workspace_id` for RLS, and always rolls
 * back -- mirrors `audit-sends-history.ts`'s `withWorkspaceReadOnly` discipline
 * of never risking a write surviving a future edit to this function.
 */
export async function countDuplicatesForWorkspace(
  pool: Pool,
  workspaceId: string,
): Promise<{ groups: number; rowsToResolve: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
    const { rows } = await client.query<{ groups: string; rows_to_resolve: string }>(
      `SELECT count(*)::text AS groups, coalesce(sum(cnt - 1), 0)::text AS rows_to_resolve
         FROM (
           SELECT count(*) AS cnt
             FROM send_events
            WHERE send_id IS NOT NULL
            GROUP BY workspace_id, send_id, event_type, occurred_at
           HAVING count(*) > 1
         ) dupes`,
    );
    await client.query("ROLLBACK");
    return {
      groups: Number(rows[0]?.groups ?? 0),
      rowsToResolve: Number(rows[0]?.rows_to_resolve ?? 0),
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The read-only report across every workspace `mega_crm_scan` can see. This
 * is what migration 0057's Step 0 guard is checking for indirectly (via its
 * own in-database assertion) and what an operator runs FIRST, before ever
 * considering `--resolve`.
 */
export async function countAllDuplicates(scanPool: Pool, appPool: Pool): Promise<DuplicateCountReport> {
  const { rows: workspaces } = await scanPool.query<WorkspaceRow>(`SELECT id FROM organization`);

  const perWorkspace: WorkspaceDuplicateCount[] = [];
  let totalGroups = 0;
  let totalRowsToResolve = 0;

  for (const { id: workspaceId } of workspaces) {
    const { groups, rowsToResolve } = await countDuplicatesForWorkspace(appPool, workspaceId);
    if (groups > 0) {
      perWorkspace.push({ workspaceId, groups, rowsToResolve });
    }
    totalGroups += groups;
    totalRowsToResolve += rowsToResolve;
  }

  return { perWorkspace, totalGroups, totalRowsToResolve };
}

/**
 * Deletes, for ONE workspace, all but the earliest-`received_at` row within
 * each `(workspace_id, send_id, event_type, occurred_at)` group where
 * `send_id IS NOT NULL` -- in bounded, committed batches of at most
 * `pageSize` rows each. `received_at ASC, id ASC` is the tie-break: earliest
 * `received_at` wins because it is the FIRST observation of the occurrence
 * and `received_at` is server-controlled (the only field in the row a
 * redelivery cannot vary); `id ASC` is a total-order tiebreaker for the rare
 * case two rows share an identical `received_at` down to the microsecond,
 * so the survivor is deterministic across repeated runs rather than
 * incidental to `row_number()`'s otherwise-unstable tie ordering.
 *
 * Idempotent by construction: once no group has more than one row, the
 * `row_number() ... WHERE rn > 1` subquery returns nothing, the DELETE
 * matches zero rows, and the loop exits on the first empty batch -- a
 * second invocation over an already-resolved workspace does one no-op
 * query and returns `{ deletedCount: 0, batches: 0 }`.
 *
 * `onBatch` is an optional progress callback (this batch's count, the
 * running total) -- the CLI driver uses it to print a running deleted
 * count as required by Task 1's action text; the exported function itself
 * stays silent so tests can assert on the return value alone.
 */
export async function resolveDuplicatesForWorkspace(
  pool: Pool,
  workspaceId: string,
  pageSize: number,
  onBatch?: (batchDeleted: number, runningTotal: number) => void,
): Promise<WorkspaceResolveResult> {
  let deletedCount = 0;
  let batches = 0;

  for (;;) {
    const client = await pool.connect();
    let batchDeleted: number;
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
      const { rows } = await client.query<{ id: string }>(
        `WITH victims AS (
           SELECT id
             FROM (
               SELECT id,
                      row_number() OVER (
                        PARTITION BY workspace_id, send_id, event_type, occurred_at
                        ORDER BY received_at ASC, id ASC
                      ) AS rn
                 FROM send_events
                WHERE send_id IS NOT NULL
             ) ranked
            WHERE rn > 1
            LIMIT $1
         )
         DELETE FROM send_events WHERE id IN (SELECT id FROM victims)
         RETURNING id`,
        [pageSize],
      );
      await client.query("COMMIT");
      batchDeleted = rows.length;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    if (batchDeleted === 0) break;
    deletedCount += batchDeleted;
    batches += 1;
    onBatch?.(batchDeleted, deletedCount);
  }

  return { workspaceId, deletedCount, batches };
}

/** The `--resolve` driver across every workspace, in the same enumeration order `countAllDuplicates` uses. */
export async function resolveAllDuplicates(
  scanPool: Pool,
  appPool: Pool,
  pageSize: number,
  onBatch?: (workspaceId: string, batchDeleted: number, runningTotal: number) => void,
): Promise<ResolveReport> {
  const { rows: workspaces } = await scanPool.query<WorkspaceRow>(`SELECT id FROM organization`);

  const perWorkspace: WorkspaceResolveResult[] = [];
  let totalDeleted = 0;
  let totalBatches = 0;

  for (const { id: workspaceId } of workspaces) {
    const result = await resolveDuplicatesForWorkspace(appPool, workspaceId, pageSize, (batchDeleted, runningTotal) =>
      onBatch?.(workspaceId, batchDeleted, runningTotal),
    );
    if (result.deletedCount > 0) {
      perWorkspace.push(result);
    }
    totalDeleted += result.deletedCount;
    totalBatches += result.batches;
  }

  return { perWorkspace, totalDeleted, totalBatches };
}

function formatCountReport(report: DuplicateCountReport): string {
  const lines: string[] = [];
  lines.push("send_events duplicate groups under the NEW key (workspace_id, send_id, event_type, occurred_at):");
  lines.push("(scoped to send_id IS NOT NULL -- orphan rows are exempt from this key by construction)");
  if (report.perWorkspace.length === 0) {
    lines.push("  (no workspace has any duplicate group)");
  }
  for (const row of report.perWorkspace) {
    lines.push(`  workspace ${row.workspaceId}: ${row.groups} group(s), ${row.rowsToResolve} row(s) to resolve`);
  }
  lines.push("");
  lines.push(`TOTAL: ${report.totalGroups} group(s), ${report.totalRowsToResolve} row(s) to resolve`);
  return lines.join("\n");
}

function formatResolveReport(report: ResolveReport): string {
  const lines: string[] = [];
  lines.push("send_events duplicate resolution (--resolve):");
  if (report.perWorkspace.length === 0) {
    lines.push("  (nothing to resolve -- every workspace was already clean)");
  }
  for (const row of report.perWorkspace) {
    lines.push(`  workspace ${row.workspaceId}: deleted ${row.deletedCount} row(s) in ${row.batches} batch(es)`);
  }
  lines.push("");
  lines.push(`TOTAL: deleted ${report.totalDeleted} row(s) in ${report.totalBatches} batch(es)`);
  return lines.join("\n");
}

const DEFAULT_PAGE_SIZE = 500;

function parsePageSize(argv: string[]): number {
  const flag = argv.find((arg) => arg.startsWith("--page-size="));
  if (!flag) return DEFAULT_PAGE_SIZE;
  const value = Number(flag.slice("--page-size=".length));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--page-size must be a positive integer, got "${flag}"`);
  }
  return value;
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
  // 08-15: same tolerant-of-absence load as every other operator script in
  // this package (relocate-default-partition-rows.ts, audit-sends-history.ts).
  try {
    process.loadEnvFile(resolveEnvPath());
  } catch {
    // .env not present -- rely on already-exported environment variables.
  }

  const resolve = process.argv.includes("--resolve");
  const pageSize = parsePageSize(process.argv);

  const databaseUrl = requireEnv("DATABASE_URL");
  const scanDatabaseUrl = requireEnv("SCAN_DATABASE_URL");

  // Phase 14 plan 03 (DB-14, D-11): built through the shared factory -- see
  // this file's own header-adjacent note in relocate-default-partition-rows.ts
  // for why assertDsnRequestsTls never fires under `tsx` here, and why the
  // production TLS guarantee for this script comes from the env file's own
  // DSNs, not from this script.
  const appPool = createPgPool({ connectionString: databaseUrl, name: "count-send-event-duplicates" });
  const scanPool = createPgPool({
    connectionString: scanDatabaseUrl,
    name: "count-send-event-duplicates-scan",
  });

  try {
    if (!resolve) {
      const report = await countAllDuplicates(scanPool, appPool);
      console.log(formatCountReport(report));
      return;
    }

    console.log(`Resolving send_events duplicates in batches of ${pageSize}...`);
    const report = await resolveAllDuplicates(scanPool, appPool, pageSize, (workspaceId, batchDeleted, runningTotal) => {
      console.log(`  workspace ${workspaceId}: batch deleted ${batchDeleted} (running total ${runningTotal})`);
    });
    console.log(formatResolveReport(report));
  } finally {
    await appPool.end();
    await scanPool.end();
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
    console.error("count-send-event-duplicates failed:", err);
    process.exitCode = 1;
  });
}
