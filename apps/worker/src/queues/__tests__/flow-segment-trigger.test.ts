import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import type { FlowDefinition } from "@mega-crm/flows-core";
import type { SegmentDefinition } from "@mega-crm/segments-core";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { processFlowRunAdvance } from "../flows/flow-run-advance.worker.js";
import { processFlowTriggerCheck } from "../flows/flow-trigger-evaluator.worker.js";
import { runFlowSegmentSweepTick } from "../flows/flow-segment-sweep.worker.js";
import { processFlowEnrollExisting } from "../flows/flow-enroll-existing.worker.js";
import { flowRunAdvanceQueue } from "../flows/flow-queues.js";

/**
 * 06-08's overall `<verification>`/`<test_plan>`: (1) the binary branch
 * handler routes yes/no via the SAME `isContactInSegment`-shaped point-check
 * `flow-run-advance.worker.ts` dispatches to (FLOW-03/D-12/D-13); (2) the
 * periodic bulk sweep enrolls a contact newly matching a segment-triggered
 * flow's trigger segment and records the membership snapshot, and does not
 * re-enroll an already-seen contact (D-02b, RESEARCH Pitfall 1's bulk-diff
 * shape); (3) the D-04 publish-time enroll-existing choice --
 * `enrollExisting=true` creates runs for current segment members,
 * `enrollExisting=false` only seeds the snapshot (no runs). Invoked directly
 * against real Postgres/Redis, mirroring flow-run-advance.test.ts/
 * flow-trigger-evaluator.test.ts's convention.
 */
