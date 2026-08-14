import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { processWebhookEventBatch } from "../webhook-events.worker.js";
import { insertFixtureOrganization } from "../../test/failure-fixtures.js";

/**
 * 07-01 (A4/D-11): per-send repeat open/click counters. Every genuinely-new
 * open/click event climbs `sends.open_count`/`click_count` (not just the
 * first occurrence, unlike `first_opened_at`/`first_clicked_at`), while a
 * replayed batch (same sg_event_id) never double-increments. Mirrors
 * webhook-events-idempotency.test.ts's real-Postgres fixture convention.
 */
describe("webhook-events worker: repeat open/click counters (07-01, A4/D-11)", () => {
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

  async function sendCounts(workspaceId: string, sendId: string): Promise<{ openCount: number; clickCount: number }> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ openCount: number; clickCount: number }>(
          `SELECT open_count as "openCount", click_count as "clickCount" FROM sends WHERE id = $1`,
          [sendId]
        );
        return rows[0];
      })
    );
  }

  // Phase 13 (CMP-05, plan 13-04): a fixed 2023-era timestamp is now OLD
  // ENOUGH to fall outside classifyOccurredAt's [now-7d, now+5min] window and
  // get quarantined instead of inserted.
  const FIXED_TIMESTAMP = Math.floor(Date.now() / 1000) - 3600;

  function sendgridEvent(
    workspaceId: string,
    campaignId: string,
    sendId: string,
    overrides: Record<string, unknown> = {}
  ): Record<string, unknown> {
    return {
      email: "hello@world.com",
      event: "open",
      sg_event_id: `sg-${randomUUID()}`,
      timestamp: FIXED_TIMESTAMP,
      send_id: sendId,
      workspace_id: workspaceId,
      campaign_id: campaignId,
      ...overrides,
    };
  }

  it("Test D: opens -- a new open sets 0->1, a second distinct open ONE SECOND LATER sets 1->2, a replayed batch (same sg_event_id) leaves it unchanged", async () => {
    // Phase 13 (CMP-07, plan 13-07) deviation: the dedup key is now
    // (workspace_id, send_id, event_type, occurred_at). Two opens on the
    // SAME send at the exact SAME occurred_at (the original fixture's
    // shared FIXED_TIMESTAMP) now collapse to ONE row under the new key
    // (T-13-07-06, pinned by webhook-events-dedup-rebase.test.ts) --
    // this test's "second distinct open increments the counter" intent
    // requires a DIFFERENT occurred_at, not merely a different sg_event_id,
    // to be a genuinely-new row under the new key.
    const workspaceId = await freshWorkspaceId("open-count");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);

    const firstOpen = [sendgridEvent(workspaceId, campaignId, sendId, { event: "open" })];
    await processWebhookEventBatch({ workspaceId, events: firstOpen });
    expect((await sendCounts(workspaceId, sendId)).openCount).toBe(1);

    const secondOpen = [
      sendgridEvent(workspaceId, campaignId, sendId, { event: "open", timestamp: FIXED_TIMESTAMP + 1 }),
    ];
    await processWebhookEventBatch({ workspaceId, events: secondOpen });
    expect((await sendCounts(workspaceId, sendId)).openCount).toBe(2);

    // Replay the exact same batch (identical sg_event_id AND occurred_at) --
    // dedup insert returns zero new rows, so zero additional side effects fire.
    await processWebhookEventBatch({ workspaceId, events: secondOpen });
    expect((await sendCounts(workspaceId, sendId)).openCount).toBe(2);
  });

  it("Test D: clicks -- a new click sets 0->1, a second distinct click ONE SECOND LATER sets 1->2, a replayed batch leaves it unchanged", async () => {
    // See the opens test above for why the second event needs a distinct
    // occurred_at under the Phase 13 (CMP-07) dedup key.
    const workspaceId = await freshWorkspaceId("click-count");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);

    const firstClick = [sendgridEvent(workspaceId, campaignId, sendId, { event: "click" })];
    await processWebhookEventBatch({ workspaceId, events: firstClick });
    expect((await sendCounts(workspaceId, sendId)).clickCount).toBe(1);

    const secondClick = [
      sendgridEvent(workspaceId, campaignId, sendId, { event: "click", timestamp: FIXED_TIMESTAMP + 1 }),
    ];
    await processWebhookEventBatch({ workspaceId, events: secondClick });
    expect((await sendCounts(workspaceId, sendId)).clickCount).toBe(2);

    await processWebhookEventBatch({ workspaceId, events: secondClick });
    expect((await sendCounts(workspaceId, sendId)).clickCount).toBe(2);
  });
});
