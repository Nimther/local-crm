import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { processWebhookEventBatch } from "../webhook-events.worker.js";
import { insertFixtureOrganization } from "../../test/failure-fixtures.js";

/**
 * workspace_daily_rollup tenant isolation (07-06, T-07-06-01/T-07-06-02).
 * Two workspaces processed independently each get their own disjoint rollup
 * row for the same day -- neither leaks into the other's counts.
 */
describe("workspace_daily_rollup tenant isolation (07-06)", () => {
  let pool: Pool;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    pool = createTestPool();
  });

  afterAll(async () => {
    await pool.end();
  });

  // 10-09 (SEC-05): delegates to the mega_crm_auth-backed INSERT in
  // failure-fixtures.ts instead of duplicating it -- mega_crm_app holds
  // only SELECT on organization post-migration-0045.
  async function freshWorkspaceId(nameSeed: string): Promise<string> {
    return insertFixtureOrganization(nameSeed);
  }

  async function createFixtureCampaign(workspaceId: string): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows: segmentRows } = await client.query<{ id: string }>(
          `INSERT INTO segments (workspace_id, name, definition, created_by_user_id)
           VALUES ($1, 'Fixture segment', $2, 'test-user') RETURNING id`,
          [workspaceId, { operator: "and", conditions: [] }]
        );
        const { rows: campaignRows } = await client.query<{ id: string }>(
          `INSERT INTO campaigns (workspace_id, name, status, segment_id, template_id, from_email, created_by_user_id)
           VALUES ($1, 'Fixture campaign', 'sent', $2, 'd-fixture-template', 'sender@fixture.test', 'test-user')
           RETURNING id`,
          [workspaceId, segmentRows[0].id]
        );
        return campaignRows[0].id;
      })
    );
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

  async function createFixtureSend(workspaceId: string, campaignId: string, contactId: string): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO sends (workspace_id, campaign_id, contact_id, kind, status, sent_at)
           VALUES ($1, $2, $3, 'campaign', 'sent', now()) RETURNING id`,
          [workspaceId, campaignId, contactId]
        );
        return rows[0].id;
      })
    );
  }

  async function rollupRowCount(workspaceId: string): Promise<number> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*)::text as count FROM workspace_daily_rollup WHERE workspace_id = $1`,
          [workspaceId]
        );
        return Number(rows[0].count);
      })
    );
  }

  async function rollupDeliveredCount(workspaceId: string, day: string): Promise<number> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ deliveredCount: number }>(
          `SELECT delivered_count as "deliveredCount" FROM workspace_daily_rollup WHERE workspace_id = $1 AND day = $2`,
          [workspaceId, day]
        );
        return rows[0]?.deliveredCount ?? 0;
      })
    );
  }

  const FIXED_TIMESTAMP = 1_700_000_000;
  const DAY = new Date(FIXED_TIMESTAMP * 1000).toISOString().slice(0, 10);

  function sendgridEvent(
    workspaceId: string,
    campaignId: string,
    sendId: string,
    overrides: Record<string, unknown> = {}
  ): Record<string, unknown> {
    return {
      email: "hello@world.com",
      event: "delivered",
      sg_event_id: `sg-${randomUUID()}`,
      timestamp: FIXED_TIMESTAMP,
      send_id: sendId,
      workspace_id: workspaceId,
      campaign_id: campaignId,
      ...overrides,
    };
  }

  it("two workspaces processed in the same test each get their own rollup row; neither leaks into the other's counts", async () => {
    const workspaceA = await freshWorkspaceId("rollup-tenant-a");
    const workspaceB = await freshWorkspaceId("rollup-tenant-b");

    const campaignA = await createFixtureCampaign(workspaceA);
    const contactA = await createFixtureContact(workspaceA);
    const sendA = await createFixtureSend(workspaceA, campaignA, contactA);

    const campaignB = await createFixtureCampaign(workspaceB);
    const contactB1 = await createFixtureContact(workspaceB);
    const contactB2 = await createFixtureContact(workspaceB);
    const sendB1 = await createFixtureSend(workspaceB, campaignB, contactB1);
    const sendB2 = await createFixtureSend(workspaceB, campaignB, contactB2);

    await processWebhookEventBatch({
      workspaceId: workspaceA,
      events: [sendgridEvent(workspaceA, campaignA, sendA)],
    });
    await processWebhookEventBatch({
      workspaceId: workspaceB,
      events: [sendgridEvent(workspaceB, campaignB, sendB1), sendgridEvent(workspaceB, campaignB, sendB2)],
    });

    expect(await rollupRowCount(workspaceA)).toBe(1);
    expect(await rollupRowCount(workspaceB)).toBe(1);
    expect(await rollupDeliveredCount(workspaceA, DAY)).toBe(1);
    expect(await rollupDeliveredCount(workspaceB, DAY)).toBe(2);
  });
});
