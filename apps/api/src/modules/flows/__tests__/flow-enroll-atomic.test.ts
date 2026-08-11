import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
// 10-09 (SEC-05): seeding an organization row directly for test setup is not
// a live application query site -- as of migration 0045 it needs the
// mega_crm_auth-backed client, not the app-role `db`.
import { authDb as sharedDb, organization } from "@mega-crm/db";
import type { SegmentDefinition } from "@mega-crm/segments-core";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";
import { withTenant, withTenantTransaction } from "../../../middleware/tenant-context.js";
import { pool } from "../../../db.js";
import { createFlow, publishFlow, updateFlowDraft } from "../flow.repository.js";

/**
 * 06-18/CR-02 regression: publishing a segment-triggered flow with
 * enrollExisting=false must seed `flow_segment_membership_snapshot` for
 * every CURRENT segment member ATOMICALLY inside publishFlow's own
 * transaction -- by the time publishFlow returns (no worker running, no
 * BullMQ job processed), the snapshot must already be fully populated and
 * zero flow_runs rows must exist. Under the pre-fix code the seed only
 * happens in a separate async BullMQ job (flow-enroll-existing.worker.ts),
 * which this test never runs -- so the snapshot stays empty and the "3
 * seeded rows" assertion below fails (RED) until publishFlow itself performs
 * the seed synchronously (GREEN).
 */
describe("06-18/CR-02: publishFlow enrollExisting=false atomic seed", () => {
  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    pool.on("error", () => {
      // Expected under some teardown orderings; mirrors rls-pooling-chaos.test.ts's guard.
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  const VIP_SEGMENT_DEFINITION: SegmentDefinition = {
    version: 1,
    groups: [
      {
        conditions: [{ type: "attribute", source: "custom", field: "tier", operator: "eq", value: "vip" }],
      },
    ],
  };

  it("06-18/CR-02: publishing a segment-triggered flow with enrollExisting=false seeds the snapshot atomically (zero runs, all members seen, synchronously)", async () => {
    const slug = `flow-enroll-atomic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const [org] = await sharedDb
      .insert(organization)
      .values({ id: randomUUID(), name: "Flow Enroll Atomic Co", slug, createdAt: new Date() })
      .returning();
    const workspaceId = org.id;

    const { segmentId, nonMatchingContactId } = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows: segRows } = await client.query<{ id: string }>(
          `INSERT INTO segments (workspace_id, name, definition, created_by_user_id)
           VALUES ($1, 'Fixture VIP segment', $2, 'test-user') RETURNING id`,
          [workspaceId, VIP_SEGMENT_DEFINITION]
        );
        const segmentId = segRows[0].id;

        for (let i = 0; i < 3; i++) {
          await client.query(
            `INSERT INTO contacts (workspace_id, email, first_name, subscription_status, properties)
             VALUES ($1, $2, 'Fixture', 'subscribed', $3)`,
            [workspaceId, `vip-${i}-${randomUUID()}@fixture.test`, { tier: "vip" }]
          );
        }

        const { rows: nonMatchingRows } = await client.query<{ id: string }>(
          `INSERT INTO contacts (workspace_id, email, first_name, subscription_status, properties)
           VALUES ($1, $2, 'Fixture', 'subscribed', $3) RETURNING id`,
          [workspaceId, `regular-${randomUUID()}@fixture.test`, { tier: "regular" }]
        );

        return { segmentId, nonMatchingContactId: nonMatchingRows[0].id };
      })
    );

    const flow = await withTenant(workspaceId, () =>
      createFlow({ name: "Segment atomic seed test", createdByUserId: "test-user" })
    );

    await withTenant(workspaceId, () =>
      updateFlowDraft(flow.id, {
        definition: {
          nodes: [
            { id: "t1", type: "trigger", triggerType: "segment", segmentId, position: { x: 0, y: 0 } },
            {
              id: "s1",
              type: "send",
              templateId: "d-1",
              fromEmail: "marketing@example.com",
              position: { x: 100, y: 0 },
            },
            { id: "x1", type: "exit", position: { x: 200, y: 0 } },
          ],
          edges: [
            { id: "e1", source: "t1", target: "s1" },
            { id: "e2", source: "s1", target: "x1" },
          ],
        },
      })
    );

    // 06-18/CR-02: publish with the explicit "only new entrants" choice.
    // No BullMQ worker runs in this test -- the seed must have already
    // happened, synchronously, inside publishFlow's own transaction.
    await withTenant(workspaceId, () => publishFlow(flow.id, { enrollExisting: false }));

    const { snapshotCount, runCount, nonMatchingSeen } = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows: snapRows } = await client.query<{ count: string }>(
          `SELECT count(*) FROM flow_segment_membership_snapshot WHERE workspace_id = $1 AND flow_id = $2`,
          [workspaceId, flow.id]
        );
        const { rows: runRows } = await client.query<{ count: string }>(
          `SELECT count(*) FROM flow_runs WHERE workspace_id = $1 AND flow_id = $2`,
          [workspaceId, flow.id]
        );
        const { rows: nonMatchRows } = await client.query<{ count: string }>(
          `SELECT count(*) FROM flow_segment_membership_snapshot
           WHERE workspace_id = $1 AND flow_id = $2 AND contact_id = $3`,
          [workspaceId, flow.id, nonMatchingContactId]
        );
        return {
          snapshotCount: Number(snapRows[0].count),
          runCount: Number(runRows[0].count),
          nonMatchingSeen: Number(nonMatchRows[0].count),
        };
      })
    );

    // GREEN target: all 3 matching members seeded, zero runs created,
    // the non-matching contact never marked seen.
    expect(snapshotCount).toBe(3);
    expect(runCount).toBe(0);
    expect(nonMatchingSeen).toBe(0);
  });
});
