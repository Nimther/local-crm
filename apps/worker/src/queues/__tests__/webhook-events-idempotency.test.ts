import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { processWebhookEventBatch } from "../webhook-events.worker.js";
import { insertFixtureOrganization } from "../../test/failure-fixtures.js";

/**
 * webhook-events job-processing handler (WBHK-03, D-14): invokes
 * `processWebhookEventBatch` directly with a crafted job payload -- no live
 * BullMQ Queue/Redis round-trip needed, since the handler is exported
 * standalone precisely so this test can call it in isolation (mirrors
 * events-ingest-idempotency.test.ts's `processEventIngestJob` precedent).
 * Verification reads against `send_events` MUST run inside
 * `withTenant`/`withTenantTransaction` -- the table carries
 * ENABLE + FORCE ROW LEVEL SECURITY.
 */
describe("webhook-events worker (WBHK-03, D-14)", () => {
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

  // Phase 13 (CMP-05, plan 13-04): a fixed 2023-era timestamp is now OLD
  // ENOUGH to fall outside classifyOccurredAt's [now-7d, now+5min] window and
  // get quarantined instead of inserted -- module-scoped so every replay call
  // in this file reuses the identical value (dedup determinism preserved).
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

  // segments/campaigns/contacts/sends all carry ENABLE + FORCE ROW LEVEL
  // SECURITY -- fixture inserts MUST run inside withTenant/withTenantTransaction
  // (05-03: side-effect exactly-once-on-replay fixtures).
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

  async function sendDeliveredAt(workspaceId: string, sendId: string): Promise<Date | null> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ deliveredAt: Date | null }>(
          `SELECT delivered_at as "deliveredAt" FROM sends WHERE id = $1`,
          [sendId]
        );
        return rows[0]?.deliveredAt ?? null;
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

  it("inserts N rows for a fresh batch of N distinct sg_event_ids, RETURNING yields N", async () => {
    const workspaceId = await freshWorkspaceId("wh-fresh");
    const events = [sendgridEvent(), sendgridEvent(), sendgridEvent()];

    const result = await processWebhookEventBatch({ workspaceId, events });

    expect(result.inserted).toBe(3);
    expect(await countSendEvents(workspaceId)).toBe(3);
  });

  it("WBHK-03: a replayed identical batch inserts zero additional rows", async () => {
    const workspaceId = await freshWorkspaceId("wh-replay");
    const events = [sendgridEvent(), sendgridEvent()];

    const first = await processWebhookEventBatch({ workspaceId, events });
    expect(first.inserted).toBe(2);

    const replay = await processWebhookEventBatch({ workspaceId, events });
    expect(replay.inserted).toBe(0);
    expect(await countSendEvents(workspaceId)).toBe(2);
  });

  it("a batch mixing 2 already-seen and 3 new sg_event_ids inserts exactly the 3 new rows", async () => {
    const workspaceId = await freshWorkspaceId("wh-mixed");
    const seen = [sendgridEvent(), sendgridEvent()];
    await processWebhookEventBatch({ workspaceId, events: seen });

    const fresh = [sendgridEvent(), sendgridEvent(), sendgridEvent()];
    const mixedResult = await processWebhookEventBatch({ workspaceId, events: [...seen, ...fresh] });

    expect(mixedResult.inserted).toBe(3);
    expect(await countSendEvents(workspaceId)).toBe(5);
  });

  it("every write is tenant-scoped: two workspaces never see each other's rows", async () => {
    const workspaceA = await freshWorkspaceId("wh-tenant-a");
    const workspaceB = await freshWorkspaceId("wh-tenant-b");

    await processWebhookEventBatch({ workspaceId: workspaceA, events: [sendgridEvent()] });
    await processWebhookEventBatch({ workspaceId: workspaceB, events: [sendgridEvent(), sendgridEvent()] });

    expect(await countSendEvents(workspaceA)).toBe(1);
    expect(await countSendEvents(workspaceB)).toBe(2);
  });

  it("an event with a missing/blank sg_event_id is skipped, not crashing the batch", async () => {
    const workspaceId = await freshWorkspaceId("wh-blank-id");
    const events = [
      sendgridEvent(),
      sendgridEvent({ sg_event_id: "" }),
      { ...sendgridEvent(), sg_event_id: undefined },
      sendgridEvent(),
    ];

    const result = await processWebhookEventBatch({ workspaceId, events });

    expect(result.inserted).toBe(2);
    expect(await countSendEvents(workspaceId)).toBe(2);
  });

  it("WBHK-04/D-09: a replayed batch leaves the delivery fact and campaign counter unchanged (exactly-once side effects)", async () => {
    const workspaceId = await freshWorkspaceId("wh-replay-side-effects");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);

    const events = [
      sendgridEvent({
        send_id: sendId,
        workspace_id: workspaceId,
        campaign_id: campaignId,
      }),
    ];

    const first = await processWebhookEventBatch({ workspaceId, events });
    expect(first.inserted).toBe(1);
    const deliveredAtAfterFirst = await sendDeliveredAt(workspaceId, sendId);
    expect(deliveredAtAfterFirst).not.toBeNull();
    expect(await campaignDeliveredCount(workspaceId, campaignId)).toBe(1);

    // BullMQ at-least-once redelivery of the exact same batch.
    const replay = await processWebhookEventBatch({ workspaceId, events });
    expect(replay.inserted).toBe(0);

    expect((await sendDeliveredAt(workspaceId, sendId))?.toISOString()).toBe(deliveredAtAfterFirst?.toISOString());
    expect(await campaignDeliveredCount(workspaceId, campaignId), "delivered_count must not double-count on replay").toBe(1);
  });

  it("WBHK-03/D-09: a redelivered event with a missing/invalid timestamp does not double-insert or double-count", async () => {
    const workspaceId = await freshWorkspaceId("wh-bad-ts-replay");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);

    const events = [
      sendgridEvent({
        timestamp: undefined,
        send_id: sendId,
        workspace_id: workspaceId,
        campaign_id: campaignId,
      }),
    ];

    const first = await processWebhookEventBatch({ workspaceId, events });
    expect(first.inserted).toBe(0);

    const replay = await processWebhookEventBatch({ workspaceId, events });
    expect(replay.inserted).toBe(0);

    expect(await countSendEvents(workspaceId)).toBe(0);
    expect(await sendDeliveredAt(workspaceId, sendId)).toBeNull();
    expect(await campaignDeliveredCount(workspaceId, campaignId)).toBe(0);
  });

  it("an out-of-range numeric timestamp in one event does not fail the rest of the batch", async () => {
    const workspaceId = await freshWorkspaceId("wh-oob-ts");
    const events = [sendgridEvent(), sendgridEvent({ timestamp: 1e20 }), sendgridEvent()];

    await expect(processWebhookEventBatch({ workspaceId, events })).resolves.toEqual({ inserted: 2 });
    expect(await countSendEvents(workspaceId)).toBe(2);
  });
});
