import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { Redis } from "ioredis";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { isWorkspaceSoftDeleted, WORKSPACE_DELETED_EXCLUSION_REASON } from "@mega-crm/delivery-core";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool, createFixtureFlowRun } from "../../test/db-fixture.js";
import { processSendJob, type SendJobResult } from "../send-dispatch.js";
import { processCampaignKickoffJob } from "../campaign-kickoff.worker.js";
import { emailBroadcastQueue } from "../campaign-broadcast-producer.js";
import {
  freshWorkspaceId,
  connectFixtureSendgridKey,
  createFixtureCampaign,
  createFixtureContact,
  countingSendMail,
} from "../../test/failure-fixtures.js";

/**
 * The dispatch-time half of workspace quiesce (PRG-06, SC1, D-01/D-02/D-03,
 * plan 22-02): a workspace soft-deleted at 12:00:00 must not send the job
 * that was enqueued at 11:59:58. Exercises the shared `isWorkspaceSoftDeleted`
 * fail-closed lookup (`@mega-crm/delivery-core`) on all three dispatch paths
 * (campaign, flow, test-send) plus the campaign-kickoff fan-out guard --
 * matching this codebase's established `processSendJob`/
 * `processCampaignKickoffJob` direct-invocation convention (no live BullMQ
 * Queue round-trip needed; the SendGrid call itself is a fake `sendMail`
 * seam, everything else runs against the real test Postgres/Redis).
 */
