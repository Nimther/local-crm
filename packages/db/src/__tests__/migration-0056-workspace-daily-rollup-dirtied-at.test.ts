import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyMigrationFile, applyMigrationsUpTo, createEphemeralDatabase, dropEphemeralDatabase } from "@mega-crm/test-support";

/**
 * Phase 13 (CMP-03, D-14, plan 13-05, Task 3 [BLOCKING]): proves migration
 * 0056 is genuinely additive against real data.
 *
 * `npm run build`/`tsc` passing is NOT evidence the column exists -- Drizzle's
 * types come from the schema files, not from a live database (STATE.md
 * operational note, carried from Phase 12: `npm run db:migrate` hangs in this
 * dev sandbox under Node v26, so `test:migrations` is this project's real
 * schema-apply proof). This mirrors the Phase 11 precedent for an enum
 * migration ("verify workspace_daily_rollup totals are unchanged
 * afterwards") -- distinguishing "the column was added" from "the column was
 * added without disturbing the numbers this phase exists to protect".
 *
 * `workspace_daily_rollup` does not exist at the Phase 6/7 boundary
 * `migrate-incremental.test.ts` uses as its checkpoint (created in `0037`,
 * Phase 7) -- so this is a DEDICATED ephemeral-database test rather than an
 * extension of that file, mirroring `migration-0038-deadline-guard.test.ts`'s
 * precedent of a migration-specific suite. Picked up automatically by
 * `npm run test:migrations` (`vitest run --root packages/db`) with no
 * additional wiring. NOT in this plan's `files_modified` list -- a
 * deviation, documented in the plan's SUMMARY.
 */

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");
const CHECKPOINT = "0055_webhook_ingress_durability.sql";
const TARGET_MIGRATION = "0056_workspace_daily_rollup_dirtied_at.sql";

/**
 * `createEphemeralDatabase`'s own `adminDsn` points at the cluster's
 * maintenance database, not the ephemeral one -- swap only the pathname to
 * get a superuser connection into THIS database (mirrors
 * `ingress-journal-queries.test.ts`'s identical helper). `organization` is
 * INSERT-restricted to `mega_crm_auth` as of migration `0045` -- the
 * checkpoint here (`0055`) is well past that, so the ordinary
 * `mega_crm_app`-role `pool` this suite otherwise uses cannot seed it.
 */
