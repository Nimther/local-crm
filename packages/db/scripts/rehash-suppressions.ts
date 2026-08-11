import { Pool } from "pg";

import { resolveEnvPath } from "../../../scripts/env-path.mjs";
import {
  ensureWorkspaceSuppressionKey,
  hashSuppressionEmail,
  normalizeSuppressionEmail,
} from "@mega-crm/contacts-core";

/**
 * Phase 13 (CMP-04, D-02, plan 13-12), Task 2: the operator-invoked backfill
 * between migrations 0060 (expand) and 0061 (contract). Computes
 * `workspace_suppressions.email_hash` for every row that still only has the
 * pre-13-12 plaintext `email`, under that row's OWN workspace's key, and
 * leaves already-hashed rows untouched. Idempotent by construction: a second
 * run finds nothing left with a null `email_hash` and does nothing.
 *
 * Two-phase shape, stated explicitly (REVIEWS.md MEDIUM finding: "reuse the
 * cross-tenant read approach and introduce no new grant" is not by itself a
 * workable instruction for a script that WRITES):
 *
 *   1. DISCOVER on the scan connection, read-only, exactly as
 *      `audit-sends-history.ts`/`count-send-event-duplicates.ts` do:
 *      enumerate workspace ids from `organization`, which `mega_crm_scan`
 *      can already read. `mega_crm_scan` is SELECT-only and migration
 *      0042's grant list does not include `workspace_suppressions` at all,
 *      so this connection never touches that table.
 *   2. WORK per workspace on the ordinary app connection, inside that
 *      workspace's own tenant-scoped transaction (`SET LOCAL
 *      app.current_workspace_id`, the exact mechanism
 *      `@mega-crm/tenant-context`'s `withTenantTransaction` uses internally
 *      -- this package has no dependency on `@mega-crm/tenant-context` and
 *      follows `count-send-event-duplicates.ts`'s own precedent of
 *      replicating the mechanism directly rather than adding that edge):
 *      read the workspace's own null-hash rows, call
 *      `ensureWorkspaceSuppressionKey` (this backfill IS the legitimate,
 *      one-time, operator-invoked case that function's own doc comment
 *      names -- never the pre-send read path), hash, and UPDATE. RLS confines
 *      every read and write here to that one workspace; no scan-role write
 *      grant is needed or added anywhere in this file.
 *
 * Page in bounded batches (default 500 rows/workspace/transaction) with a
 * progress callback, per the `relocate-default-partition-rows.ts` /
 * `count-send-event-duplicates.ts` operator-CLI precedent.
 *
 * Known limitation, recorded rather than silently handled: the pre-13-12
 * unique constraint was `(workspace_id, email)`, exact-string, so two rows
 * differing only by letter case or whitespace (e.g. "A@b.com" and "a@b.com")
 * could already coexist as separate pre-existing rows. Normalizing both
 * produces the SAME hash, which would collide against the new
 * `(workspace_id, email_hash)` unique index. This script detects that case
 * per row (a pre-check SELECT, not a thrown constraint violation) and SKIPS
 * the colliding row rather than crashing the batch -- the first row to reach
 * a given normalized identity keeps its hash; a genuine duplicate is left
 * with a null `email_hash` and is reported so an operator can resolve it by
 * hand before running migration 0061 (which fails closed on any remaining
 * null `email_hash`, so a skipped row is never silently dropped).
 */

interface WorkspaceRow {
  id: string;
}

export interface WorkspaceRehashResult {
  workspaceId: string;
  hashed: number;
  skippedCollisions: number;
  batches: number;
}

export interface RehashReport {
  perWorkspace: WorkspaceRehashResult[];
  totalHashed: number;
  totalSkippedCollisions: number;
  totalBatches: number;
}

/**
 * The WORK half for ONE workspace, one bounded batch at a time. Exported so
 * `packages/db/src/__tests__/suppression-hash-migration.test.ts`'s
 * full-sequence test can call it directly against an ephemeral database,
 * without a live scan/app pool pair.
 */
export async function rehashSuppressionsForWorkspace(
  pool: Pool,
  workspaceId: string,
  pageSize: number,
  onBatch?: (batchHashed: number, runningTotal: number) => void,
): Promise<WorkspaceRehashResult> {
  let hashed = 0;
  let skippedCollisions = 0;
  let batches = 0;
  // Rows identified as an un-resolvable case/whitespace collision are
  // excluded from every subsequent SELECT in this call (not just this
  // batch) -- without this, a colliding row's email_hash stays null
  // forever, so it would be re-selected and re-counted as "skipped" on
  // every following batch, double-(triple-, ...-)counting the same row and
  // preventing the loop from ever reaching a genuinely empty page.
  const permanentlySkippedIds: string[] = [];

  for (;;) {
    const client = await pool.connect();
    let batchHashed = 0;
    let batchNewSkips = 0;
    let batchRowCount = 0;
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);

      const { rows } = await client.query<{ id: string; email: string }>(
        `SELECT id, email FROM workspace_suppressions
         WHERE workspace_id = $1 AND email_hash IS NULL AND email IS NOT NULL
           AND NOT (id = ANY($3::uuid[]))
         LIMIT $2`,
        [workspaceId, pageSize, permanentlySkippedIds],
      );
      batchRowCount = rows.length;

      if (rows.length > 0) {
        const key = await ensureWorkspaceSuppressionKey(client, workspaceId);
        for (const row of rows) {
          const hash = hashSuppressionEmail(normalizeSuppressionEmail(row.email), key);

          const { rows: conflictRows } = await client.query(
            `SELECT 1 FROM workspace_suppressions WHERE workspace_id = $1 AND email_hash = $2 AND id != $3`,
            [workspaceId, hash, row.id],
          );
          if (conflictRows.length > 0) {
            permanentlySkippedIds.push(row.id);
            batchNewSkips += 1;
            continue;
          }

          await client.query(`UPDATE workspace_suppressions SET email_hash = $1 WHERE id = $2`, [hash, row.id]);
          batchHashed += 1;
        }
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    hashed += batchHashed;
    skippedCollisions += batchNewSkips;
    if (batchRowCount === 0) break;
    batches += 1;
    onBatch?.(batchHashed, hashed);
  }

  return { workspaceId, hashed, skippedCollisions, batches };
}

