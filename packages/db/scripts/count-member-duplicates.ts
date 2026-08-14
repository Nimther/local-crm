import type { Pool } from "pg";

import { resolveEnvPath } from "../../../scripts/env-path.mjs";
import { createPgPool } from "../src/pool.js";

/**
 * Phase 14 (DB-12, Pitfall 17), Task 1: the operator-invoked companion to
 * migration 0062's duplicate pre-check on `member(organizationId, userId)`.
 * Same two-responsibility shape as `count-send-event-duplicates.ts`
 * (migration 0057's proven precedent), gated by `--resolve`:
 *
 *   - default (read-only): reports how many `(organizationId, userId)`
 *     groups collide, how many rows would need deleting to resolve them,
 *     and a bounded sample of the offending groups (row `id`s and
 *     `createdAt`s, never an email address) so an operator can see which
 *     row is the keeper.
 *   - `--resolve`: the actual bounded, per-batch-committing DELETE, kept
 *     out of migration 0062 itself for the same reason 0057 keeps its own
 *     cleanup out-of-migration -- a `DO $$ ... END $$;` block is one
 *     transaction end to end and cannot COMMIT per batch. Deletion is
 *     operator-invoked only (Phase 9 D-08 precedent), never called from a
 *     migration, a worker tick, or a test's setup helper.
 *
 * CONNECTION ROLE: `AUTH_DATABASE_URL` / `mega_crm_auth`, NOT
 * `DATABASE_URL`/`mega_crm_app`. Established from the grants, not assumed
 * (grepped `packages/db/migrations/*.sql` for `GRANT`, per this plan's own
 * <read_first>): migration 0045 revokes ALL privileges on `member` from
 * `mega_crm_app` and re-grants only `SELECT` (line 70) -- `mega_crm_app`
 * cannot issue the `DELETE` this script's `--resolve` path needs.
 * `mega_crm_auth` holds `SELECT, INSERT, UPDATE, DELETE` on `member` (line
 * 43), because better-auth's own adapter performs the full range of data
 * manipulation on it over the lifetime of a request. Using the SAME role
 * for both the read path and `--resolve` keeps this script on one
 * connection lifecycle instead of two.
 *
 * No per-workspace loop, unlike 0057's own duplicate guard: `member`
 * carries NO row-level security at all (migration 0045's header: "RLS is
 * deliberately NOT used here" for the seven better-auth tables), so there
 * is no `app.current_workspace_id` GUC to satisfy and no fail-closed
 * predicate that would reject an unscoped, cross-tenant `SELECT`/`DELETE`
 * against this table. `send_events`' per-workspace loop exists SPECIFICALLY
 * because it is `FORCE ROW LEVEL SECURITY` -- a different situation this
 * script does not have.
 */

interface DuplicateGroupRow {
  id: string;
  createdAt: Date;
  role: string;
}

export interface DuplicateGroupSample {
  organizationId: string;
  userId: string;
  rowCount: number;
  roles: string[];
  rows: { id: string; createdAt: Date; role: string }[];
}

export interface DuplicateCountReport {
  totalGroups: number;
  totalRowsToResolve: number;
  sample: DuplicateGroupSample[];
}

export interface ResolveReport {
  deletedCount: number;
  batches: number;
  roleWarnings: { organizationId: string; userId: string; roles: string[] }[];
}

const DEFAULT_SAMPLE_LIMIT = 20;

/**
 * The exact aggregate the migration's own Step 0 guard is checking for:
 * how many `(organizationId, userId)` groups have more than one row, and
 * how many rows would need deleting to leave exactly one row per group.
 */
export async function countTotals(pool: Pool): Promise<{ groups: number; rowsToResolve: number }> {
  const { rows } = await pool.query<{ groups: string; rows_to_resolve: string }>(
    `SELECT count(*)::text AS groups, coalesce(sum(cnt - 1), 0)::text AS rows_to_resolve
       FROM (
         SELECT count(*) AS cnt
           FROM member
          GROUP BY "organizationId", "userId"
         HAVING count(*) > 1
       ) dupes`,
  );
  return {
    groups: Number(rows[0]?.groups ?? 0),
    rowsToResolve: Number(rows[0]?.rows_to_resolve ?? 0),
  };
}

