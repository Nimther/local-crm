import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyMigrationFile, createEphemeralDatabase, dropEphemeralDatabase, listMigrationFiles } from "@mega-crm/test-support";

/**
 * Phase 13 (CMP-09, migration 0058, plan 13-09 Task 2) -- the schema-level
 * constraints for `reputation_alert_state` (keyed, never singleton) and
 * `ingestion_alert_state` (singleton, dead-man's-switch seeded). No
 * application module exists yet for either table -- the reputation tick
 * worker (Task 3, apps/worker) and plan 13-11's watchdog are the future
 * callers -- so this suite exercises the raw constraints directly against
 * an ephemeral, fully migrated database.
 */

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

/**
 * `createEphemeralDatabase`'s own `adminDsn` points at the cluster's
 * maintenance database, not the ephemeral one -- swap only the pathname to
 * get a superuser connection into THIS database. `organization` is
 * INSERT/DELETE-restricted (migration 0045: mega_crm_app has only SELECT +
 * UPDATE) -- the ordinary app-role pool this suite otherwise uses cannot
 * seed or delete it.
 */
function adminDsnForDatabase(adminDsn: string, databaseName: string): string {
  const url = new URL(adminDsn);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

describe("reputation_alert_state / ingestion_alert_state (CMP-09, migration 0058)", () => {
  let pool: Pool;
  let adminPool: Pool;
  let databaseName: string;
  let adminDsn: string;

  beforeAll(async () => {
    const created = await createEphemeralDatabase({ workspace: "reputation-alert-state" });
    databaseName = created.databaseName;
    adminDsn = created.adminDsn;
    pool = new Pool({ connectionString: created.dsn, max: 5 });
    adminPool = new Pool({ connectionString: adminDsnForDatabase(created.adminDsn, databaseName), max: 2 });

    const files = listMigrationFiles(MIGRATIONS_DIR);
    for (const file of files) {
      await applyMigrationFile(pool, MIGRATIONS_DIR, file);
    }
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await adminPool?.end();
    if (databaseName) await dropEphemeralDatabase(databaseName, adminDsn);
  });

  async function freshWorkspaceId(nameSeed: string): Promise<string> {
    const { rows } = await adminPool.query<{ id: string }>(
      `INSERT INTO organization (name, slug) VALUES ($1, $2) RETURNING id`,
      [`${nameSeed} Co`, `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`],
    );
    return rows[0].id;
  }

  it("accepts two rows for the same workspace with different metrics", async () => {
    const workspaceId = await freshWorkspaceId("rep-two-metrics");
    await pool.query(
      `INSERT INTO reputation_alert_state (workspace_id, metric, observed_tier) VALUES ($1, 'complaint_rate', 'none')`,
      [workspaceId],
    );
    await pool.query(
      `INSERT INTO reputation_alert_state (workspace_id, metric, observed_tier) VALUES ($1, 'hard_bounce_rate', 'none')`,
      [workspaceId],
    );

    const { rows } = await pool.query(`SELECT metric FROM reputation_alert_state WHERE workspace_id = $1`, [
      workspaceId,
    ]);
    expect(rows.map((r) => r.metric).sort()).toEqual(["complaint_rate", "hard_bounce_rate"]);
  });

  it("rejects a second row for the same workspace and metric", async () => {
    const workspaceId = await freshWorkspaceId("rep-dup-metric");
    await pool.query(
      `INSERT INTO reputation_alert_state (workspace_id, metric, observed_tier) VALUES ($1, 'complaint_rate', 'none')`,
      [workspaceId],
    );

    await expect(
      pool.query(
        `INSERT INTO reputation_alert_state (workspace_id, metric, observed_tier) VALUES ($1, 'complaint_rate', 'warn')`,
        [workspaceId],
      ),
    ).rejects.toThrow(/duplicate key value violates unique constraint/);
  });

  it("accepts rows for two different workspaces with the same metric", async () => {
    const workspaceA = await freshWorkspaceId("rep-multi-a");
    const workspaceB = await freshWorkspaceId("rep-multi-b");

    await pool.query(
      `INSERT INTO reputation_alert_state (workspace_id, metric, observed_tier) VALUES ($1, 'complaint_rate', 'none')`,
      [workspaceA],
    );
    await pool.query(
      `INSERT INTO reputation_alert_state (workspace_id, metric, observed_tier) VALUES ($1, 'complaint_rate', 'critical')`,
      [workspaceB],
    );

    const { rows } = await pool.query(
      `SELECT workspace_id, observed_tier FROM reputation_alert_state WHERE workspace_id IN ($1, $2) ORDER BY workspace_id`,
      [workspaceA, workspaceB],
    );
    expect(rows).toHaveLength(2);
  });

  /**
   * A live `DELETE FROM organization` cannot be exercised in this suite:
   * migration 0045 (Phase 10) revoked ALL privileges from `mega_crm_app` on
   * `invitation`/`member` (re-granting only SELECT), and Postgres's FK
   * cascade-enforcement trigger for those tables runs under the
   * REFERENCING table's OWNER privileges regardless of which role issues
   * the top-level DELETE -- confirmed empirically: even a real cluster
   * superuser gets `permission denied for table invitation` cascading a
   * `DELETE FROM organization`, because `mega_crm_app` (invitation's owner)
   * itself no longer holds DELETE on it. This is a pre-existing, unrelated
   * limitation (organizations are hard-deletable by nothing in this
   * codebase today -- `workspaces.ts`'s delete route only ever sets
   * `deletedAt`, per migration 0045's own header comment) and is out of
   * scope for this plan to change. The cascade contract this table commits
   * to is therefore verified at the catalog level instead of via a live
   * delete.
   */
  it("reputation_alert_state's workspace_id foreign key specifies ON DELETE CASCADE against organization(id)", async () => {
    const { rows } = await pool.query<{ confdeltype: string; referenced_table: string }>(
      `SELECT confdeltype, confrelid::regclass::text AS referenced_table
         FROM pg_constraint
        WHERE conrelid = 'reputation_alert_state'::regclass
          AND contype = 'f'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].referenced_table).toBe("organization");
    // 'c' = CASCADE (see pg_constraint.confdeltype in the Postgres catalog docs).
    expect(rows[0].confdeltype).toBe("c");
  });

  it("observed_* and alerted_* columns are disjoint writers -- setting one leaves the other untouched", async () => {
    const workspaceId = await freshWorkspaceId("rep-disjoint");
    await pool.query(
      `INSERT INTO reputation_alert_state (workspace_id, metric, observed_tier, observed_rate, observed_numerator, observed_denominator)
       VALUES ($1, 'complaint_rate', 'critical', 0.003, 3, 1000)`,
      [workspaceId],
    );

    await pool.query(
      `UPDATE reputation_alert_state SET alerted_tier = 'critical', last_alert_sent_at = now() WHERE workspace_id = $1 AND metric = 'complaint_rate'`,
      [workspaceId],
    );

    const { rows } = await pool.query(
      `SELECT observed_tier, observed_numerator, observed_denominator, alerted_tier FROM reputation_alert_state WHERE workspace_id = $1 AND metric = 'complaint_rate'`,
      [workspaceId],
    );
    expect(rows[0].observed_tier).toBe("critical");
    expect(rows[0].observed_numerator).toBe(3);
    expect(rows[0].alerted_tier).toBe("critical");
  });

  it("ingestion_alert_state contains exactly one seeded row after the migration", async () => {
    const { rows } = await pool.query(`SELECT id FROM ingestion_alert_state`);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(1);
  });

  it("ingestion_alert_state rejects any row whose id is not 1", async () => {
    await expect(pool.query(`INSERT INTO ingestion_alert_state (id) VALUES (2)`)).rejects.toThrow(
      /violates check constraint/,
    );
  });

  it("neither reputation_alert_state nor ingestion_alert_state has Row-Level Security enabled", async () => {
    const { rows } = await pool.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname IN ('reputation_alert_state', 'ingestion_alert_state')
        ORDER BY c.relname`,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.relrowsecurity, `${row.relname} must not have RLS enabled`).toBe(false);
      expect(row.relforcerowsecurity, `${row.relname} must not have RLS forced`).toBe(false);
    }
  });
});
