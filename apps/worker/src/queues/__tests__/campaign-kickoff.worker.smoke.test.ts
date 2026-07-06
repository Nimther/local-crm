import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { processCampaignKickoffJob } from "../campaign-kickoff.worker.js";

/**
 * Overall plan verification (04-06 <verification>): the launch-to-send
 * glue end-to-end -- an empty sendable audience completes to 'sent' with 0
 * sent (D-05), and a non-empty audience freezes its snapshot + fans out
 * one deterministic-jobId email-broadcast job per sendable contact
 * (SEND-01/06). Not a task-mandated TDD file (only Task 1's
 * recipient-snapshot.test.ts is) -- this proves the PLAN's own overall
 * `<verification>` bullet ("empty audience -> sent-0") against the real
 * worker/DB integration, matching this codebase's established
 * db-fixture.ts convention (imports-csv-idempotency.test.ts,
 * send-dispatch-idempotency.test.ts).
 */
describe("campaign-kickoff.worker.ts processCampaignKickoffJob (overall plan verification)", () => {
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

  async function createCampaignWithSegment(
    workspaceId: string,
    segmentDefinition: unknown
  ): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows: segmentRows } = await client.query<{ id: string }>(
          `INSERT INTO segments (workspace_id, name, definition, created_by_user_id)
           VALUES ($1, 'Fixture segment', $2, 'test-user') RETURNING id`,
          [workspaceId, segmentDefinition]
        );
        const { rows: campaignRows } = await client.query<{ id: string }>(
          `INSERT INTO campaigns (workspace_id, name, status, segment_id, template_id, from_email, created_by_user_id)
           VALUES ($1, 'Fixture campaign', 'sending', $2, 'd-fixture-template', 'sender@fixture.test', 'test-user')
           RETURNING id`,
          [workspaceId, segmentRows[0].id]
        );
        return campaignRows[0].id;
      })
    );
  }

  interface CampaignSnapshot {
    status: string;
    sendableTotal: number | null;
    excludedTotal: number | null;
    fanOutComplete: boolean;
    terminalAt: Date | null;
  }

  async function getCampaignSnapshot(workspaceId: string, campaignId: string): Promise<CampaignSnapshot> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<CampaignSnapshot>(
          `SELECT status, sendable_total as "sendableTotal", excluded_total as "excludedTotal",
                  fan_out_complete as "fanOutComplete", terminal_at as "terminalAt"
           FROM campaigns WHERE id = $1`,
          [campaignId]
        );
        return rows[0];
      })
    );
  }

  const EMPTY_MATCH_DEFINITION = {
    version: 1,
    groups: [{ conditions: [{ type: "attribute", source: "standard", field: "country", operator: "eq", value: "__never_matches__" }] }],
  };
  const ALWAYS_MATCH_DEFINITION = {
    version: 1,
    groups: [{ conditions: [{ type: "attribute", source: "standard", field: "country", operator: "is_not_empty" }] }],
  };

  it("D-05: an empty sendable audience completes the campaign to 'sent' with 0 sent, not a failed state", async () => {
    const workspaceId = await freshWorkspaceId("kickoff-empty");
    // Contact exists but never matches the segment's condition (country != "__never_matches__").
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(`INSERT INTO contacts (workspace_id, email, country) VALUES ($1, 'a@fixture.test', 'US')`, [workspaceId])
      )
    );
    const campaignId = await createCampaignWithSegment(workspaceId, EMPTY_MATCH_DEFINITION);

    await processCampaignKickoffJob({ workspaceId, campaignId });

    const snapshot = await getCampaignSnapshot(workspaceId, campaignId);
    expect(snapshot.status).toBe("sent");
    expect(snapshot.sendableTotal).toBe(0);
    expect(snapshot.fanOutComplete).toBe(true);
    expect(snapshot.terminalAt).not.toBeNull();
  });

  it("CAMP-05/T-04-06-03: a non-empty audience freezes the snapshot, computes sendable_total, and is guarded against re-fan-out on redelivery", async () => {
    const workspaceId = await freshWorkspaceId("kickoff-nonempty");
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(`INSERT INTO contacts (workspace_id, email, country) VALUES ($1, 'b@fixture.test', 'US')`, [workspaceId])
      )
    );
    const campaignId = await createCampaignWithSegment(workspaceId, ALWAYS_MATCH_DEFINITION);

    await processCampaignKickoffJob({ workspaceId, campaignId });

    const snapshot = await getCampaignSnapshot(workspaceId, campaignId);
    expect(snapshot.status).toBe("sending"); // never transitioned to sent by kickoff itself
    expect(snapshot.sendableTotal).toBe(1);
    expect(snapshot.excludedTotal).toBe(0);
    expect(snapshot.fanOutComplete).toBe(true);

    const recipientCount = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query(`SELECT count(*)::int as count FROM campaign_recipients WHERE campaign_id = $1`, [
          campaignId,
        ]);
        return rows[0].count;
      })
    );
    expect(recipientCount).toBe(1); // D-02: frozen snapshot has exactly the one matching contact

    // T-04-06-03: a redelivered kickoff job is a safe, cheap no-op once
    // fan_out_complete is set -- it must not throw or re-derive anything.
    await expect(processCampaignKickoffJob({ workspaceId, campaignId })).resolves.toBeUndefined();
    const snapshotAfterRedelivery = await getCampaignSnapshot(workspaceId, campaignId);
    expect(snapshotAfterRedelivery.sendableTotal).toBe(1); // unchanged, not recomputed/doubled
  });
});