/**
 * A bounded sample of the offending groups (at most `sampleLimit`), each
 * with its member rows' `id`/`createdAt`/`role` -- enough for an operator
 * to see which row `--resolve` would keep (earliest `createdAt`) without
 * ever printing an email address (T-14-10: this table is not queried here
 * at all; `member` itself carries no email column).
 */
export async function sampleDuplicateGroups(pool: Pool, sampleLimit: number = DEFAULT_SAMPLE_LIMIT): Promise<DuplicateGroupSample[]> {
  const { rows: groupKeys } = await pool.query<{ organization_id: string; user_id: string; row_count: number }>(
    `SELECT "organizationId" AS organization_id, "userId" AS user_id, count(*)::int AS row_count
       FROM member
      GROUP BY "organizationId", "userId"
     HAVING count(*) > 1
      ORDER BY "organizationId", "userId"
      LIMIT $1`,
    [sampleLimit],
  );

  const sample: DuplicateGroupSample[] = [];
  for (const { organization_id: organizationId, user_id: userId, row_count: rowCount } of groupKeys) {
    const { rows } = await pool.query<DuplicateGroupRow>(
      `SELECT id, "createdAt" AS "createdAt", role
         FROM member
        WHERE "organizationId" = $1 AND "userId" = $2
        ORDER BY "createdAt" ASC, id ASC`,
      [organizationId, userId],
    );
    sample.push({
      organizationId,
      userId,
      rowCount,
      roles: [...new Set(rows.map((r) => r.role))],
      rows: rows.map((r) => ({ id: r.id, createdAt: r.createdAt, role: r.role })),
    });
  }
  return sample;
}

/** The read-only report `db:count-member-duplicates` (no `--resolve`) prints. */
export async function countAllDuplicates(pool: Pool, sampleLimit: number = DEFAULT_SAMPLE_LIMIT): Promise<DuplicateCountReport> {
  const totals = await countTotals(pool);
  const sample = totals.groups > 0 ? await sampleDuplicateGroups(pool, sampleLimit) : [];
  return { totalGroups: totals.groups, totalRowsToResolve: totals.rowsToResolve, sample };
}

/**
 * Groups where the surviving-vs-discarded rows carry DIFFERENT `role`
 * values -- the case the plan's action text calls out by name: keeper
 * selection is earliest `createdAt` regardless of role, so a group like
 * this could silently discard a higher-privilege membership row. Printed
 * as a warning (never suppressed, never auto-resolved to a "safer" role)
 * so an operator decides, rather than this script guessing.
 */
export async function findRoleWarnings(pool: Pool): Promise<{ organizationId: string; userId: string; roles: string[] }[]> {
  const { rows } = await pool.query<{ organization_id: string; user_id: string; roles: string[] }>(
    `SELECT "organizationId" AS organization_id, "userId" AS user_id, array_agg(DISTINCT role ORDER BY role) AS roles
       FROM member
      GROUP BY "organizationId", "userId"
     HAVING count(*) > 1 AND count(DISTINCT role) > 1
      ORDER BY "organizationId", "userId"`,
  );
  return rows.map((r) => ({ organizationId: r.organization_id, userId: r.user_id, roles: r.roles }));
}

/**
 * Deletes all but the earliest-`createdAt` row within each
 * `(organizationId, userId)` group -- in bounded, committed batches of at
 * most `pageSize` rows each. `createdAt ASC, id ASC` is the tie-break:
 * earliest `createdAt` is the FIRST membership grant for that person in
 * that organization; `id ASC` is a total-order tiebreaker for the rare
 * case two rows share an identical `createdAt`, so the survivor is
 * deterministic across repeated runs.
 *
 * Idempotent by construction: once no group has more than one row, the
 * `row_number() ... WHERE rn > 1` subquery returns nothing, the DELETE
 * matches zero rows, and the loop exits on the first empty batch.
 *
 * Role-difference warnings are computed ONCE, up front, against the full
 * pre-deletion table state -- not recomputed per batch -- so a warning
 * always reflects a group as it existed BEFORE any row in it was deleted.
 */
