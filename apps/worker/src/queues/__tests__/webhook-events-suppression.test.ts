import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { processWebhookEventBatch } from "../webhook-events.worker.js";

/**
 * 05-03 (SUBS-02, D-10/D-11/D-12/D-13): the full suppression state machine --
 * hard bounce / spam / unsubscribe / address-drop / soft-bounce streak --
 * plus the D-15 test-marker and orphaned-send short-circuits. Runs against a
 * real Postgres fixture, mirroring webhook-events-idempotency.test.ts's
 * convention.
 */
describe("webhook-events worker: suppression state machine (SUBS-02, D-10/D-11/D-12/D-13)", () => {
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

  async function createFixtureContact(workspaceId: string): Promise<{ id: string; email: string }> {
    const email = `contact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@fixture.test`;
    const id = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO contacts (workspace_id, email, first_name, subscription_status)
           VALUES ($1, $2, 'Fixture', 'subscribed') RETURNING id`,
          [workspaceId, email]
        );
        return rows[0].id;
      })
    );
    return { id, email };
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

  interface ContactState {
    subscriptionStatus: string;
    consecutiveSoftBounces: number;
  }

  async function contactState(workspaceId: string, contactId: string): Promise<ContactState> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<ContactState>(
          `SELECT subscription_status as "subscriptionStatus", consecutive_soft_bounces as "consecutiveSoftBounces"
           FROM contacts WHERE id = $1`,
          [contactId]
        );
        return rows[0];
      })
    );
  }

  async function suppressionRows(
    workspaceId: string,
    email: string
  ): Promise<Array<{ reason: string }>> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ reason: string }>(
          `SELECT reason FROM workspace_suppressions WHERE workspace_id = $1 AND email = $2`,
          [workspaceId, email]
        );
        return rows;
      })
    );
  }

  async function sendBounceReason(workspaceId: string, sendId: string): Promise<string | null> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ bounceReason: string | null }>(
          `SELECT bounce_reason as "bounceReason" FROM sends WHERE id = $1`,
          [sendId]
        );
        return rows[0]?.bounceReason ?? null;
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
      timestamp: 1_700_000_000,
      send_id: sendId,
      workspace_id: workspaceId,
      campaign_id: campaignId,
      ...overrides,
    };
  }

  it("D-13: a hard bounce suppresses the contact + writes exactly one workspace_suppressions row (reason hard_bounce)", async () => {
    const workspaceId = await freshWorkspaceId("supp-hard-bounce");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contact = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contact.id);

    const events = [
      sendgridEvent(workspaceId, campaignId, sendId, { event: "bounce", type: "bounce", reason: "550 hard fail" }),
    ];
    await processWebhookEventBatch({ workspaceId, events });

    expect((await contactState(workspaceId, contact.id)).subscriptionStatus).toBe("suppressed");
    const rows = await suppressionRows(workspaceId, contact.email);
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("hard_bounce");
    expect(await sendBounceReason(workspaceId, sendId)).toBe("hard_bounce");
  });

  it("D-11: a spam report suppresses the contact with reason spam_report", async () => {
    const workspaceId = await freshWorkspaceId("supp-spam");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contact = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contact.id);

    const events = [sendgridEvent(workspaceId, campaignId, sendId, { event: "spamreport" })];
    await processWebhookEventBatch({ workspaceId, events });

    expect((await contactState(workspaceId, contact.id)).subscriptionStatus).toBe("suppressed");
    const rows = await suppressionRows(workspaceId, contact.email);
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("spam_report");
  });

  it("D-11/D-13: unsubscribe flips status to unsubscribed and writes ZERO workspace_suppressions rows", async () => {
    const workspaceId = await freshWorkspaceId("supp-unsub");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contact = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contact.id);

    const events = [sendgridEvent(workspaceId, campaignId, sendId, { event: "unsubscribe" })];
    await processWebhookEventBatch({ workspaceId, events });

    expect((await contactState(workspaceId, contact.id)).subscriptionStatus).toBe("unsubscribed");
    expect(await suppressionRows(workspaceId, contact.email)).toHaveLength(0);
  });

  it("D-11: group_unsubscribe also flips status to unsubscribed with zero suppression rows", async () => {
    const workspaceId = await freshWorkspaceId("supp-group-unsub");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contact = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contact.id);

    const events = [sendgridEvent(workspaceId, campaignId, sendId, { event: "group_unsubscribe" })];
    await processWebhookEventBatch({ workspaceId, events });

    expect((await contactState(workspaceId, contact.id)).subscriptionStatus).toBe("unsubscribed");
    expect(await suppressionRows(workspaceId, contact.email)).toHaveLength(0);
  });

  it("D-10: the 3rd consecutive soft bounce suppresses (reason soft_bounce_streak); a delivered event resets the streak", async () => {
    const workspaceId = await freshWorkspaceId("supp-soft-streak");
    const contact = await createFixtureContact(workspaceId);
    // The sends_workspace_campaign_contact_unique constraint (SEND-04) means
    // a distinct campaign is needed per send for the same contact -- mirrors
    // the real-world case of a contact receiving multiple separate campaigns.
    async function nextSend(): Promise<string> {
      const campaignId = await createFixtureCampaign(workspaceId);
      return createFixtureSend(workspaceId, campaignId, contact.id);
    }

    // 1st soft bounce.
    await processWebhookEventBatch({
      workspaceId,
      events: [sendgridEvent(workspaceId, "", await nextSend(), { event: "bounce", type: "blocked" })],
    });
    expect((await contactState(workspaceId, contact.id)).consecutiveSoftBounces).toBe(1);
    expect((await contactState(workspaceId, contact.id)).subscriptionStatus).toBe("subscribed");

    // A delivered event in between resets the streak to 0.
    await processWebhookEventBatch({
      workspaceId,
      events: [sendgridEvent(workspaceId, "", await nextSend(), { event: "delivered" })],
    });
    expect((await contactState(workspaceId, contact.id)).consecutiveSoftBounces).toBe(0);

    // Two more soft bounces after the reset -- streak is 1, then 2. Neither suppresses.
    await processWebhookEventBatch({
      workspaceId,
      events: [sendgridEvent(workspaceId, "", await nextSend(), { event: "bounce", type: "blocked" })],
    });
    expect((await contactState(workspaceId, contact.id)).consecutiveSoftBounces).toBe(1);
    expect((await contactState(workspaceId, contact.id)).subscriptionStatus).toBe("subscribed");

    await processWebhookEventBatch({
      workspaceId,
      events: [sendgridEvent(workspaceId, "", await nextSend(), { event: "bounce", type: "blocked" })],
    });
    expect((await contactState(workspaceId, contact.id)).consecutiveSoftBounces).toBe(2);
    expect((await contactState(workspaceId, contact.id)).subscriptionStatus).toBe("subscribed");

    // The 3rd consecutive soft bounce -- suppression fires.
    const sendId4 = await nextSend();
    await processWebhookEventBatch({
      workspaceId,
      events: [sendgridEvent(workspaceId, "", sendId4, { event: "bounce", type: "blocked" })],
    });
    expect((await contactState(workspaceId, contact.id)).consecutiveSoftBounces).toBe(3);
    expect((await contactState(workspaceId, contact.id)).subscriptionStatus).toBe("suppressed");
    const rows = await suppressionRows(workspaceId, contact.email);
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("soft_bounce_streak");
    expect(await sendBounceReason(workspaceId, sendId4)).toBe("soft_bounce_streak");
  });

  it("D-12: dropped 'Bounced Address' suppresses the contact", async () => {
    const workspaceId = await freshWorkspaceId("supp-drop-bounced");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contact = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contact.id);

    await processWebhookEventBatch({
      workspaceId,
      events: [sendgridEvent(workspaceId, campaignId, sendId, { event: "dropped", reason: "Bounced Address" })],
    });

    expect((await contactState(workspaceId, contact.id)).subscriptionStatus).toBe("suppressed");
    expect(await suppressionRows(workspaceId, contact.email)).toHaveLength(1);
  });

  it("D-12: dropped 'Unsubscribed Address' unsubscribes the contact (no suppression row)", async () => {
    const workspaceId = await freshWorkspaceId("supp-drop-unsub");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contact = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contact.id);

    await processWebhookEventBatch({
      workspaceId,
      events: [sendgridEvent(workspaceId, campaignId, sendId, { event: "dropped", reason: "Unsubscribed Address" })],
    });

    expect((await contactState(workspaceId, contact.id)).subscriptionStatus).toBe("unsubscribed");
    expect(await suppressionRows(workspaceId, contact.email)).toHaveLength(0);
  });

  it("D-12: dropped with a technical reason causes NO status change", async () => {
    const workspaceId = await freshWorkspaceId("supp-drop-technical");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contact = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contact.id);

    await processWebhookEventBatch({
      workspaceId,
      events: [sendgridEvent(workspaceId, campaignId, sendId, { event: "dropped", reason: "Invalid SMTPAPI header" })],
    });

    expect((await contactState(workspaceId, contact.id)).subscriptionStatus).toBe("subscribed");
    expect(await suppressionRows(workspaceId, contact.email)).toHaveLength(0);
  });

  it("D-15/Pitfall 2: an event marked test='true' is stored is_test=true and produces zero suppression/counter side effects", async () => {
    const workspaceId = await freshWorkspaceId("supp-test-marker");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contact = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contact.id);

    const events = [
      {
        email: "hello@world.com",
        event: "bounce",
        type: "bounce",
        reason: "550 hard fail",
        sg_event_id: `sg-${randomUUID()}`,
        timestamp: 1_700_000_000,
        send_id: sendId,
        workspace_id: workspaceId,
        campaign_id: campaignId,
        test: "true",
      },
    ];

    const result = await processWebhookEventBatch({ workspaceId, events });
    expect(result.inserted).toBe(1);

    expect((await contactState(workspaceId, contact.id)).subscriptionStatus).toBe("subscribed");
    expect(await suppressionRows(workspaceId, contact.email)).toHaveLength(0);

    const isTest = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ isTest: boolean }>(
          `SELECT is_test as "isTest" FROM send_events WHERE workspace_id = $1 AND sg_event_id = $2`,
          [workspaceId, events[0].sg_event_id]
        );
        return rows[0]?.isTest;
      })
    );
    expect(isTest).toBe(true);
  });

  it("D-15: an event whose send_id resolves to no live send is stored but suppresses nothing", async () => {
    const workspaceId = await freshWorkspaceId("supp-orphan");
    const orphanSendId = randomUUID();

    const events = [
      {
        email: "hello@world.com",
        event: "bounce",
        type: "bounce",
        reason: "550 hard fail",
        sg_event_id: `sg-${randomUUID()}`,
        timestamp: 1_700_000_000,
        send_id: orphanSendId,
        workspace_id: workspaceId,
      },
    ];

    const result = await processWebhookEventBatch({ workspaceId, events });
    expect(result.inserted).toBe(1);

    const storedCount = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*)::text as count FROM send_events WHERE workspace_id = $1`,
          [workspaceId]
        );
        return Number(rows[0].count);
      })
    );
    expect(storedCount).toBe(1);

    const suppressionCount = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*)::text as count FROM workspace_suppressions WHERE workspace_id = $1`,
          [workspaceId]
        );
        return Number(rows[0].count);
      })
    );
    expect(suppressionCount).toBe(0);
  });
});