describe("06-08: branch node + segment-entry trigger (sweep + enroll-existing)", () => {
  let pool: Pool;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    pool = createTestPool();
  });

  afterAll(async () => {
    await pool.end();
  });

  async function freshWorkspaceId(nameSeed: string): Promise<string> {
    const slug = `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO organization (name, slug) VALUES ($1, $2) RETURNING id`,
      [`${nameSeed} Co`, slug]
    );
    return rows[0].id;
  }

  async function createFixtureContact(workspaceId: string, properties: Record<string, unknown> = {}): Promise<string> {
    const email = `contact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@fixture.test`;
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO contacts (workspace_id, email, first_name, subscription_status, properties)
           VALUES ($1, $2, 'Fixture', 'subscribed', $3) RETURNING id`,
          [workspaceId, email, properties]
        );
        return rows[0].id;
      })
    );
  }

  /** A single-group, single-condition segment matching contacts whose custom `tier` property equals "vip". */
  const VIP_SEGMENT_DEFINITION: SegmentDefinition = {
    version: 1,
    groups: [
      {
        conditions: [{ type: "attribute", source: "custom", field: "tier", operator: "eq", value: "vip" }],
      },
    ],
  };

  async function createFixtureSegment(workspaceId: string, definition: SegmentDefinition): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO segments (workspace_id, name, definition, created_by_user_id)
           VALUES ($1, 'Fixture VIP segment', $2, 'test-user') RETURNING id`,
          [workspaceId, definition]
        );
        return rows[0].id;
      })
    );
  }

  interface FlowRunState {
    status: string;
    currentNodeId: string | null;
  }

  async function getFlowRunState(workspaceId: string, flowRunId: string): Promise<FlowRunState> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<FlowRunState>(
          `SELECT status, current_node_id as "currentNodeId" FROM flow_runs WHERE id = $1`,
          [flowRunId]
        );
        return rows[0];
      })
    );
  }

  async function getRunsForContact(workspaceId: string, flowId: string, contactId: string): Promise<{ id: string; status: string }[]> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string; status: string }>(
          `SELECT id, status FROM flow_runs WHERE workspace_id = $1 AND flow_id = $2 AND contact_id = $3`,
          [workspaceId, flowId, contactId]
        );
        return rows;
      })
    );
  }

  async function getSnapshotSeen(workspaceId: string, flowId: string, contactId: string): Promise<boolean> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query(
          `SELECT 1 FROM flow_segment_membership_snapshot WHERE workspace_id = $1 AND flow_id = $2 AND contact_id = $3`,
          [workspaceId, flowId, contactId]
        );
        return rows.length > 0;
      })
    );
  }

  // ---------------------------------------------------------------------
  // (1) Branch node: routes yes/no via segment membership (FLOW-03/D-12/D-13)
  // ---------------------------------------------------------------------

  async function seedBranchFlowRun(
    workspaceId: string,
    contactId: string,
    segmentId: string
  ): Promise<{ flowRunId: string; yesNodeId: string; noNodeId: string }> {
    const branchNodeId = "branch-1";
    const yesNodeId = "exit-yes";
    const noNodeId = "exit-no";

    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows: flowRows } = await client.query<{ id: string }>(
          `INSERT INTO flows (workspace_id, name, status, trigger_type, trigger_event_name, created_by_user_id)
           VALUES ($1, 'Fixture branch flow', 'live', 'event', 'fixture_event', 'test-user')
           RETURNING id`,
          [workspaceId]
        );
        const flowId = flowRows[0].id;

        const definition: FlowDefinition = {
          nodes: [
            { id: "trigger-1", type: "trigger", triggerType: "event", eventName: "fixture_event", position: { x: 0, y: 0 } },
            { id: branchNodeId, type: "branch", segmentId, position: { x: 0, y: 100 } },
            { id: yesNodeId, type: "exit", position: { x: -100, y: 200 } },
            { id: noNodeId, type: "exit", position: { x: 100, y: 200 } },
          ],
          edges: [
            { id: "e1", source: "trigger-1", target: branchNodeId },
            { id: "e2", source: branchNodeId, target: yesNodeId, sourceHandle: "yes" },
            { id: "e3", source: branchNodeId, target: noNodeId, sourceHandle: "no" },
          ],
        };

        const { rows: versionRows } = await client.query<{ id: string }>(
          `INSERT INTO flow_versions (workspace_id, flow_id, version_number, definition, published_at)
           VALUES ($1, $2, 1, $3, now())
           RETURNING id`,
          [workspaceId, flowId, definition]
        );
        const flowVersionId = versionRows[0].id;
        await client.query(`UPDATE flows SET live_version_id = $2 WHERE id = $1`, [flowId, flowVersionId]);

        const { rows: runRows } = await client.query<{ id: string }>(
          `INSERT INTO flow_runs
             (workspace_id, flow_id, flow_version_id, contact_id, status, current_node_id, next_wake_at, entered_at)
           VALUES ($1, $2, $3, $4, 'waiting', $5, $6, now())
           RETURNING id`,
          [workspaceId, flowId, flowVersionId, contactId, branchNodeId, new Date(Date.now() - 60_000)]
        );

        return { flowRunId: runRows[0].id, yesNodeId, noNodeId };
      })
    );
  }

  it("a branch routes the 'yes' edge for a contact currently in the segment", async () => {
    const workspaceId = await freshWorkspaceId("flow-branch-yes");
    const segmentId = await createFixtureSegment(workspaceId, VIP_SEGMENT_DEFINITION);
    const contactId = await createFixtureContact(workspaceId, { tier: "vip" });
    const { flowRunId, yesNodeId } = await seedBranchFlowRun(workspaceId, contactId, segmentId);

    await processFlowRunAdvance({ workspaceId, flowRunId });

    const state = await getFlowRunState(workspaceId, flowRunId);
    expect(state.currentNodeId).toBe(yesNodeId);
  });

  it("a branch routes the 'no' edge for a contact NOT currently in the segment", async () => {
    const workspaceId = await freshWorkspaceId("flow-branch-no");
    const segmentId = await createFixtureSegment(workspaceId, VIP_SEGMENT_DEFINITION);
    const contactId = await createFixtureContact(workspaceId, { tier: "regular" });
    const { flowRunId, noNodeId } = await seedBranchFlowRun(workspaceId, contactId, segmentId);

    await processFlowRunAdvance({ workspaceId, flowRunId });

    const state = await getFlowRunState(workspaceId, flowRunId);
    expect(state.currentNodeId).toBe(noNodeId);
  });

  // ---------------------------------------------------------------------
  // (2) Periodic bulk sweep: enrolls newly-matching contacts, diffed against
  // the snapshot (D-02b, RESEARCH Pitfall 1)
  // ---------------------------------------------------------------------

  async function seedLiveSegmentFlow(
    workspaceId: string,
    segmentId: string,
    opts: { reentryMode?: string } = {}
  ): Promise<{ flowId: string }> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const definition: FlowDefinition = {
          nodes: [
            { id: "trigger-1", type: "trigger", triggerType: "segment", segmentId, position: { x: 0, y: 0 } },
            {
              id: "send-1",
              type: "send",
              templateId: "d-fixture-template",
              fromEmail: "sender@fixture.test",
              position: { x: 0, y: 100 },
            },
            { id: "exit-1", type: "exit", position: { x: 0, y: 200 } },
          ],
          edges: [
            { id: "e1", source: "trigger-1", target: "send-1" },
            { id: "e2", source: "send-1", target: "exit-1" },
          ],
        };

        const { rows: flowRows } = await client.query<{ id: string }>(
          `INSERT INTO flows (workspace_id, name, status, trigger_type, trigger_segment_id, reentry_mode, created_by_user_id)
           VALUES ($1, 'Fixture segment flow', 'live', 'segment', $2, $3, 'test-user')
           RETURNING id`,
          [workspaceId, segmentId, opts.reentryMode ?? "every_time"]
        );
        const flowId = flowRows[0].id;

        const { rows: versionRows } = await client.query<{ id: string }>(
          `INSERT INTO flow_versions (workspace_id, flow_id, version_number, definition, published_at)
           VALUES ($1, $2, 1, $3, now())
           RETURNING id`,
          [workspaceId, flowId, definition]
        );
        await client.query(`UPDATE flows SET live_version_id = $2 WHERE id = $1`, [flowId, versionRows[0].id]);

        return { flowId };
      })
    );
  }

  it("the sweep enrolls a contact newly matching the trigger segment and records the snapshot", async () => {
    const workspaceId = await freshWorkspaceId("flow-sweep-new");
    const segmentId = await createFixtureSegment(workspaceId, VIP_SEGMENT_DEFINITION);
    const { flowId } = await seedLiveSegmentFlow(workspaceId, segmentId);
    const contactId = await createFixtureContact(workspaceId, { tier: "vip" });

    await runFlowSegmentSweepTick();

    const runs = await getRunsForContact(workspaceId, flowId, contactId);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("waiting");
    expect(await getSnapshotSeen(workspaceId, flowId, contactId)).toBe(true);

    const advanceJob = await flowRunAdvanceQueue.getJob(runs[0].id);
    expect(advanceJob).toBeDefined();
  });

  it("the sweep does NOT re-enroll a contact already recorded in the membership snapshot", async () => {
    const workspaceId = await freshWorkspaceId("flow-sweep-already-seen");
    const segmentId = await createFixtureSegment(workspaceId, VIP_SEGMENT_DEFINITION);
    const { flowId } = await seedLiveSegmentFlow(workspaceId, segmentId);
    const contactId = await createFixtureContact(workspaceId, { tier: "vip" });

    await runFlowSegmentSweepTick();
    const firstPassRuns = await getRunsForContact(workspaceId, flowId, contactId);
    expect(firstPassRuns).toHaveLength(1);

    // A second sweep tick with the SAME still-matching contact must not
    // create a second run -- the snapshot row from the first pass excludes
    // it from the bulk diff.
    await runFlowSegmentSweepTick();
    const secondPassRuns = await getRunsForContact(workspaceId, flowId, contactId);
    expect(secondPassRuns).toHaveLength(1);
  });

  it("D-02a: the event-driven flow-trigger-check job also enrolls a contact newly matching a segment-triggered flow", async () => {
    const workspaceId = await freshWorkspaceId("flow-segment-event-recheck");
    const segmentId = await createFixtureSegment(workspaceId, VIP_SEGMENT_DEFINITION);
    const { flowId } = await seedLiveSegmentFlow(workspaceId, segmentId);
    const contactId = await createFixtureContact(workspaceId, { tier: "vip" });

    // No event-triggered flow matches "unrelated_event" -- this job's ONLY
    // effect should be the segment-entry re-check that runs on every
    // flow-trigger-check job regardless of eventName (D-02a).
    await processFlowTriggerCheck({ workspaceId, contactId, eventName: "unrelated_event" });

    const runs = await getRunsForContact(workspaceId, flowId, contactId);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("waiting");
    expect(await getSnapshotSeen(workspaceId, flowId, contactId)).toBe(true);
  });

  // ---------------------------------------------------------------------
  // (3) D-04 enroll-existing on publish: true creates runs for current
  // members, false only seeds the snapshot (no runs)
  // ---------------------------------------------------------------------

  it("enrollExisting=true creates a run for every current segment member", async () => {
    const workspaceId = await freshWorkspaceId("flow-enroll-true");
    const segmentId = await createFixtureSegment(workspaceId, VIP_SEGMENT_DEFINITION);
    const { flowId } = await seedLiveSegmentFlow(workspaceId, segmentId);
    const memberA = await createFixtureContact(workspaceId, { tier: "vip" });
    const memberB = await createFixtureContact(workspaceId, { tier: "vip" });
    const nonMember = await createFixtureContact(workspaceId, { tier: "regular" });

    const flowVersionId = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ liveVersionId: string }>(
          `SELECT live_version_id as "liveVersionId" FROM flows WHERE id = $1`,
          [flowId]
        );
        return rows[0].liveVersionId;
      })
    );

    await processFlowEnrollExisting({ workspaceId, flowId, flowVersionId, enrollExisting: true });

    expect(await getRunsForContact(workspaceId, flowId, memberA)).toHaveLength(1);
    expect(await getRunsForContact(workspaceId, flowId, memberB)).toHaveLength(1);
    expect(await getRunsForContact(workspaceId, flowId, nonMember)).toHaveLength(0);
    expect(await getSnapshotSeen(workspaceId, flowId, memberA)).toBe(true);
    expect(await getSnapshotSeen(workspaceId, flowId, memberB)).toBe(true);
  });

  it("enrollExisting=false only seeds the snapshot -- no runs are created for current members", async () => {
    const workspaceId = await freshWorkspaceId("flow-enroll-false");
    const segmentId = await createFixtureSegment(workspaceId, VIP_SEGMENT_DEFINITION);
    const { flowId } = await seedLiveSegmentFlow(workspaceId, segmentId);
    const memberA = await createFixtureContact(workspaceId, { tier: "vip" });

    const flowVersionId = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ liveVersionId: string }>(
          `SELECT live_version_id as "liveVersionId" FROM flows WHERE id = $1`,
          [flowId]
        );
        return rows[0].liveVersionId;
      })
    );

    await processFlowEnrollExisting({ workspaceId, flowId, flowVersionId, enrollExisting: false });

    expect(await getRunsForContact(workspaceId, flowId, memberA)).toHaveLength(0);
    expect(await getSnapshotSeen(workspaceId, flowId, memberA)).toBe(true);

    // A future sweep tick must not enroll this contact either -- the seed
    // already marked it "seen".
    await runFlowSegmentSweepTick();
    expect(await getRunsForContact(workspaceId, flowId, memberA)).toHaveLength(0);
  });
});
