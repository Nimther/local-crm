import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { processWebhookEventBatch } from "../webhook-events.worker.js";
import { insertFixtureOrganization } from "../../test/failure-fixtures.js";

/**
 * 05-03 (WBHK-04, D-06/D-09): delivered/open/click fact-column + campaign
 * counter exactly-once semantics, plus out-of-order fact safety. Runs
 * against a real Postgres fixture (mirrors webhook-events-idempotency.test.ts's
 * convention) -- the worker's whole side-effect pipeline runs inside
 * `withTenant`/`withTenantTransaction`, so verification reads must too.
 */
describe("webhook-events worker: delivery facts + counters (WBHK-04, D-06/D-09)", () => {
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

  // segments/campaigns/contacts/sends all carry ENABLE + FORCE ROW LEVEL
  // SECURITY -- fixture inserts MUST run inside withTenant/withTenantTransaction.
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

  interface SendFacts {
    deliveredAt: Date | null;
    firstOpenedAt: Date | null;
    firstClickedAt: Date | null;
    bouncedAt: Date | null;
  }

  async function sendFacts(workspaceId: string, sendId: string): Promise<SendFacts> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<SendFacts>(
          `SELECT delivered_at as "deliveredAt", first_opened_at as "firstOpenedAt",
                  first_clicked_at as "firstClickedAt", bounced_at as "bouncedAt"
           FROM sends WHERE id = $1`,
          [sendId]
        );
        return rows[0];
      })
    );
  }

  interface CampaignCounters {
    deliveredCount: number;
    openedCount: number;
    clickedCount: number;
    bouncedCount: number;
  }

  async function campaignCounters(workspaceId: string, campaignId: string): Promise<CampaignCounters> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<CampaignCounters>(
          `SELECT delivered_count as "deliveredCount", opened_count as "openedCount",
                  clicked_count as "clickedCount", bounced_count as "bouncedCount"
           FROM campaigns WHERE id = $1`,
          [campaignId]
        );
        return rows[0];
      })
    );
  }

  // SendGrid's Event Webhook flattens the mail/send markers directly onto
  // the event object's TOP LEVEL (no nested wrapper) -- this fixture
  // matches the real shape the corrected worker reads.
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
      sg_message_id: "abc.filterdrecv-x",
      timestamp: 1_700_000_000,
      send_id: sendId,
      workspace_id: workspaceId,
      campaign_id: campaignId,
      ...overrides,
    };
  }

  it("delivered sets delivered_at + delivered_count=1; a replay leaves both unchanged", async () => {
    const workspaceId = await freshWorkspaceId("status-delivered");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);

    const events = [sendgridEvent(workspaceId, campaignId, sendId, { event: "delivered" })];

    const first = await processWebhookEventBatch({ workspaceId, events });
    expect(first.inserted).toBe(1);

    const factsAfterFirst = await sendFacts(workspaceId, sendId);
    expect(factsAfterFirst.deliveredAt).not.toBeNull();
    expect((await campaignCounters(workspaceId, campaignId)).deliveredCount).toBe(1);

    // Replay of the identical batch: dedup RETURNING gate yields 0 new rows,
    // zero additional side effects.
    const replay = await processWebhookEventBatch({ workspaceId, events });
    expect(replay.inserted).toBe(0);

    const factsAfterReplay = await sendFacts(workspaceId, sendId);
    expect(factsAfterReplay.deliveredAt?.toISOString()).toBe(factsAfterFirst.deliveredAt?.toISOString());
    expect((await campaignCounters(workspaceId, campaignId)).deliveredCount, "no double-count on replay").toBe(1);
  });

  it("open sets first_opened_at + opened_count once", async () => {
    const workspaceId = await freshWorkspaceId("status-open");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);

    const events = [sendgridEvent(workspaceId, campaignId, sendId, { event: "open" })];
    await processWebhookEventBatch({ workspaceId, events });

    const facts = await sendFacts(workspaceId, sendId);
    expect(facts.firstOpenedAt).not.toBeNull();
    expect((await campaignCounters(workspaceId, campaignId)).openedCount).toBe(1);

    // A second, distinct open event for the same send: fact already set, no
    // second counter increment.
    const secondOpen = [sendgridEvent(workspaceId, campaignId, sendId, { event: "open" })];
    await processWebhookEventBatch({ workspaceId, events: secondOpen });
    expect((await campaignCounters(workspaceId, campaignId)).openedCount, "unique-recipient count stays 1").toBe(1);
  });

  it("click sets first_clicked_at + clicked_count once", async () => {
    const workspaceId = await freshWorkspaceId("status-click");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);

    const events = [sendgridEvent(workspaceId, campaignId, sendId, { event: "click" })];
    await processWebhookEventBatch({ workspaceId, events });

    const facts = await sendFacts(workspaceId, sendId);
    expect(facts.firstClickedAt).not.toBeNull();
    expect((await campaignCounters(workspaceId, campaignId)).clickedCount).toBe(1);
  });

  it("D-06: two distinct delivered events for the same send never double-set the fact or double-count", async () => {
    const workspaceId = await freshWorkspaceId("status-out-of-order-1");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);

    const first = sendgridEvent(workspaceId, campaignId, sendId, { event: "delivered", timestamp: 1_700_000_100 });
    await processWebhookEventBatch({ workspaceId, events: [first] });
    const factsAfterFirst = await sendFacts(workspaceId, sendId);

    // A second, distinct sg_event_id also reporting "delivered" with an
    // EARLIER timestamp than the first -- must not overwrite the
    // already-set delivered_at (first-write-wins, not earliest-wins).
    const second = sendgridEvent(workspaceId, campaignId, sendId, { event: "delivered", timestamp: 1_700_000_000 });
    await processWebhookEventBatch({ workspaceId, events: [second] });

    const factsAfterSecond = await sendFacts(workspaceId, sendId);
    expect(factsAfterSecond.deliveredAt?.toISOString()).toBe(factsAfterFirst.deliveredAt?.toISOString());
    expect((await campaignCounters(workspaceId, campaignId)).deliveredCount, "no double-count").toBe(1);
  });

  it("D-06: an out-of-order (earlier-timestamped) bounce arriving after delivered never touches delivered_at", async () => {
    const workspaceId = await freshWorkspaceId("status-out-of-order-2");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);

    const delivered = sendgridEvent(workspaceId, campaignId, sendId, {
      event: "delivered",
      timestamp: 1_700_000_100,
    });
    await processWebhookEventBatch({ workspaceId, events: [delivered] });
    const factsAfterDelivered = await sendFacts(workspaceId, sendId);
    expect(factsAfterDelivered.deliveredAt).not.toBeNull();

    const earlierBounce = sendgridEvent(workspaceId, campaignId, sendId, {
      event: "bounce",
      type: "bounce",
      reason: "550 5.1.1 mailbox unavailable",
      timestamp: 1_700_000_000,
    });
    await processWebhookEventBatch({ workspaceId, events: [earlierBounce] });

    const factsAfterBounce = await sendFacts(workspaceId, sendId);
    expect(factsAfterBounce.deliveredAt?.toISOString(), "delivered_at is a distinct, untouched column").toBe(
      factsAfterDelivered.deliveredAt?.toISOString()
    );
    expect(factsAfterBounce.bouncedAt, "bounce sets its own, separate fact column").not.toBeNull();
    expect((await campaignCounters(workspaceId, campaignId)).bouncedCount).toBe(1);
  });

  it("delivered/open/click with no campaignId (flow-triggered send) sets the fact but never touches campaign counters", async () => {
    const workspaceId = await freshWorkspaceId("status-no-campaign");
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO sends (workspace_id, campaign_id, contact_id, kind, status, sent_at)
           VALUES ($1, NULL, $2, 'campaign', 'sent', now()) RETURNING id`,
          [workspaceId, contactId]
        );
        return rows[0].id;
      })
    );

    const events = [
      {
        email: "hello@world.com",
        event: "delivered",
        sg_event_id: `sg-${randomUUID()}`,
        timestamp: 1_700_000_000,
        send_id: sendId,
        workspace_id: workspaceId,
      },
    ];

    await expect(processWebhookEventBatch({ workspaceId, events })).resolves.toEqual({ inserted: 1 });
    const facts = await sendFacts(workspaceId, sendId);
    expect(facts.deliveredAt).not.toBeNull();
  });
});
