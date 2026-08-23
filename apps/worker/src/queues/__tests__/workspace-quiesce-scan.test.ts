import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { getAuthTestDatabaseUrl, getScanTestDatabaseUrl } from "@mega-crm/test-support";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { insertFixtureOrganization } from "../../test/failure-fixtures.js";
import { findDueCampaignCandidates } from "../campaign-scheduler.worker.js";
import { findLiveSegmentTriggeredFlows } from "../flows/flow-segment-sweep.worker.js";
import { findDueFlowRunCandidates, transitionAndNudge } from "../flows/flow-reconciliation.worker.js";
import { processFlowRunAdvance } from "../flows/flow-run-advance.worker.js";
import { findLiveWorkspaceIds, reconcileWorkspace, RECONCILE_WINDOW_DAYS } from "../analytics-reconciliation.worker.js";

/**
 * Phase 22 (PRG-06, SC1, D-01, D-02, plan 22-04): migration 0070 re-creates
 * `campaigns_scan`, `flows_scan` and `flow_runs_scan` with an added
 * soft-delete exclusion predicate -- this suite proves the discovery-side
 * half of D-01 directly against real Postgres/RLS, as the real
 * `mega_crm_scan` role, exactly the way `campaign-scheduler-scan.test.ts`
 * and `negative-cross-tenant-jobs.test.ts`'s own scan-consumer describes
 * already prove their respective policies. `organization` carries no RLS of
 * its own -- the soft-delete UPDATE below runs on the mega_crm_auth-backed
 * pool, mirroring `workspace-quiesce-ingest.test.ts`'s own precedent.
 *
 * Task 2 extends this file with the `analytics-reconciliation` enumeration
 * narrowing (RESEARCH Open Question 3) -- a WHERE-clause change, not an RLS
 * policy, but the same soft-delete-exclusion shape and the same "does the
 * live workspace still get processed" negative-control discipline.
 */