/** The DISCOVER phase, driving the per-workspace WORK phase above across every workspace `mega_crm_scan` can see. */
export async function rehashAllSuppressions(
  scanPool: Pool,
  appPool: Pool,
  pageSize: number,
  onBatch?: (workspaceId: string, batchHashed: number, runningTotal: number) => void,
): Promise<RehashReport> {
  const { rows: workspaces } = await scanPool.query<WorkspaceRow>(`SELECT id FROM organization`);

  const perWorkspace: WorkspaceRehashResult[] = [];
  let totalHashed = 0;
  let totalSkippedCollisions = 0;
  let totalBatches = 0;

  for (const { id: workspaceId } of workspaces) {
    const result = await rehashSuppressionsForWorkspace(appPool, workspaceId, pageSize, (batchHashed, runningTotal) =>
      onBatch?.(workspaceId, batchHashed, runningTotal),
    );
    if (result.hashed > 0 || result.skippedCollisions > 0) {
      perWorkspace.push(result);
    }
    totalHashed += result.hashed;
    totalSkippedCollisions += result.skippedCollisions;
    totalBatches += result.batches;
  }

  return { perWorkspace, totalHashed, totalSkippedCollisions, totalBatches };
}

function formatReport(report: RehashReport): string {
  const lines: string[] = [];
  lines.push("workspace_suppressions backfill (email -> email_hash):");
  if (report.perWorkspace.length === 0) {
    lines.push("  (no workspace had any row left to hash -- nothing to do)");
  }
  for (const row of report.perWorkspace) {
    lines.push(
      `  workspace ${row.workspaceId}: hashed ${row.hashed} row(s) in ${row.batches} batch(es)` +
        (row.skippedCollisions > 0
          ? `, SKIPPED ${row.skippedCollisions} row(s) with a case/whitespace-collision -- resolve by hand before applying migration 0061`
          : ""),
    );
  }
  lines.push("");
  lines.push(
    `TOTAL: hashed ${report.totalHashed} row(s) in ${report.totalBatches} batch(es), ${report.totalSkippedCollisions} skipped collision(s)`,
  );
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
  // this package.
  try {
    process.loadEnvFile(resolveEnvPath());
  } catch {
    // .env not present -- rely on already-exported environment variables.
  }

  const pageSize = parsePageSize(process.argv);
  const databaseUrl = requireEnv("DATABASE_URL");
  const scanDatabaseUrl = requireEnv("SCAN_DATABASE_URL");

  const appPool = new Pool({ connectionString: databaseUrl });
  appPool.on("error", (err) => {
    console.error("idle pg pool client error (connection dropped) -- app pool", err);
  });
  const scanPool = new Pool({ connectionString: scanDatabaseUrl });
  scanPool.on("error", (err) => {
    console.error("idle pg pool client error (connection dropped) -- scan pool", err);
  });

  try {
    console.log(`Backfilling workspace_suppressions.email_hash in batches of ${pageSize}...`);
    const report = await rehashAllSuppressions(scanPool, appPool, pageSize, (workspaceId, batchHashed, runningTotal) => {
      console.log(`  workspace ${workspaceId}: batch hashed ${batchHashed} (running total ${runningTotal})`);
    });
    console.log(formatReport(report));

    if (report.totalSkippedCollisions > 0) {
      console.error(
        `\n${report.totalSkippedCollisions} row(s) were skipped due to a case/whitespace collision with an ` +
          "already-hashed row in the same workspace -- these rows still have a null email_hash and will make " +
          "migration 0061 refuse to apply. Resolve them by hand (decide which of the colliding rows to keep) " +
          "before applying 0061.",
      );
      process.exitCode = 1;
    }
  } finally {
    await appPool.end();
    await scanPool.end();
  }
}

/** Guards the CLI body so importing this module for tests never executes `main()` (mirrors count-send-event-duplicates.ts's own guard). */
function isDirectInvocation(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === `file://${entry}` || import.meta.url.endsWith(entry);
}

if (isDirectInvocation()) {
  main().catch((err: unknown) => {
    console.error("rehash-suppressions failed:", err);
    process.exitCode = 1;
  });
}
