import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { getScanTestDatabaseUrl } from "@mega-crm/test-support";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { insertFixtureOrganization } from "../../test/failure-fixtures.js";
import { findDueCampaignCandidates, transitionToSending } from "../campaign-scheduler.worker.js";

/**
 * Phase 10 (SEC-01/SEC-02, D-01/D-02) — campaign-scheduler's due-campaign
 * discovery now runs on the dedicated `mega_crm_scan` role via
 * `withCrossWorkspaceScan`, instead of setting the `app.admin_scan` session
 * flag on the tenant pool. This proves the consumer-side migration: given
 * due campaigns seeded in two workspaces, discovery returns both, and each
 * is then transitioned through the UNCHANGED per-tenant `withTenant`/
 * `withTenantTransaction` path (Test 6 from 10-01-PLAN.md's behavior list).
 */
describe("campaign-scheduler due-campaign scan (Phase 10 SEC-01/SEC-02)", () => {
  let pool: Pool;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    process.env.SCAN_DATABASE_URL = getScanTestDatabaseUrl();
    pool = createTestPool();
  });

  afterAll(async () => {
    await pool.end();
  });

  async function seedDueCampaign(nameSeed: string): Promise<{ workspaceId: string; campaignId: string }> {
    // 10-09 (SEC-05): delegates to the mega_crm_auth-backed INSERT in
    // failure-fixtures.ts -- mega_crm_app holds only SELECT on organization
    // post-migration-0045.
    const workspaceId = await insertFixtureOrganization(nameSeed);

    const campaignId = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows: segmentRows } = await client.query<{ id: string }>(
          `INSERT INTO segments (workspace_id, name, definition, created_by_user_id)
           VALUES ($1, 'Scheduler scan fixture segment', $2, 'test-user') RETURNING id`,
          [workspaceId, { operator: "and", conditions: [] }],
        );
        const { rows: campaignRows } = await client.query<{ id: string }>(
          `INSERT INTO campaigns (workspace_id, name, status, segment_id, scheduled_at, created_by_user_id)
           VALUES ($1, 'Scheduler scan fixture campaign', 'scheduled', $2, now() - interval '1 minute', 'test-user')
           RETURNING id`,
          [workspaceId, segmentRows[0].id],
        );
        return campaignRows[0].id;
      }),
    );

    return { workspaceId, campaignId };
  }

  async function campaignStatus(workspaceId: string, campaignId: string): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ status: string }>(
          `SELECT status FROM campaigns WHERE id = $1`,
          [campaignId],
        );
        return rows[0].status;
      }),
    );
  }

  it("discovers due campaigns across two workspaces and transitions each via the unchanged per-tenant path", async () => {
    const a = await seedDueCampaign("scheduler-scan-a");
    const b = await seedDueCampaign("scheduler-scan-b");

    const candidates = await findDueCampaignCandidates();
    const candidateIds = candidates.map((c) => c.id);
    expect(candidateIds).toContain(a.campaignId);
    expect(candidateIds).toContain(b.campaignId);

    const candidateA = candidates.find((c) => c.id === a.campaignId)!;
    const candidateB = candidates.find((c) => c.id === b.campaignId)!;
    expect(candidateA.workspaceId).toBe(a.workspaceId);
    expect(candidateB.workspaceId).toBe(b.workspaceId);

    const transitionedA = await transitionToSending(candidateA);
    const transitionedB = await transitionToSending(candidateB);
    expect(transitionedA).toBe(true);
    expect(transitionedB).toBe(true);

    expect(await campaignStatus(a.workspaceId, a.campaignId)).toBe("sending");
    expect(await campaignStatus(b.workspaceId, b.campaignId)).toBe("sending");
  });
});