describe("workspace quiesce -- scan-policy soft-delete exclusion (PRG-06, SC1, D-01, D-02)", () => {
  let pool: Pool;
  let authPool: Pool;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    process.env.SCAN_DATABASE_URL = getScanTestDatabaseUrl();
    pool = createTestPool();
    authPool = new Pool({ connectionString: getAuthTestDatabaseUrl() });
  });

  afterAll(async () => {
    await pool.end();
    await authPool.end();
  });

  async function softDeleteWorkspace(workspaceId: string): Promise<void> {
    await authPool.query(`UPDATE organization SET "deletedAt" = now() WHERE id = $1`, [workspaceId]);
  }

  async function restoreWorkspace(workspaceId: string): Promise<void> {
    await authPool.query(`UPDATE organization SET "deletedAt" = NULL WHERE id = $1`, [workspaceId]);
  }

  async function purgeTombstone(workspaceId: string): Promise<void> {
    await authPool.query(`UPDATE organization SET "purgedAt" = now() WHERE id = $1`, [workspaceId]);
  }

  async function seedDueCampaign(nameSeed: string): Promise<{ workspaceId: string; campaignId: string }> {
    const workspaceId = await insertFixtureOrganization(nameSeed);
    const campaignId = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows: segmentRows } = await client.query<{ id: string }>(
          `INSERT INTO segments (workspace_id, name, definition, created_by_user_id)
           VALUES ($1, 'Quiesce scan fixture segment', $2, 'test-user') RETURNING id`,
          [workspaceId, { operator: "and", conditions: [] }]
        );
        const { rows: campaignRows } = await client.query<{ id: string }>(
          `INSERT INTO campaigns (workspace_id, name, status, segment_id, scheduled_at, created_by_user_id)
           VALUES ($1, 'Quiesce scan fixture campaign', 'scheduled', $2, now() - interval '1 minute', 'test-user')
           RETURNING id`,
          [workspaceId, segmentRows[0].id]
        );
        return campaignRows[0].id;
      })
    );
    return { workspaceId, campaignId };
  }

  async function seedLiveSegmentFlow(nameSeed: string): Promise<{ workspaceId: string; flowId: string }> {
    const workspaceId = await insertFixtureOrganization(nameSeed);
    const flowId = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows: segmentRows } = await client.query<{ id: string }>(
          `INSERT INTO segments (workspace_id, name, definition, created_by_user_id)
           VALUES ($1, 'Quiesce scan fixture segment', $2, 'test-user') RETURNING id`,
          [workspaceId, { operator: "and", conditions: [] }]
        );
        const { rows: flowRows } = await client.query<{ id: string }>(
          `INSERT INTO flows (workspace_id, name, status, trigger_type, trigger_segment_id, created_by_user_id)
           VALUES ($1, 'Quiesce scan fixture flow', 'live', 'segment', $2, 'test-user')
           RETURNING id`,
          [workspaceId, segmentRows[0].id]
        );
        const flowId = flowRows[0].id;
        const definition = { nodes: [{ id: "exit-1", type: "exit", position: { x: 0, y: 0 } }], edges: [] };
        const { rows: versionRows } = await client.query<{ id: string }>(
          `INSERT INTO flow_versions (workspace_id, flow_id, version_number, definition, published_at)
           VALUES ($1, $2, 1, $3, now()) RETURNING id`,
          [workspaceId, flowId, definition]
        );
        await client.query(`UPDATE flows SET live_version_id = $2 WHERE id = $1`, [flowId, versionRows[0].id]);
        return flowId;
      })
    );
    return { workspaceId, flowId };
  }

  async function createFixtureContact(workspaceId: string): Promise<string> {
    const email = `contact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@fixture.test`;
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO contacts (workspace_id, email, first_name, subscription_status)
           VALUES ($1, $2, 'Fixture', 'subscribed') RETURNING id`,
          [workspaceId, email]
        );
        return rows[0].id;
      })
    );
  }

  /**
   * A waiting flow_run whose current_node_id already points at an `exit`
   * node (mirrors `negative-cross-tenant-jobs.test.ts`'s identical
   * `seedWaitingFlowRun` fixture): `processFlowRunAdvance` on a live
   * workspace's such a run resolves in one step, via `handleExitNode`,
   * requiring no SendGrid/template configuration -- the minimal shape that
   * still proves genuine forward progress (`status`/`exited_at` change).
   */
  async function seedWaitingFlowRun(workspaceId: string, nextWakeAt: Date): Promise<{ flowRunId: string }> {
    const contactId = await createFixtureContact(workspaceId);
    const flowRunId = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows: flowRows } = await client.query<{ id: string }>(
          `INSERT INTO flows (workspace_id, name, status, trigger_type, trigger_event_name, created_by_user_id)
           VALUES ($1, 'Quiesce scan reconciliation flow', 'live', 'event', 'fixture_event', 'test-user')
           RETURNING id`,
          [workspaceId]
        );
        const { rows: versionRows } = await client.query<{ id: string }>(
          `INSERT INTO flow_versions (workspace_id, flow_id, version_number, definition, published_at)
           VALUES ($1, $2, 1, $3, now()) RETURNING id`,
          [
            workspaceId,
            flowRows[0].id,
            { nodes: [{ id: "exit-1", type: "exit", position: { x: 0, y: 0 } }], edges: [] },
          ]
        );
        const { rows: runRows } = await client.query<{ id: string }>(
          `INSERT INTO flow_runs (workspace_id, flow_id, flow_version_id, contact_id, status, current_node_id, next_wake_at)
           VALUES ($1, $2, $3, $4, 'waiting', 'exit-1', $5) RETURNING id`,
          [workspaceId, flowRows[0].id, versionRows[0].id, contactId, nextWakeAt]
        );
        return runRows[0].id;
      })
    );
    return { flowRunId };
  }

  interface FlowRunState {
    status: string;
    currentNodeId: string | null;
    exitedAt: Date | null;
    nextWakeAt: Date | null;
  }

  async function readFlowRunState(workspaceId: string, flowRunId: string): Promise<FlowRunState> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<FlowRunState>(
          `SELECT status, current_node_id as "currentNodeId", exited_at as "exitedAt", next_wake_at as "nextWakeAt"
           FROM flow_runs WHERE id = $1`,
          [flowRunId]
        );
        return rows[0];
      })
    );
  }

  it("campaigns_scan excludes deleted", async () => {
    const deleted = await seedDueCampaign("scan-campaigns-deleted");
    const live = await seedDueCampaign("scan-campaigns-live");
    await softDeleteWorkspace(deleted.workspaceId);

    const candidateIds = (await findDueCampaignCandidates()).map((c) => c.id);
    expect(candidateIds).toContain(live.campaignId);
    expect(candidateIds).not.toContain(deleted.campaignId);
  });

  it("flows_scan excludes deleted", async () => {
    const deleted = await seedLiveSegmentFlow("scan-flows-deleted");
    const live = await seedLiveSegmentFlow("scan-flows-live");
    await softDeleteWorkspace(deleted.workspaceId);

    const candidateIds = (await findLiveSegmentTriggeredFlows()).map((f) => f.id);
    expect(candidateIds).toContain(live.flowId);
    expect(candidateIds).not.toContain(deleted.flowId);
  });

  it("flow_runs_scan excludes deleted", async () => {
    const past = new Date(Date.now() - 60_000);
    const deletedWorkspaceId = await insertFixtureOrganization("scan-flow-runs-deleted");
    const liveWorkspaceId = await insertFixtureOrganization("scan-flow-runs-live");
    const deleted = await seedWaitingFlowRun(deletedWorkspaceId, past);
    const live = await seedWaitingFlowRun(liveWorkspaceId, past);
    await softDeleteWorkspace(deletedWorkspaceId);

    const candidateIds = (await findDueFlowRunCandidates()).map((r) => r.id);
    expect(candidateIds).toContain(live.flowRunId);
    expect(candidateIds).not.toContain(deleted.flowRunId);
  });

  it("deleted workspace's flow run does not advance across a full reconciliation tick, while the live workspace's does (D-02 freeze guarantee)", async () => {
    const past = new Date(Date.now() - 60_000);
    const deletedWorkspaceId = await insertFixtureOrganization("scan-freeze-deleted");
    const liveWorkspaceId = await insertFixtureOrganization("scan-freeze-live");
    const deleted = await seedWaitingFlowRun(deletedWorkspaceId, past);
    const live = await seedWaitingFlowRun(liveWorkspaceId, past);
    await softDeleteWorkspace(deletedWorkspaceId);

    const before = await readFlowRunState(deletedWorkspaceId, deleted.flowRunId);
    expect(before.status).toBe("waiting");
    expect(before.exitedAt).toBeNull();

    // A full reconciliation tick, driven directly (mirrors
    // negative-cross-tenant-jobs.test.ts's own convention): discover, then
    // per-tenant re-verify, then advance -- no live BullMQ worker needed.
    // deleted's flow_run is never returned by findDueFlowRunCandidates
    // (asserted separately above), so it can never reach transitionAndNudge
    // or processFlowRunAdvance -- nothing in this loop ever touches it.
    const dueRuns = await findDueFlowRunCandidates();
    for (const row of dueRuns) {
      const stillDue = await transitionAndNudge(row);
      if (!stillDue) continue;
      if (row.workspaceId !== deletedWorkspaceId && row.workspaceId !== liveWorkspaceId) continue;
      await processFlowRunAdvance({ workspaceId: row.workspaceId, flowRunId: row.id });
    }

    const after = await readFlowRunState(deletedWorkspaceId, deleted.flowRunId);
    expect(after).toEqual(before);

    const liveAfter = await readFlowRunState(liveWorkspaceId, live.flowRunId);
    expect(liveAfter.status).toBe("completed");
    expect(liveAfter.exitedAt).not.toBeNull();
  });

  it("restoring re-admits: clearing deletedAt makes all three policies visible again", async () => {
    const past = new Date(Date.now() - 60_000);
    const campaign = await seedDueCampaign("scan-restore-campaign");
    const flow = await seedLiveSegmentFlow("scan-restore-flow");
    const flowRunWorkspaceId = await insertFixtureOrganization("scan-restore-flow-run");
    const flowRun = await seedWaitingFlowRun(flowRunWorkspaceId, past);

    await softDeleteWorkspace(campaign.workspaceId);
    await softDeleteWorkspace(flow.workspaceId);
    await softDeleteWorkspace(flowRunWorkspaceId);

    expect((await findDueCampaignCandidates()).map((c) => c.id)).not.toContain(campaign.campaignId);
    expect((await findLiveSegmentTriggeredFlows()).map((f) => f.id)).not.toContain(flow.flowId);
    expect((await findDueFlowRunCandidates()).map((r) => r.id)).not.toContain(flowRun.flowRunId);

    await restoreWorkspace(campaign.workspaceId);
    await restoreWorkspace(flow.workspaceId);
    await restoreWorkspace(flowRunWorkspaceId);

    expect((await findDueCampaignCandidates()).map((c) => c.id)).toContain(campaign.campaignId);
    expect((await findLiveSegmentTriggeredFlows()).map((f) => f.id)).toContain(flow.flowId);
    expect((await findDueFlowRunCandidates()).map((r) => r.id)).toContain(flowRun.flowRunId);
  });

  // ---------------------------------------------------------------------
  // Task 2: analytics-reconciliation enumeration narrowing (RESEARCH Open
  // Question 3) -- a WHERE-clause change on `SELECT id FROM organization`,
  // not an RLS policy, but proven with the same soft-delete-exclusion shape.
  // ---------------------------------------------------------------------

  async function seedRollupRow(workspaceId: string, day: string, updatedAt: Date): Promise<void> {
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(
          `INSERT INTO workspace_daily_rollup (workspace_id, day, updated_at) VALUES ($1, $2::date, $3)`,
          [workspaceId, day, updatedAt]
        )
      )
    );
  }

  interface RollupRow {
    sentCount: number;
    updatedAt: Date;
    dirtiedAt: Date | null;
  }

  async function readRollupRow(workspaceId: string, day: string): Promise<RollupRow> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<RollupRow>(
          `SELECT sent_count as "sentCount", updated_at as "updatedAt", dirtied_at as "dirtiedAt"
           FROM workspace_daily_rollup WHERE workspace_id = $1 AND day = $2::date`,
          [workspaceId, day]
        );
        return rows[0];
      })
    );
  }

  /** UTC "today" as `YYYY-MM-DD`, inside `reconcileWorkspace`'s own standing window. */
  function todayUtc(): string {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString().slice(0, 10);
  }

  it("analytics reconciliation skips deleted workspaces", async () => {
    const day = todayUtc();
    const stale = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const deletedWorkspaceId = await insertFixtureOrganization("scan-analytics-deleted");
    const liveWorkspaceId = await insertFixtureOrganization("scan-analytics-live");
    await seedRollupRow(deletedWorkspaceId, day, stale);
    await seedRollupRow(liveWorkspaceId, day, stale);
    await softDeleteWorkspace(deletedWorkspaceId);

    const before = await readRollupRow(deletedWorkspaceId, day);

    const liveIds = new Set((await findLiveWorkspaceIds()).map((r) => r.id));
    expect(liveIds.has(deletedWorkspaceId)).toBe(false);
    expect(liveIds.has(liveWorkspaceId)).toBe(true);

    // Mirrors the worker's own tick body exactly (findLiveWorkspaceIds ->
    // reconcileWorkspace per row), scoped to just the two ids this test
    // seeded -- deletedWorkspaceId is excluded from `liveIds` (asserted
    // above), so the real processor's loop would never call
    // reconcileWorkspace for it either.
    for (const id of [deletedWorkspaceId, liveWorkspaceId]) {
      if (liveIds.has(id)) await reconcileWorkspace(id, RECONCILE_WINDOW_DAYS);
    }

    const after = await readRollupRow(deletedWorkspaceId, day);
    expect(after).toEqual(before);

    const liveAfter = await readRollupRow(liveWorkspaceId, day);
    expect(new Date(liveAfter.updatedAt).getTime()).toBeGreaterThan(stale.getTime());
  });

  it("purged workspaces stay skipped: deletedAt is never cleared by the purge, so the same filter covers both states", async () => {
    const day = todayUtc();
    const stale = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const workspaceId = await insertFixtureOrganization("scan-analytics-purged");
    await seedRollupRow(workspaceId, day, stale);
    await softDeleteWorkspace(workspaceId);
    await purgeTombstone(workspaceId);

    const before = await readRollupRow(workspaceId, day);

    const liveIds = new Set((await findLiveWorkspaceIds()).map((r) => r.id));
    expect(liveIds.has(workspaceId)).toBe(false);
    if (liveIds.has(workspaceId)) await reconcileWorkspace(workspaceId, RECONCILE_WINDOW_DAYS);

    const after = await readRollupRow(workspaceId, day);
    expect(after).toEqual(before);
  });
});
