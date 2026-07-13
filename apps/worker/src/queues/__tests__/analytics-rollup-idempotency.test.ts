import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { processWebhookEventBatch } from "../webhook-events.worker.js";

/**
 * workspace_daily_rollup incremental-increment idempotency (07-06, ANLT-04).
 * A genuinely-new delivered/opened/clicked/bounced/unsubscribed webhook
 * event increments the matching rollup metric for (workspace, day) exactly
 * once; a replayed batch (same sg_event_id) produces zero additional
 * increments, mirroring webhook-events-idempotency.test.ts's real-Postgres
 * fixture convention.
 */
describe("workspace_daily_rollup incremental increment (07-06, ANLT-04)", () => {
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

  async function rollupCounts(
    workspaceId: string,
    day: string
  ): Promise<{
    deliveredCount: number;
    openedCount: number;
    clickedCount: number;
    bouncedCount: number;
    unsubscribedCount: number;
  } | null> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{
          deliveredCount: number;
          openedCount: number;
          clickedCount: number;
          bouncedCount: number;
          unsubscribedCount: number;
        }>(
          `SELECT delivered_count as "deliveredCount", opened_count as "openedCount",
                  clicked_count as "clickedCount", bounced_count as "bouncedCount",
                  unsubscribed_count as "unsubscribedCount"
           FROM workspace_daily_rollup WHERE workspace_id = $1 AND day = $2`,
          [workspaceId, day]
        );
        return rows[0] ?? null;
      })
    );
  }

  const FIXED_TIMESTAMP = 1_700_000_000; // -> day 2023-11-14
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

  it("a genuinely-new delivered event increments delivered_count 0->1; a replayed batch leaves it unchanged", async () => {
    const workspaceId = await freshWorkspaceId("rollup-delivered");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);

    const events = [sendgridEvent(workspaceId, campaignId, sendId, { event: "delivered" })];

    const first = await processWebhookEventBatch({ workspaceId, events });
    expect(first.inserted).toBe(1);
    expect((await rollupCounts(workspaceId, DAY))?.deliveredCount).toBe(1);

    // BullMQ at-least-once redelivery of the exact same batch.
    const replay = await processWebhookEventBatch({ workspaceId, events });
    expect(replay.inserted).toBe(0);
    expect((await rollupCounts(workspaceId, DAY))?.deliveredCount).toBe(1);
  });

  it("opened_count climbs on every genuinely-new open event (not just the first) but a replay is a no-op", async () => {
    const workspaceId = await freshWorkspaceId("rollup-opened");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);

    const firstOpen = [sendgridEvent(workspaceId, campaignId, sendId, { event: "open" })];
    await processWebhookEventBatch({ workspaceId, events: firstOpen });
    expect((await rollupCounts(workspaceId, DAY))?.openedCount).toBe(1);

    const secondOpen = [sendgridEvent(workspaceId, campaignId, sendId, { event: "open" })];
    await processWebhookEventBatch({ workspaceId, events: secondOpen });
    expect((await rollupCounts(workspaceId, DAY))?.openedCount).toBe(2);

    // Replay the exact same batch -- dedup insert returns zero new rows.
    await processWebhookEventBatch({ workspaceId, events: secondOpen });
    expect((await rollupCounts(workspaceId, DAY))?.openedCount).toBe(2);
  });

  it("clicked_count climbs on every genuinely-new click event but a replay is a no-op", async () => {
    const workspaceId = await freshWorkspaceId("rollup-clicked");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);

    const firstClick = [sendgridEvent(workspaceId, campaignId, sendId, { event: "click" })];
    await processWebhookEventBatch({ workspaceId, events: firstClick });
    expect((await rollupCounts(workspaceId, DAY))?.clickedCount).toBe(1);

    const replay = [...firstClick];
    await processWebhookEventBatch({ workspaceId, events: replay });
    expect((await rollupCounts(workspaceId, DAY))?.clickedCount).toBe(1);
  });

  it("a hard bounce increments bounced_count once; a replay leaves it unchanged", async () => {
    const workspaceId = await freshWorkspaceId("rollup-bounced");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);

    const events = [
      sendgridEvent(workspaceId, campaignId, sendId, { event: "bounce", type: "bounce", reason: "550 hard" }),
    ];

    const first = await processWebhookEventBatch({ workspaceId, events });
    expect(first.inserted).toBe(1);
    expect((await rollupCounts(workspaceId, DAY))?.bouncedCount).toBe(1);

    const replay = await processWebhookEventBatch({ workspaceId, events });
    expect(replay.inserted).toBe(0);
    expect((await rollupCounts(workspaceId, DAY))?.bouncedCount).toBe(1);
  });

  it("an unsubscribe event increments unsubscribed_count once; a replay leaves it unchanged", async () => {
    const workspaceId = await freshWorkspaceId("rollup-unsub");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);

    const events = [sendgridEvent(workspaceId, campaignId, sendId, { event: "unsubscribe" })];

    const first = await processWebhookEventBatch({ workspaceId, events });
    expect(first.inserted).toBe(1);
    expect((await rollupCounts(workspaceId, DAY))?.unsubscribedCount).toBe(1);

    const replay = await processWebhookEventBatch({ workspaceId, events });
    expect(replay.inserted).toBe(0);
    expect((await rollupCounts(workspaceId, DAY))?.unsubscribedCount).toBe(1);
  });
});
