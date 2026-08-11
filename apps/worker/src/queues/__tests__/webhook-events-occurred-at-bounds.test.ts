import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { writeIngressJournal } from "@mega-crm/db/src/webhooks/ingress-journal.js";
import { WEBHOOK_EVENTS_SCHEMA_VERSION } from "@mega-crm/shared-schemas";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { processWebhookEventBatch } from "../webhook-events.worker.js";
import { insertFixtureOrganization } from "../../test/failure-fixtures.js";

/**
 * Phase 13 (CMP-05, D-15, plan 13-04): proves an out-of-range or
 * structurally-broken provider `timestamp` is quarantined -- never routed
 * to a `send_events` partition, never moving a fact column, campaign
 * counter, or `workspace_daily_rollup` bucket -- while its batch-mates are
 * unaffected and a journaled all-quarantined batch still reaches
 * `ingress_journal.ingestion_completed_at`. Mirrors
 * webhook-events-idempotency.test.ts's ephemeral-database harness.
 */
describe("webhook-events worker: occurred_at bounding (CMP-05, D-15)", () => {
  let pool: Pool;

  const NOW_SECONDS = Math.floor(Date.now() / 1000);
  /** Well inside the [now-7d, now+5min] window. */
  const IN_RANGE_TIMESTAMP = NOW_SECONDS - 3600;
  /** 8 days before now -- one full day past the 7-day OCCURRED_AT_MAX_PAST_DAYS bound. */
  const TOO_OLD_TIMESTAMP = NOW_SECONDS - 8 * 24 * 60 * 60;

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

  function sendgridEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      email: "hello@fixture.test",
      event: "delivered",
      sg_event_id: `sg-${randomUUID()}`,
      sg_message_id: "abc.filterdrecv-x",
      timestamp: IN_RANGE_TIMESTAMP,
      ...overrides,
    };
  }

  async function createFixtureCampaign(workspaceId: string): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows: segmentRows } = await client.query<{ id: string }>(
          `INSERT INTO segments (workspace_id, name, definition, created_by_user_id)
           VALUES ($1, 'Bounds fixture segment', $2, 'test-user') RETURNING id`,
          [workspaceId, { operator: "and", conditions: [] }]
        );
        const { rows: campaignRows } = await client.query<{ id: string }>(
          `INSERT INTO campaigns (workspace_id, name, status, segment_id, template_id, from_email, created_by_user_id)
           VALUES ($1, 'Bounds fixture campaign', 'sent', $2, 'd-fixture-template', 'sender@fixture.test', 'test-user')
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

  interface QuarantineRow {
    sgEventId: string | null;
    eventType: string | null;
    reason: string;
    occurredAtCandidate: string | null;
  }

  async function quarantineRows(workspaceId: string): Promise<QuarantineRow[]> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<QuarantineRow>(
          `SELECT sg_event_id as "sgEventId", event_type as "eventType", reason,
                  occurred_at_candidate as "occurredAtCandidate"
           FROM send_event_quarantine WHERE workspace_id = $1`,
          [workspaceId]
        );
        return rows;
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

  async function seedJournalRow(workspaceId: string, events: unknown[]): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction((client) => writeIngressJournal(client, workspaceId, events))
    );
  }

  async function journalCompletedAt(workspaceId: string, journalId: string): Promise<Date | null> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ ingestionCompletedAt: Date | null }>(
          `SELECT ingestion_completed_at as "ingestionCompletedAt" FROM ingress_journal WHERE id = $1`,
          [journalId]
        );
        return rows[0]?.ingestionCompletedAt ?? null;
      })
    );
  }

  it("a batch of three events with one 8-day-old timestamp inserts exactly two send_events rows and writes exactly one quarantine row", async () => {
    const workspaceId = await freshWorkspaceId("bounds-mixed");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);

    const goodEvent1 = sendgridEvent();
    const badEvent = sendgridEvent({ timestamp: TOO_OLD_TIMESTAMP, send_id: sendId });
    const goodEvent2 = sendgridEvent();

    const result = await processWebhookEventBatch({
      workspaceId,
      events: [goodEvent1, badEvent, goodEvent2],
    });

    expect(result.inserted).toBe(2);
    expect(await countSendEvents(workspaceId)).toBe(2);

    const quarantined = await quarantineRows(workspaceId);
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0].reason).toBe("too_old");
    expect(quarantined[0].occurredAtCandidate).toBe(String(TOO_OLD_TIMESTAMP));
  });

  it("the out-of-range event's sends row has all fact columns still null, and it moves no campaign counter or rollup bucket", async () => {
    const workspaceId = await freshWorkspaceId("bounds-no-side-effects");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);

    const badEvent = sendgridEvent({ timestamp: TOO_OLD_TIMESTAMP, send_id: sendId, campaign_id: campaignId });

    const result = await processWebhookEventBatch({ workspaceId, events: [badEvent] });

    expect(result.inserted).toBe(0);
    expect(await sendDeliveredAt(workspaceId, sendId)).toBeNull();
    expect(await campaignDeliveredCount(workspaceId, campaignId)).toBe(0);
    expect(await rollupRowCount(workspaceId)).toBe(0);
  });

  it("processWebhookEventBatch resolves (not rejects) for a batch whose every event is out of range, reporting inserted: 0", async () => {
    const workspaceId = await freshWorkspaceId("bounds-all-out-of-range");
    const events = [sendgridEvent({ timestamp: TOO_OLD_TIMESTAMP }), sendgridEvent({ timestamp: TOO_OLD_TIMESTAMP })];

    await expect(processWebhookEventBatch({ workspaceId, events })).resolves.toEqual({ inserted: 0 });
    expect(await countSendEvents(workspaceId)).toBe(0);
    expect(await quarantineRows(workspaceId)).toHaveLength(2);
  });

  it("a journaled batch whose every event is quarantined leaves ingress_journal.ingestion_completed_at non-null", async () => {
    const workspaceId = await freshWorkspaceId("bounds-journal-all-quarantined");
    const event = sendgridEvent({ timestamp: TOO_OLD_TIMESTAMP });
    const journalId = await seedJournalRow(workspaceId, [event]);
    expect(await journalCompletedAt(workspaceId, journalId)).toBeNull();

    const result = await processWebhookEventBatch({
      workspaceId,
      events: [event],
      schemaVersion: WEBHOOK_EVENTS_SCHEMA_VERSION,
      journalId,
    });

    expect(result.inserted).toBe(0);
    expect(await journalCompletedAt(workspaceId, journalId)).not.toBeNull();
  });

  it("an event with a usable sg_event_id and a non-numeric timestamp yields one quarantine row naming the structural failure, and no send_events row", async () => {
    const workspaceId = await freshWorkspaceId("bounds-unusable");
    const badEvent = sendgridEvent({ timestamp: "nope" });

    const result = await processWebhookEventBatch({ workspaceId, events: [badEvent] });

    expect(result.inserted).toBe(0);
    expect(await countSendEvents(workspaceId)).toBe(0);

    const quarantined = await quarantineRows(workspaceId);
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0].reason).toBe("non_finite");
    expect(quarantined[0].occurredAtCandidate).toBe("nope");
  });

  it("an event with no usable sg_event_id produces neither a send_events row nor a quarantine row", async () => {
    const workspaceId = await freshWorkspaceId("bounds-no-sg-event-id");
    const badEvent = { email: "hello@fixture.test", event: "delivered", timestamp: TOO_OLD_TIMESTAMP };

    const result = await processWebhookEventBatch({ workspaceId, events: [badEvent] });

    expect(result.inserted).toBe(0);
    expect(await countSendEvents(workspaceId)).toBe(0);
    expect(await quarantineRows(workspaceId)).toHaveLength(0);
  });

  it("an in-range event immediately following an out-of-range event in the same batch is inserted with full normal side effects", async () => {
    const workspaceId = await freshWorkspaceId("bounds-in-range-after-bad");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);

    const badEvent = sendgridEvent({ timestamp: TOO_OLD_TIMESTAMP });
    const goodEvent = sendgridEvent({ send_id: sendId, campaign_id: campaignId });

    const result = await processWebhookEventBatch({ workspaceId, events: [badEvent, goodEvent] });

    expect(result.inserted).toBe(1);
    expect(await sendDeliveredAt(workspaceId, sendId)).not.toBeNull();
    expect(await campaignDeliveredCount(workspaceId, campaignId)).toBe(1);
  });

  it("a well-formed timestamp too far in the future is quarantined with reason too_far_future", async () => {
    const workspaceId = await freshWorkspaceId("bounds-too-far-future");
    const badEvent = sendgridEvent({ timestamp: NOW_SECONDS + 3600 });

    const result = await processWebhookEventBatch({ workspaceId, events: [badEvent] });

    expect(result.inserted).toBe(0);
    const quarantined = await quarantineRows(workspaceId);
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0].reason).toBe("too_far_future");
  });
});
