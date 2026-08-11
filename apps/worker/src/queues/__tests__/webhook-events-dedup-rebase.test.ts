import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { processWebhookEventBatch } from "../webhook-events.worker.js";
import { insertFixtureOrganization } from "../../test/failure-fixtures.js";

/**
 * Phase 13 (CMP-07, plan 13-07), Task 3: proves the re-based dedup key
 * `(workspace_id, send_id, event_type, occurred_at)` closes the
 * vary-the-`sg_event_id` bypass Pitfall 14's second half describes, while
 * every other dedup guarantee `webhook-events-idempotency.test.ts` already
 * pins survives unchanged. This is the CONTRACT test for CMP-07 -- the
 * varying-`sg_event_id` case below MUST fail against the OLD key, so if it
 * ever passes before migration 0057 + this plan's `ON CONFLICT` swap are
 * both in place, the test itself is wrong.
 *
 * Mirrors `webhook-events-idempotency.test.ts`'s real-Postgres ephemeral-db
 * fixture convention exactly (same helpers, same shape) rather than
 * inventing a new one.
 */
describe("webhook-events worker: dedup rebase (CMP-07, plan 13-07)", () => {
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
    return insertFixtureOrganization(nameSeed);
  }

  // In-window per classifyOccurredAt's [now-7d, now+5min] bound (plan 13-04)
  // -- never a fixed 2023-era epoch.
  const FIXED_TIMESTAMP = Math.floor(Date.now() / 1000) - 3600;

  function sendgridEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      email: "hello@world.com",
      event: "delivered",
      sg_event_id: `sg-${randomUUID()}`,
      sg_message_id: "abc.filterdrecv-x",
      timestamp: FIXED_TIMESTAMP,
      ...overrides,
    };
  }

  async function countSendEvents(workspaceId: string): Promise<number> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*)::text as count FROM send_events WHERE workspace_id = $1`,
          [workspaceId]
        );
        return Number(rows[0].count);
      })
    );
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

  async function sendFacts(workspaceId: string, sendId: string): Promise<{ deliveredAt: Date | null; openCount: number }> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ deliveredAt: Date | null; openCount: number }>(
          `SELECT delivered_at as "deliveredAt", open_count as "openCount" FROM sends WHERE id = $1`,
          [sendId]
        );
        return rows[0];
      })
    );
  }

  async function campaignDeliveredCount(workspaceId: string, campaignId: string): Promise<number> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ deliveredCount: number }>(
          `SELECT delivered_count as "deliveredCount" FROM campaigns WHERE id = $1`,
          [campaignId]
        );
        return rows[0]?.deliveredCount ?? 0;
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

  const DAY = new Date(FIXED_TIMESTAMP * 1000).toISOString().slice(0, 10);

  it("CONTRACT: two occurrences of the same event carrying DIFFERENT sg_event_id values insert exactly one row, set the fact column once, and increment the campaign counter and rollup once", async () => {
    const workspaceId = await freshWorkspaceId("dedup-rebase-diff-sgid");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);

    const first = await processWebhookEventBatch({
      workspaceId,
      events: [sendgridEvent({ send_id: sendId, workspace_id: workspaceId, campaign_id: campaignId })],
    });
    expect(first.inserted).toBe(1);

    // A REDELIVERY carrying a DIFFERENT sg_event_id -- this is the exact
    // bypass the OLD key (workspace_id, sg_event_id, occurred_at) could not
    // catch, and the whole point of this plan.
    const redelivery = await processWebhookEventBatch({
      workspaceId,
      events: [sendgridEvent({ send_id: sendId, workspace_id: workspaceId, campaign_id: campaignId })],
    });
    expect(redelivery.inserted).toBe(0);

    expect(await countSendEvents(workspaceId)).toBe(1);
    expect((await sendFacts(workspaceId, sendId)).deliveredAt).not.toBeNull();
    expect(await campaignDeliveredCount(workspaceId, campaignId)).toBe(1);
    expect(await rollupDeliveredCount(workspaceId, DAY)).toBe(1);
  });

  it("processing the same event twice with the SAME sg_event_id still behaves identically (the previous guarantee is preserved)", async () => {
    const workspaceId = await freshWorkspaceId("dedup-rebase-same-sgid");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);

    const event = sendgridEvent({ send_id: sendId, workspace_id: workspaceId, campaign_id: campaignId });

    const first = await processWebhookEventBatch({ workspaceId, events: [event] });
    expect(first.inserted).toBe(1);

    const replay = await processWebhookEventBatch({ workspaceId, events: [event] });
    expect(replay.inserted).toBe(0);

    expect(await countSendEvents(workspaceId)).toBe(1);
    expect(await campaignDeliveredCount(workspaceId, campaignId)).toBe(1);
  });

  it("two genuinely different event types on the same send at the same second insert two rows and apply both sets of side effects", async () => {
    const workspaceId = await freshWorkspaceId("dedup-rebase-diff-type");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);

    const result = await processWebhookEventBatch({
      workspaceId,
      events: [
        sendgridEvent({ event: "delivered", send_id: sendId, workspace_id: workspaceId, campaign_id: campaignId }),
        sendgridEvent({ event: "open", send_id: sendId, workspace_id: workspaceId, campaign_id: campaignId }),
      ],
    });

    expect(result.inserted).toBe(2);
    expect(await countSendEvents(workspaceId)).toBe(2);
    const facts = await sendFacts(workspaceId, sendId);
    expect(facts.deliveredAt).not.toBeNull();
    expect(facts.openCount).toBe(1);
  });

  it("two events on DIFFERENT sends at the same second with the same type insert two rows", async () => {
    const workspaceId = await freshWorkspaceId("dedup-rebase-diff-send");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactA = await createFixtureContact(workspaceId);
    const contactB = await createFixtureContact(workspaceId);
    const sendA = await createFixtureSend(workspaceId, campaignId, contactA);
    const sendB = await createFixtureSend(workspaceId, campaignId, contactB);

    const result = await processWebhookEventBatch({
      workspaceId,
      events: [
        sendgridEvent({ send_id: sendA, workspace_id: workspaceId, campaign_id: campaignId }),
        sendgridEvent({ send_id: sendB, workspace_id: workspaceId, campaign_id: campaignId }),
      ],
    });

    expect(result.inserted).toBe(2);
    expect(await countSendEvents(workspaceId)).toBe(2);
  });

  it("two otherwise-identical orphan events (null send_id) insert two rows and move no counter (accepted trade-off: NULL is always distinct in a unique index)", async () => {
    const workspaceId = await freshWorkspaceId("dedup-rebase-orphan");

    const result = await processWebhookEventBatch({
      workspaceId,
      events: [sendgridEvent(), sendgridEvent()],
    });

    expect(result.inserted).toBe(2);
    expect(await countSendEvents(workspaceId)).toBe(2);
    expect(await rollupDeliveredCount(workspaceId, DAY)).toBe(0);
  });

  it("PINNED TRADE-OFF: two open events on the same send at the SAME second insert one row and increment open_count by exactly 1", async () => {
    const workspaceId = await freshWorkspaceId("dedup-rebase-open-same-second");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);

    await processWebhookEventBatch({
      workspaceId,
      events: [sendgridEvent({ event: "open", send_id: sendId, workspace_id: workspaceId, campaign_id: campaignId })],
    });
    const secondResult = await processWebhookEventBatch({
      workspaceId,
      events: [sendgridEvent({ event: "open", send_id: sendId, workspace_id: workspaceId, campaign_id: campaignId })],
    });

    // The second open shares (workspace_id, send_id, event_type='open',
    // occurred_at) with the first -- the new key rejects it as a duplicate,
    // it is NOT a genuinely-new row.
    expect(secondResult.inserted).toBe(0);
    expect(await countSendEvents(workspaceId)).toBe(1);
    expect((await sendFacts(workspaceId, sendId)).openCount).toBe(1);
  });

  it("PINNED TRADE-OFF: two open events on the same send ONE SECOND APART insert two rows and increment open_count by exactly 2", async () => {
    const workspaceId = await freshWorkspaceId("dedup-rebase-open-one-second-apart");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);

    await processWebhookEventBatch({
      workspaceId,
      events: [
        sendgridEvent({
          event: "open",
          send_id: sendId,
          workspace_id: workspaceId,
          campaign_id: campaignId,
          timestamp: FIXED_TIMESTAMP,
        }),
      ],
    });
    const secondResult = await processWebhookEventBatch({
      workspaceId,
      events: [
        sendgridEvent({
          event: "open",
          send_id: sendId,
          workspace_id: workspaceId,
          campaign_id: campaignId,
          timestamp: FIXED_TIMESTAMP + 1,
        }),
      ],
    });

    expect(secondResult.inserted).toBe(1);
    expect(await countSendEvents(workspaceId)).toBe(2);
    expect((await sendFacts(workspaceId, sendId)).openCount).toBe(2);
  });
});
