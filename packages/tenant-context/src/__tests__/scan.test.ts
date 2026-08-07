import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureTestDbMigrated, getScanTestDatabaseUrl } from "@mega-crm/test-support";

import { closeScanPool, pool, withCrossWorkspaceScan, withTenant, withTenantTransaction } from "../index.js";

/**
 * Phase 10 (SEC-01/SEC-02, D-01/D-02) — the tracer slice for the whole
 * scan-role architecture: `mega_crm_scan`, `withCrossWorkspaceScan`,
 * migration 0041's role-scoped `campaigns_scan` policy, and the P2/P3
 * negative assertions that prove the role is least-privilege and the API
 * process cannot reach it.
 */
describe("cross-workspace scan role (Phase 10 SEC-01/SEC-02)", () => {
  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.SCAN_DATABASE_URL = getScanTestDatabaseUrl();
  });

  afterAll(async () => {
    await closeScanPool();
    await pool.end();
  });

  async function seedDueCampaign(nameSeed: string): Promise<{ workspaceId: string; campaignId: string }> {
    const slug = `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { rows: orgRows } = await pool.query<{ id: string }>(
      `INSERT INTO organization (name, slug) VALUES ($1, $2) RETURNING id`,
      [`${nameSeed} Co`, slug],
    );
    const workspaceId = orgRows[0].id;

    const campaignId = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows: segmentRows } = await client.query<{ id: string }>(
          `INSERT INTO segments (workspace_id, name, definition, created_by_user_id)
           VALUES ($1, 'Scan fixture segment', $2, 'test-user') RETURNING id`,
          [workspaceId, { operator: "and", conditions: [] }],
        );
        const { rows: campaignRows } = await client.query<{ id: string }>(
          `INSERT INTO campaigns (workspace_id, name, status, segment_id, scheduled_at, created_by_user_id)
           VALUES ($1, 'Scan fixture campaign', 'scheduled', $2, now() - interval '1 minute', 'test-user')
           RETURNING id`,
          [workspaceId, segmentRows[0].id],
        );
        return campaignRows[0].id;
      }),
    );

    return { workspaceId, campaignId };
  }

  it("Test 1: reads due campaigns from two DIFFERENT workspaces in a single scan-pool query", async () => {
    const a = await seedDueCampaign("scan-workspace-a");
    const b = await seedDueCampaign("scan-workspace-b");

    const rows = await withCrossWorkspaceScan((client) =>
      client
        .query<{ id: string; workspaceId: string }>(
          `SELECT id, workspace_id as "workspaceId" FROM campaigns
           WHERE status = 'scheduled' AND scheduled_at <= now() AND id = ANY($1::uuid[])`,
          [[a.campaignId, b.campaignId]],
        )
        .then((res) => res.rows),
    );

    const seenWorkspaceIds = rows.map((r) => r.workspaceId).sort();
    expect(seenWorkspaceIds).toEqual([a.workspaceId, b.workspaceId].sort());
  });

  it("Test 2: mega_crm_scan is a login role that cannot bypass RLS", async () => {
    const { rows } = await pool.query<{ rolcanlogin: boolean; rolbypassrls: boolean }>(
      `SELECT rolcanlogin, rolbypassrls FROM pg_roles WHERE rolname = 'mega_crm_scan'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].rolcanlogin).toBe(true);
    expect(rows[0].rolbypassrls).toBe(false);
  });

  it("Test 3: mega_crm_scan and mega_crm_auth own zero tables", async () => {
    const { rows } = await pool.query<{ rolname: string; relname: string }>(
      `SELECT r.rolname, c.relname
       FROM pg_class c
       JOIN pg_roles r ON r.oid = c.relowner
       WHERE r.rolname IN ('mega_crm_scan', 'mega_crm_auth')`,
    );
    expect(rows).toEqual([]);
  });

  it("Test 4: mega_crm_app is not a member of mega_crm_scan or mega_crm_auth (P3)", async () => {
    const { rows } = await pool.query<{ scanMember: boolean; authMember: boolean }>(
      `SELECT
         pg_has_role('mega_crm_app', 'mega_crm_scan', 'MEMBER') AS "scanMember",
         pg_has_role('mega_crm_app', 'mega_crm_auth', 'MEMBER') AS "authMember"`,
    );
    expect(rows[0].scanMember).toBe(false);
    expect(rows[0].authMember).toBe(false);
  });

  it("Test 5: a scan-pool query against a table with no grant/policy is refused outright, not silently empty", async () => {
    // Deviation from the plan's literal wording ("returns zero rows"):
    // verified live against Postgres 17 that a table with NO GRANT SELECT
    // for mega_crm_scan denies access at the privilege-check layer, before
    // RLS is even evaluated -- "permission denied", not an empty result set.
    // This is the STRONGER form of the same claim the plan's Test 5 makes
    // (visibility is grant/policy-driven, not blanket): mega_crm_scan gets
    // outright refused on `contacts`, which migration 0041 grants nothing
    // on, rather than falling through to an empty read.
    await expect(
      withCrossWorkspaceScan((client) => client.query(`SELECT id FROM contacts LIMIT 1`)),
    ).rejects.toThrow(/permission denied for table contacts/);
  });

  it("Test 7: withCrossWorkspaceScan rejects with a descriptive error when SCAN_DATABASE_URL is unset", async () => {
    const saved = process.env.SCAN_DATABASE_URL;
    delete process.env.SCAN_DATABASE_URL;
    try {
      await expect(withCrossWorkspaceScan((client) => client.query("SELECT 1"))).rejects.toThrow(
        /SCAN_DATABASE_URL is required/,
      );
    } finally {
      if (saved !== undefined) process.env.SCAN_DATABASE_URL = saved;
    }
  });
});
