import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getScanTestDatabaseUrl } from "@mega-crm/test-support";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { seedDueCampaign, readDueCampaignState } from "../../test/failure-fixtures.js";
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

    expect((await readDueCampaignState(a.workspaceId, a.campaignId)).status).toBe("sending");
    expect((await readDueCampaignState(b.workspaceId, b.campaignId)).status).toBe("sending");
  });
});
