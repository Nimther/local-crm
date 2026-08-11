import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { processWebhookEventBatch } from "../webhook-events.worker.js";
import { insertFixtureOrganization } from "../../test/failure-fixtures.js";

/**
 * 05-13 (gap-closure, WBHK-04/SUBS-02/WBHK-02): replays the VERBATIM shape
 * SendGrid's Event Webhook actually posts -- `send_id`/`workspace_id`/
 * `campaign_id` as TOP-LEVEL event fields, with no nested mail/send-arg
 * wrapper -- through the real `processWebhookEventBatch` worker entrypoint.
 * This is the shape confirmed against live UAT payloads in
 * .planning/debug/campaign-metrics-zero-despite-events.md; every sibling
 * webhook-events-*.test.ts suite previously encoded the wrong nested shape,
 * which is why the attribution bug survived until live UAT.
 */
describe("webhook-events worker: real flattened SendGrid payload attribution (WBHK-04, WBHK-02, SUBS-02)", () => {
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

  // segments/campaigns/contacts/sends/send_events all carry ENABLE + FORCE
  // ROW LEVEL SECURITY -- every fixture insert/read MUST run inside
  // withTenant/withTenantTransaction.
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

  async function sendFacts(
    workspaceId: string,
    sendId: string
  ): Promise<{ deliveredAt: Date | null; firstOpenedAt: Date | null }> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ deliveredAt: Date | null; firstOpenedAt: Date | null }>(
          `SELECT delivered_at as "deliveredAt", first_opened_at as "firstOpenedAt" FROM sends WHERE id = $1`,
          [sendId]
        );
        return rows[0];
      })
    );
  }

  async function campaignCounters(
    workspaceId: string,
    campaignId: string
  ): Promise<{ deliveredCount: number; openedCount: number }> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ deliveredCount: number; openedCount: number }>(
          `SELECT delivered_count as "deliveredCount", opened_count as "openedCount" FROM campaigns WHERE id = $1`,
          [campaignId]
        );
        return rows[0];
      })
    );
  }

  async function sendEventSendId(workspaceId: string, sgEventId: string): Promise<string | null> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ sendId: string | null }>(
          `SELECT send_id as "sendId" FROM send_events WHERE workspace_id = $1 AND sg_event_id = $2`,
          [workspaceId, sgEventId]
        );
        return rows[0]?.sendId ?? null;
      })
    );
  }

  /**
   * The VERBATIM shape SendGrid's Event Webhook posts (confirmed against
   * live UAT payloads): `send_id`/`workspace_id`/`campaign_id` sit at the
   * event object's TOP LEVEL. There is NO nested mail/send-arg wrapper --
   * that absence is the whole point of this fixture.
   */
  function flattenedSendgridEvent(
    workspaceId: string,
    campaignId: string,
    sendId: string,
    overrides: Record<string, unknown> = {}
  ): Record<string, unknown> {
    return {
      email: "hello@fixture.test",
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

  it("a flattened delivered payload attributes send_id and increments the campaign delivered counter", async () => {
    const workspaceId = await freshWorkspaceId("attr-delivered");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);

    const events = [flattenedSendgridEvent(workspaceId, campaignId, sendId, { event: "delivered" })];
    const result = await processWebhookEventBatch({ workspaceId, events });

    expect(result.inserted).toBe(1);
    const facts = await sendFacts(workspaceId, sendId);
    expect(facts.deliveredAt).not.toBeNull();
    expect((await campaignCounters(workspaceId, campaignId)).deliveredCount).toBe(1);
  });

  it("a flattened open payload increments the opened counter", async () => {
    const workspaceId = await freshWorkspaceId("attr-open");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);

    const events = [flattenedSendgridEvent(workspaceId, campaignId, sendId, { event: "open" })];
    await processWebhookEventBatch({ workspaceId, events });

    const facts = await sendFacts(workspaceId, sendId);
    expect(facts.firstOpenedAt).not.toBeNull();
    expect((await campaignCounters(workspaceId, campaignId)).openedCount).toBe(1);
  });

  it("the stored send_events row records the resolved send_id (not null) for a flattened payload", async () => {
    const workspaceId = await freshWorkspaceId("attr-send-events-row");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);

    const event = flattenedSendgridEvent(workspaceId, campaignId, sendId, { event: "delivered" });
    await processWebhookEventBatch({ workspaceId, events: [event] });

    const storedSendId = await sendEventSendId(workspaceId, event.sg_event_id as string);
    expect(storedSendId).toBe(sendId);
  });
});