export async function resolveAllDuplicates(
  pool: Pool,
  pageSize: number,
  onBatch?: (batchDeleted: number, runningTotal: number) => void,
  onRoleWarning?: (warning: { organizationId: string; userId: string; roles: string[] }) => void,
): Promise<ResolveReport> {
  const roleWarnings = await findRoleWarnings(pool);
  for (const warning of roleWarnings) {
    onRoleWarning?.(warning);
  }

  let deletedCount = 0;
  let batches = 0;

  for (;;) {
    const client = await pool.connect();
    let batchDeleted: number;
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ id: string }>(
        `WITH victims AS (
           SELECT id
             FROM (
               SELECT id,
                      row_number() OVER (
                        PARTITION BY "organizationId", "userId"
                        ORDER BY "createdAt" ASC, id ASC
                      ) AS rn
                 FROM member
             ) ranked
            WHERE rn > 1
            LIMIT $1
         )
         DELETE FROM member WHERE id IN (SELECT id FROM victims)
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

  return { deletedCount, batches, roleWarnings };
}

function formatCountReport(report: DuplicateCountReport): string {
  const lines: string[] = [];
  lines.push("member duplicate groups under (organizationId, userId):");
  if (report.sample.length === 0) {
    lines.push("  (no duplicate group found)");
  }
  for (const group of report.sample) {
    lines.push(`  organization ${group.organizationId} / user ${group.userId}: ${group.rowCount} row(s), roles=[${group.roles.join(", ")}]`);
    for (const row of group.rows) {
      lines.push(`    id=${row.id} createdAt=${row.createdAt.toISOString()} role=${row.role}`);
    }
  }
  if (report.sample.length > 0 && report.sample.length < report.totalGroups) {
    lines.push(`  ... (${report.totalGroups - report.sample.length} more group(s) not shown)`);
  }
  lines.push("");
  lines.push(`TOTAL: ${report.totalGroups} group(s), ${report.totalRowsToResolve} row(s) to resolve`);
  return lines.join("\n");
}

function formatResolveReport(report: ResolveReport): string {
  const lines: string[] = [];
  lines.push("member duplicate resolution (--resolve):");
  for (const warning of report.roleWarnings) {
    lines.push(
      `  WARNING: organization ${warning.organizationId} / user ${warning.userId} has differing roles across duplicates: [${warning.roles.join(", ")}] -- keeper is earliest createdAt regardless of role; verify manually if this matters.`,
    );
  }
  lines.push(`deleted ${report.deletedCount} row(s) in ${report.batches} batch(es)`);
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
  try {
    process.loadEnvFile(resolveEnvPath());
  } catch {
    // .env not present -- rely on already-exported environment variables.
  }

  const resolve = process.argv.includes("--resolve");
  const pageSize = parsePageSize(process.argv);

  const authDatabaseUrl = requireEnv("AUTH_DATABASE_URL");
  // Phase 14 plan 03 (DB-14, D-11): built through the shared factory; not
  // in this plan's own <files_modified> list -- found by the acceptance
  // grep's repo-wide scope, migrated for the same reason as the five named
  // scripts.
  const authPool = createPgPool({ connectionString: authDatabaseUrl, name: "count-member-duplicates-auth" });

  try {
    if (!resolve) {
      const report = await countAllDuplicates(authPool);
      console.log(formatCountReport(report));
      return;
    }

    console.log(`Resolving member duplicates in batches of ${pageSize}...`);
    const report = await resolveAllDuplicates(
      authPool,
      pageSize,
      (batchDeleted, runningTotal) => {
        console.log(`  batch deleted ${batchDeleted} (running total ${runningTotal})`);
      },
      (warning) => {
        console.log(
          `  WARNING: organization ${warning.organizationId} / user ${warning.userId} has differing roles: [${warning.roles.join(", ")}]`,
        );
      },
    );
    console.log(formatResolveReport(report));
  } finally {
    await authPool.end();
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
    console.error("count-member-duplicates failed:", err);
    process.exitCode = 1;
  });
}