describe("dispatch-time workspace quiesce (PRG-06, SC1, plan 22-02)", () => {
  let pool: Pool;
  let redisClient: Redis;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    pool = createTestPool();
    redisClient = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379/1");
  });

  afterAll(async () => {
    await pool.end();
    await redisClient.quit();
  });

  /**
   * `organization` carries no Row-Level Security (packages/db/migrations/
   * 0001_rls_policies.sql deliberately excludes it -- access is scoped via
   * session/membership, not tenant_id) and `mega_crm_app` holds UPDATE on it
   * (migration 0045) -- a plain, non-tenant-scoped query is correct here,
   * mirroring what a real soft-delete action would do.
   */
  async function softDeleteWorkspace(workspaceId: string): Promise<void> {
    await pool.query(`UPDATE organization SET "deletedAt" = now() WHERE id = $1`, [workspaceId]);
  }

  async function sendRowFor(
    workspaceId: string,
    campaignId: string,
    contactId: string
  ): Promise<{ status: string; exclusionReason: string | null } | undefined> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ status: string; exclusionReason: string | null }>(
          `SELECT status, exclusion_reason as "exclusionReason"
           FROM sends WHERE workspace_id = $1 AND campaign_id = $2 AND contact_id = $3`,
          [workspaceId, campaignId, contactId]
        );
        return rows[0];
      })
    );
  }

  async function flowSendRowsFor(
    workspaceId: string,
    flowRunId: string,
    nodeId: string
  ): Promise<Array<{ status: string; exclusionReason: string | null }>> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ status: string; exclusionReason: string | null }>(
          `SELECT status, exclusion_reason as "exclusionReason"
           FROM sends WHERE workspace_id = $1 AND flow_run_id = $2 AND node_id = $3 AND kind = 'flow'`,
          [workspaceId, flowRunId, nodeId]
        );
        return rows;
      })
    );
  }

  async function campaignStatus(workspaceId: string, campaignId: string): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ status: string }>(`SELECT status FROM campaigns WHERE id = $1`, [
          campaignId,
        ]);
        return rows[0].status;
      })
    );
  }

  async function flowRunState(
    workspaceId: string,
    flowRunId: string
  ): Promise<{ status: string; currentNodeId: string | null }> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ status: string; currentNodeId: string | null }>(
          `SELECT status, current_node_id as "currentNodeId" FROM flow_runs WHERE id = $1`,
          [flowRunId]
        );
        return rows[0];
      })
    );
  }

  it("T-22-02-01: campaign path refuses after soft delete, recording an excluded send fact", async () => {
    const workspaceId = await freshWorkspaceId(pool, "quiesce-campaign-refuse");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    await softDeleteWorkspace(workspaceId);

    const counting = countingSendMail(202);
    const result = await processSendJob(
      { workspaceId, campaignId, kind: "campaign", contactId },
      { sendMail: counting.fn, redisClient }
    );

    expect(counting.callCount(), "SendGrid must never be called for a soft-deleted workspace").toBe(0);
    expect(result).toEqual({ outcome: "excluded", reason: WORKSPACE_DELETED_EXCLUSION_REASON });

    const row = await sendRowFor(workspaceId, campaignId, contactId);
    expect(row?.status).toBe("excluded");
    expect(row?.exclusionReason).toBe(WORKSPACE_DELETED_EXCLUSION_REASON);
  });

  it("T-22-02-01: flow path refuses after soft delete, recording an excluded flow send fact", async () => {
    const workspaceId = await freshWorkspaceId(pool, "quiesce-flow-refuse");
    await connectFixtureSendgridKey(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const { flowRunId, nodeId } = await createFixtureFlowRun(workspaceId, contactId);
    await softDeleteWorkspace(workspaceId);

    const counting = countingSendMail(202);
    const result = await processSendJob(
      { workspaceId, kind: "flow", flowRunId, nodeId, contactId },
      { sendMail: counting.fn, redisClient }
    );

    expect(counting.callCount(), "SendGrid must never be called for a soft-deleted workspace").toBe(0);
    expect(result).toEqual({ outcome: "excluded", reason: WORKSPACE_DELETED_EXCLUSION_REASON });

    const rows = await flowSendRowsFor(workspaceId, flowRunId, nodeId);
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("excluded");
    expect(rows[0].exclusionReason).toBe(WORKSPACE_DELETED_EXCLUSION_REASON);
  });

  it("a live workspace (deletedAt null) is unaffected by the quiesce check -- not a blanket refusal", async () => {
    const workspaceId = await freshWorkspaceId(pool, "quiesce-live-campaign");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);

    const counting = countingSendMail(202);
    const result = await processSendJob(
      { workspaceId, campaignId, kind: "campaign", contactId },
      { sendMail: counting.fn, redisClient }
    );

    expect(result.outcome).toBe("sent");
    expect(counting.callCount()).toBe(1);
    const row = await sendRowFor(workspaceId, campaignId, contactId);
    expect(row?.status).toBe("sent");
    expect(row?.exclusionReason).toBeNull();
  });

  it("T-22-02-03: isWorkspaceSoftDeleted fails closed when the organization row cannot be found at all", async () => {
    const client = await pool.connect();
    try {
      const result = await isWorkspaceSoftDeleted(client, randomUUID());
      expect(result, "a workspace the dispatcher cannot resolve must be refused, not allowed").toBe(true);
    } finally {
      client.release();
    }
  });

  it("PRG-06 idempotency: redelivery of the same refused job records the same excluded fact again without error", async () => {
    const workspaceId = await freshWorkspaceId(pool, "quiesce-idempotent");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    await softDeleteWorkspace(workspaceId);

    const counting = countingSendMail(202);
    const first = await processSendJob(
      { workspaceId, campaignId, kind: "campaign", contactId },
      { sendMail: counting.fn, redisClient }
    );
    const redelivered: SendJobResult = await processSendJob(
      { workspaceId, campaignId, kind: "campaign", contactId },
      { sendMail: counting.fn, redisClient }
    );

    expect(first).toEqual({ outcome: "excluded", reason: WORKSPACE_DELETED_EXCLUSION_REASON });
    expect(redelivered).toEqual({ outcome: "excluded", reason: WORKSPACE_DELETED_EXCLUSION_REASON });
    expect(counting.callCount(), "SendGrid must never be called across either attempt").toBe(0);

    const rowCount = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query(
          `SELECT id FROM sends WHERE workspace_id = $1 AND campaign_id = $2 AND contact_id = $3`,
          [workspaceId, campaignId, contactId]
        );
        return rows.length;
      })
    );
    expect(rowCount, "exactly one sends row after a redelivered refusal").toBe(1);

    const row = await sendRowFor(workspaceId, campaignId, contactId);
    expect(row?.status).toBe("excluded");
    expect(row?.exclusionReason).toBe(WORKSPACE_DELETED_EXCLUSION_REASON);
  });

  it("D-02: a quiesce refusal mutates no campaign or flow-run state -- freeze, never cancel", async () => {
    const campaignWorkspaceId = await freshWorkspaceId(pool, "quiesce-state-campaign");
    await connectFixtureSendgridKey(campaignWorkspaceId);
    const campaignId = await createFixtureCampaign(campaignWorkspaceId);
    const contactId = await createFixtureContact(campaignWorkspaceId);
    await softDeleteWorkspace(campaignWorkspaceId);

    const campaignBefore = await campaignStatus(campaignWorkspaceId, campaignId);
    const campaignCounting = countingSendMail(202);
    await processSendJob(
      { workspaceId: campaignWorkspaceId, campaignId, kind: "campaign", contactId },
      { sendMail: campaignCounting.fn, redisClient }
    );
    const campaignAfter = await campaignStatus(campaignWorkspaceId, campaignId);
    expect(campaignAfter).toBe(campaignBefore);
    expect(campaignCounting.callCount()).toBe(0);

    const flowWorkspaceId = await freshWorkspaceId(pool, "quiesce-state-flow");
    await connectFixtureSendgridKey(flowWorkspaceId);
    const flowContactId = await createFixtureContact(flowWorkspaceId);
    const { flowRunId, nodeId } = await createFixtureFlowRun(flowWorkspaceId, flowContactId);
    await softDeleteWorkspace(flowWorkspaceId);

    const flowBefore = await flowRunState(flowWorkspaceId, flowRunId);
    const flowCounting = countingSendMail(202);
    await processSendJob(
      { workspaceId: flowWorkspaceId, kind: "flow", flowRunId, nodeId, contactId: flowContactId },
      { sendMail: flowCounting.fn, redisClient }
    );
    const flowAfter = await flowRunState(flowWorkspaceId, flowRunId);
    expect(flowAfter).toEqual(flowBefore);
    expect(flowCounting.callCount()).toBe(0);
  });

  // --- Task 2: the two paths with no send row -----------------------------

  async function createCampaignWithSegment(workspaceId: string, segmentDefinition: unknown): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows: segmentRows } = await client.query<{ id: string }>(
          `INSERT INTO segments (workspace_id, name, definition, created_by_user_id)
           VALUES ($1, 'Quiesce fixture segment', $2, 'test-user') RETURNING id`,
          [workspaceId, segmentDefinition]
        );
        const { rows: campaignRows } = await client.query<{ id: string }>(
          `INSERT INTO campaigns (workspace_id, name, status, segment_id, template_id, from_email, created_by_user_id)
           VALUES ($1, 'Quiesce fixture campaign', 'sending', $2, 'd-fixture-template', 'sender@fixture.test', 'test-user')
           RETURNING id`,
          [workspaceId, segmentRows[0].id]
        );
        return campaignRows[0].id;
      })
    );
  }

  const ALWAYS_MATCH_DEFINITION = {
    version: 1,
    groups: [
      { conditions: [{ type: "attribute", source: "standard", field: "country", operator: "is_not_empty" }] },
    ],
  };

  async function seedMatchingContacts(workspaceId: string, count: number): Promise<void> {
    await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        for (let i = 0; i < count; i += 1) {
          await client.query(
            `INSERT INTO contacts (workspace_id, email, country) VALUES ($1, $2, 'US')`,
            [workspaceId, `kickoff-${i}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@fixture.test`]
          );
        }
      })
    );
  }

  it("PRG-06: test-send refuses for a deleted workspace without writing any sends row", async () => {
    const workspaceId = await freshWorkspaceId(pool, "quiesce-test-send-refuse");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);
    await softDeleteWorkspace(workspaceId);

    const counting = countingSendMail(202);
    const result = await processSendJob(
      { workspaceId, campaignId, kind: "test", testTo: "marketer@fixture.test" },
      { sendMail: counting.fn, redisClient }
    );

    expect(counting.callCount(), "SendGrid must never be called for a soft-deleted workspace's test send").toBe(0);
    expect(result).toEqual({ outcome: "skipped" });

    const rowCount = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query(`SELECT id FROM sends WHERE workspace_id = $1 AND campaign_id = $2`, [
          workspaceId,
          campaignId,
        ]);
        return rows.length;
      })
    );
    expect(rowCount, "the test-send path never inserts a sends row, quiesced or not").toBe(0);
  });

  it("test-send still succeeds for a live workspace", async () => {
    const workspaceId = await freshWorkspaceId(pool, "quiesce-test-send-live");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);

    const counting = countingSendMail(202);
    const result = await processSendJob(
      { workspaceId, campaignId, kind: "test", testTo: "marketer@fixture.test" },
      { sendMail: counting.fn, redisClient }
    );

    expect(result.outcome).toBe("sent");
    expect(counting.callCount()).toBe(1);
  });

  it("PRG-06/D-01: campaign kickoff enqueues zero per-recipient jobs for a soft-deleted workspace", async () => {
    const workspaceId = await freshWorkspaceId(pool, "quiesce-kickoff-refuse");
    await seedMatchingContacts(workspaceId, 3);
    const campaignId = await createCampaignWithSegment(workspaceId, ALWAYS_MATCH_DEFINITION);
    await softDeleteWorkspace(workspaceId);

    const statusBefore = await campaignStatus(workspaceId, campaignId);
    const addSpy = vi.spyOn(emailBroadcastQueue, "add");
    try {
      await processCampaignKickoffJob({ workspaceId, campaignId });
      expect(addSpy, "a deleted workspace's kickoff must fan out nothing at all").not.toHaveBeenCalled();
    } finally {
      addSpy.mockRestore();
    }

    const statusAfter = await campaignStatus(workspaceId, campaignId);
    expect(statusAfter).toBe(statusBefore);
  });

  it("campaign kickoff for a live workspace enqueues one job per sendable recipient (unaffected)", async () => {
    const workspaceId = await freshWorkspaceId(pool, "quiesce-kickoff-live");
    await seedMatchingContacts(workspaceId, 3);
    const campaignId = await createCampaignWithSegment(workspaceId, ALWAYS_MATCH_DEFINITION);

    const addSpy = vi.spyOn(emailBroadcastQueue, "add");
    try {
      await processCampaignKickoffJob({ workspaceId, campaignId });
      expect(addSpy).toHaveBeenCalledTimes(3);
    } finally {
      addSpy.mockRestore();
    }
  });
});