function adminDsnForDatabase(adminDsn: string, databaseName: string): string {
  const url = new URL(adminDsn);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

/**
 * What `withTenant`/`withTenantTransaction` do, applied to THIS test's own
 * ephemeral pool. Mirrors `migrate-incremental.test.ts`'s identical helper
 * and its reasoning: `mega_crm_app`'s `workspace_isolation` policy (unified
 * fail-closed, bare-cast form since migration `0044`) throws on an unscoped
 * connection rather than returning zero rows, so every seed/read here must
 * run inside a `SET LOCAL app.current_workspace_id` transaction.
 */
async function withWorkspace<T>(pool: Pool, workspaceId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

interface RollupCounts {
  sentCount: number;
  deliveredCount: number;
  openedCount: number;
  clickedCount: number;
  bouncedCount: number;
  unsubscribedCount: number;
}

describe("migration 0056: workspace_daily_rollup.dirtied_at (CMP-03, D-14, plan 13-05, Task 3)", () => {
  // Two pools, deliberately -- same reason as migrate-incremental.test.ts:
  // `pool` runs DDL/organization inserts and is NEVER tenant-scoped;
  // `seedPool` does the tenant-scoped rollup seed/read. A pooled connection
  // recycled from a scoped transaction into unscoped DDL would carry a
  // stale non-null session-level GUC into the next (unscoped) statement.
  let pool: Pool;
  let seedPool: Pool;
  let adminPool: Pool;
  let databaseName: string;
  let adminDsn: string;
  let workspaceId: string;

  const DAY = "2026-01-15";
  const SEEDED_COUNTS: RollupCounts = {
    sentCount: 4,
    deliveredCount: 3,
    openedCount: 2,
    clickedCount: 1,
    bouncedCount: 1,
    unsubscribedCount: 1,
  };

  async function readRollupRow(): Promise<(RollupCounts & { dirtiedAt: Date | null }) | null> {
    return withWorkspace(seedPool, workspaceId, async (client) => {
      const { rows } = await client.query<RollupCounts & { dirtiedAt: Date | null }>(
        `SELECT sent_count as "sentCount", delivered_count as "deliveredCount",
                opened_count as "openedCount", clicked_count as "clickedCount",
                bounced_count as "bouncedCount", unsubscribed_count as "unsubscribedCount",
                dirtied_at as "dirtiedAt"
           FROM workspace_daily_rollup WHERE workspace_id = $1 AND day = $2`,
        [workspaceId, DAY]
      );
      return rows[0] ?? null;
    });
  }

  let countsBeforeMigration: RollupCounts | null;
  let rowAfterMigration: (RollupCounts & { dirtiedAt: Date | null }) | null;

  beforeAll(async () => {
    const created = await createEphemeralDatabase({ workspace: "migration-0056-dirtied-at" });
    databaseName = created.databaseName;
    adminDsn = created.adminDsn;
    pool = new Pool({ connectionString: created.dsn, max: 2 });
    seedPool = new Pool({ connectionString: created.dsn, max: 2 });
    adminPool = new Pool({ connectionString: adminDsnForDatabase(adminDsn, databaseName), max: 2 });

    // --- prior release: the chain through 0055, workspace_daily_rollup already exists (0037) ---
    await applyMigrationsUpTo(pool, MIGRATIONS_DIR, CHECKPOINT);

    const { rows: orgRows } = await adminPool.query<{ id: string }>(
      `INSERT INTO organization (name, slug) VALUES ($1, $2) RETURNING id`,
      ["Migration 0056 Co", `migration-0056-${Date.now()}`]
    );
    workspaceId = orgRows[0].id;

    // A real row with all six counts populated -- proves 0056 disturbs
    // NONE of them, not just the ones that happen to be zero.
    await withWorkspace(seedPool, workspaceId, (client) =>
      client.query(
        `INSERT INTO workspace_daily_rollup
           (workspace_id, day, sent_count, delivered_count, opened_count, clicked_count, bounced_count, unsubscribed_count)
         VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8)`,
        [
          workspaceId,
          DAY,
          SEEDED_COUNTS.sentCount,
          SEEDED_COUNTS.deliveredCount,
          SEEDED_COUNTS.openedCount,
          SEEDED_COUNTS.clickedCount,
          SEEDED_COUNTS.bouncedCount,
          SEEDED_COUNTS.unsubscribedCount,
        ]
      )
    );

    countsBeforeMigration = await withWorkspace(seedPool, workspaceId, async (client) => {
      const { rows } = await client.query<RollupCounts>(
        `SELECT sent_count as "sentCount", delivered_count as "deliveredCount",
                opened_count as "openedCount", clicked_count as "clickedCount",
                bounced_count as "bouncedCount", unsubscribed_count as "unsubscribedCount"
           FROM workspace_daily_rollup WHERE workspace_id = $1 AND day = $2`,
        [workspaceId, DAY]
      );
      return rows[0] ?? null;
    });

    // --- the release under test ---
    await applyMigrationFile(pool, MIGRATIONS_DIR, TARGET_MIGRATION);

    rowAfterMigration = await readRollupRow();
  });

  afterAll(async () => {
    await pool?.end();
    await seedPool?.end();
    await adminPool?.end();
    if (databaseName) await dropEphemeralDatabase(databaseName, adminDsn);
  });

  it("actually seeded the row before the migration -- RLS did not silently swallow the insert", () => {
    expect(countsBeforeMigration).toEqual(SEEDED_COUNTS);
  });

  it("leaves all six existing counts byte-identical after 0056 applies", () => {
    expect(rowAfterMigration).not.toBeNull();
    expect({
      sentCount: rowAfterMigration?.sentCount,
      deliveredCount: rowAfterMigration?.deliveredCount,
      openedCount: rowAfterMigration?.openedCount,
      clickedCount: rowAfterMigration?.clickedCount,
      bouncedCount: rowAfterMigration?.bouncedCount,
      unsubscribedCount: rowAfterMigration?.unsubscribedCount,
    }).toEqual(SEEDED_COUNTS);
  });

  it("leaves dirtied_at null on the pre-existing row -- no backfill", () => {
    expect(rowAfterMigration?.dirtiedAt).toBeNull();
  });

  it("adds a queryable dirtied_at column that a fresh write can set", async () => {
    await withWorkspace(seedPool, workspaceId, (client) =>
      client.query(`UPDATE workspace_daily_rollup SET dirtied_at = now() WHERE workspace_id = $1 AND day = $2`, [
        workspaceId,
        DAY,
      ])
    );
    const row = await readRollupRow();
    expect(row?.dirtiedAt).not.toBeNull();
  });
});
