import type { Pool, PoolClient } from "pg";
import { createPgPool } from "./pool.js";
import { PURGE_TABLE_ORDER, countPurgeTableRows, type PurgeTable } from "./workspace-purge-tables.js";

/**
 * Phase 22 (PRG-01, D-07, plan 22-06): the on-demand eligibility census an
 * operator can print at any time, without waiting for the worker's own
 * report-only tick. Shares the SAME `PURGE_TABLE_ORDER`/`countPurgeTableRows`
 * primitives the tick's own `computePurgeCensus`
 * (apps/worker/src/queues/workspace-purge.worker.ts) uses, so the CLI and
 * the tick can never drift into two different censuses for the same
 * workspace.
 *
 * Deliberately READ-ONLY: `buildWorkspacePurgeReport` issues no INSERT into
 * `purge_records`, no status transition, and takes no advisory lock. This is
 * an operator's on-demand VIEW of D-07's announcement, not a second way to
 * trigger one.
 *
 * `countPurgeTableRows`'s two tables (`contacts`,
 * `subscription_status_history`) carry a fail-closed `workspace_isolation`
 * RLS policy (migration 0044) -- this module has no
 * `@mega-crm/tenant-context` transaction to ride on (that package depends on
 * `@mega-crm/db`, not the other way around), so it binds
 * `app.current_workspace_id` itself, per workspace, exactly the same way
 * `workspace-restore.ts` does.
 *
 * `apps/worker`'s own `findEligibleWorkspaces` query and this module's
 * `loadEligibleOrganizations` MUST stay in sync -- a package cannot import
 * from an app, so the "soft-deleted and past its retention window" predicate
 * is necessarily duplicated here rather than shared. Any future change to
 * one must be mirrored in the other.
 */

export interface WorkspacePurgeReportEntry {
  workspaceId: string;
  deletedAt: Date | null;
  /** `deletedAt + retentionDays`, or `null` when `deletedAt` itself is null. */
  eligibleAt: Date | null;
  /** The matching `purge_records.status`, or the literal `"not yet reported"` when no row exists yet. */
  status: string;
  tableCounts: Record<PurgeTable, number>;
}

export interface WorkspacePurgeReport {
  generatedAt: Date;
  workspaces: WorkspacePurgeReportEntry[];
}

/** One workspace by id, or every workspace whose retention window has elapsed -- mirrors `findEligibleWorkspaces`'s own predicate. */
export type WorkspacePurgeReportTarget = { workspaceId: string } | { allEligible: true };

export interface WorkspacePurgeReportDeps {
  pool?: Pool;
  /** Defaults to `WORKSPACE_PURGE_RETENTION_DAYS`, or 30 -- see this module's header for why this is read directly rather than imported from apps/worker's env module. */
  retentionDays?: number;
  now?: () => Date;
}

let defaultReportPool: Pool | undefined;

/** Lazily built -- see `workspace-restore.ts`'s identical `getDefaultRestorePool` for the full rationale. */
function getDefaultReportPool(): Pool {
  if (!defaultReportPool) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL must be set to construct the default workspace-purge-report pool");
    }
    defaultReportPool = createPgPool({ connectionString: databaseUrl, name: "workspace-purge-report" });
  }
  return defaultReportPool;
}

/**
 * Mirrors `apps/worker/src/env.ts`'s own default (30) without importing that
 * module -- a package cannot depend on an app. The floor/validation of this
 * value (`WORKSPACE_PURGE_RETENTION_DAYS_FLOOR`) is the worker's own
 * boot-time concern, not this read-only report's.
 */
const DEFAULT_RETENTION_DAYS = 30;

function readRetentionDaysFromEnv(): number {
  const raw = process.env.WORKSPACE_PURGE_RETENTION_DAYS;
  if (raw === undefined) return DEFAULT_RETENTION_DAYS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RETENTION_DAYS;
}

interface OrganizationSoftDeleteRow {
  id: string;
  deletedAt: Date | null;
}

async function loadOneOrganization(client: Pool, workspaceId: string): Promise<OrganizationSoftDeleteRow[]> {
  const { rows } = await client.query<{ id: string; deletedAt: Date | null }>(
    `SELECT id, "deletedAt" AS "deletedAt" FROM organization WHERE id = $1`,
    [workspaceId],
  );
  return rows;
}

/** Mirrors `findEligibleWorkspaces` in apps/worker/src/queues/workspace-purge.worker.ts -- see this module's header comment. */
async function loadEligibleOrganizations(client: Pool, now: Date, retentionDays: number): Promise<OrganizationSoftDeleteRow[]> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const { rows } = await client.query<{ id: string; deletedAt: Date }>(
    `SELECT id, "deletedAt" AS "deletedAt" FROM organization WHERE "deletedAt" IS NOT NULL AND "deletedAt" <= $1::timestamp`,
    [cutoff],
  );
  return rows;
}

async function loadPurgeStatus(client: Pool, workspaceId: string): Promise<string> {
  const { rows } = await client.query<{ status: string }>(
    `SELECT status FROM purge_records WHERE workspace_id = $1`,
    [workspaceId],
  );
  return rows[0]?.status ?? "not yet reported";
}

/** Opens its own short-lived, tenant-scoped transaction -- read-only, never a write. */
async function buildTableCountsForWorkspace(pool: Pool, workspaceId: string): Promise<Record<PurgeTable, number>> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('app.current_workspace_id', $1, true)`, [workspaceId]);
    const counts = {} as Record<PurgeTable, number>;
    for (const table of PURGE_TABLE_ORDER) {
      counts[table] = await countPurgeTableRows(client, table, workspaceId);
    }
    await client.query("COMMIT");
    return counts;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Builds the census for `target`: one workspace by id, or every workspace
 * whose retention window has elapsed. Read-only end to end -- see this
 * module's header comment.
 */
export async function buildWorkspacePurgeReport(
  deps: WorkspacePurgeReportDeps,
  target: WorkspacePurgeReportTarget,
): Promise<WorkspacePurgeReport> {
  const pool = deps.pool ?? getDefaultReportPool();
  const generatedAt = deps.now?.() ?? new Date();
  const retentionDays = deps.retentionDays ?? readRetentionDaysFromEnv();

  const organizations =
    "workspaceId" in target
      ? await loadOneOrganization(pool, target.workspaceId)
      : await loadEligibleOrganizations(pool, generatedAt, retentionDays);

  const workspaces: WorkspacePurgeReportEntry[] = [];
  for (const org of organizations) {
    const eligibleAt = org.deletedAt ? new Date(org.deletedAt.getTime() + retentionDays * 24 * 60 * 60 * 1000) : null;
    const status = await loadPurgeStatus(pool, org.id);
    const tableCounts = await buildTableCountsForWorkspace(pool, org.id);
    workspaces.push({ workspaceId: org.id, deletedAt: org.deletedAt, eligibleAt, status, tableCounts });
  }

  return { generatedAt, workspaces };
}

/**
 * Plain-text operator output. Ids, timestamps, statuses and counts ONLY --
 * a workspace name is the tenant's own identifying data, and the D-09
 * tombstone exists to remove it, so this report has no business reproducing
 * it (T-22-06-04).
 */
export function formatWorkspacePurgeReport(report: WorkspacePurgeReport): string {
  const lines: string[] = [`workspace-purge report -- generated ${report.generatedAt.toISOString()}`];

  if (report.workspaces.length === 0) {
    lines.push("", "(no matching workspaces)");
    return lines.join("\n");
  }

  for (const ws of report.workspaces) {
    lines.push("", `workspace: ${ws.workspaceId}`);
    lines.push(`  deletedAt:  ${ws.deletedAt ? ws.deletedAt.toISOString() : "(not soft-deleted)"}`);
    lines.push(`  eligibleAt: ${ws.eligibleAt ? ws.eligibleAt.toISOString() : "n/a"}`);
    lines.push(`  status:     ${ws.status}`);
    for (const table of PURGE_TABLE_ORDER) {
      lines.push(`  ${table}: ${ws.tableCounts[table]}`);
    }
  }

  return lines.join("\n");
}
