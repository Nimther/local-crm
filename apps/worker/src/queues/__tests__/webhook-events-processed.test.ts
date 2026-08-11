import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { getScanTestDatabaseUrl } from "@mega-crm/test-support";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { processWebhookEventBatch } from "../webhook-events.worker.js";
import { runReconcilerTick } from "../send-reconciler.worker.js";
import { insertFixtureOrganization } from "../../test/failure-fixtures.js";

/**
 * Phase 11 (D-06, 11-07): SendGrid's `processed` event is now provisioned
 * (sendgrid-webhook-provision.ts, 11-07 Task 1), so it will start arriving
 * through this same ingestion path. This suite proves the ONLY change that
 * matters for correctness -- `processed` produces evidence and NOTHING
 * else. No production code in this plan changes `normalizeEventType`
 * (packages/delivery-core/src/event-normalize.ts) or
 * `webhook-events.worker.ts`'s raw-insert-then-conditional-side-effects
 * ordering: `normalizeEventType({ event: "processed" })` already returns
 * `null` (out of WBHK-02 scope, by design, unchanged), and the raw
 * `send_events` INSERT already runs for every event in a batch BEFORE the
 * per-row `normalizedType === null` skip that gates side effects
 * (webhook-events.worker.ts's `processWebhookEventBatch`, second loop) --
 * that ordering is exactly why evidence lands even though `processed` drives
 * no fact-column write. If a future change gives `processed` a normalized
 * type or a fact column, the "status/facts/counters unchanged" assertions
 * below fail, forcing that decision to be made deliberately rather than by
 * accident.
 */
describe("webhook-events worker: processed event is evidence-only (D-06, 11-07)", () => {
  let pool: Pool;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    process.env.SCAN_DATABASE_URL = getScanTestDatabaseUrl();
    pool = createTestPool();
  });

  afterAll(async () => {
    await pool.end();
  });

  // 10-09 (SEC-05): delegates to the mega_crm_auth-backed INSERT in
  // failure-fixtures.ts instead of duplicating it -- mega_crm_app holds only
  // SELECT on organization post-migration-0045.
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

  /** `status` defaults to 'sent' (the common case a `processed` event arrives against); callers needing 'reconciling' pass it explicitly. */
  async function createFixtureSend(
    workspaceId: string,
    campaignId: string,
    contactId: string,
    status: string = "sent"
  ): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO sends (workspace_id, campaign_id, contact_id, kind, status, sent_at)
           VALUES ($1, $2, $3, 'campaign', $4::send_status, CASE WHEN $4::send_status = 'sent' THEN now() ELSE NULL END)
           RETURNING id`,
          [workspaceId, campaignId, contactId, status]
        );
        return rows[0].id;
      })
    );
  }

  interface SendRow {
    status: string;
    deliveredAt: Date | null;
    firstOpenedAt: Date | null;
    firstClickedAt: Date | null;
    bouncedAt: Date | null;
    droppedAt: Date | null;
    unsubscribedAt: Date | null;
    spamReportedAt: Date | null;
    openCount: number;
    clickCount: number;
  }

  async function sendRow(workspaceId: string, sendId: string): Promise<SendRow | undefined> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<SendRow>(
          `SELECT status,
                  delivered_at as "deliveredAt",
                  first_opened_at as "firstOpenedAt",
                  first_clicked_at as "firstClickedAt",
                  bounced_at as "bouncedAt",
                  dropped_at as "droppedAt",
                  unsubscribed_at as "unsubscribedAt",
                  spam_reported_at as "spamReportedAt",
                  open_count as "openCount",
                  click_count as "clickCount"
           FROM sends WHERE id = $1`,
          [sendId]
        );
        return rows[0];
      })
    );
  }

  async function processedEventCount(workspaceId: string, sendId: string): Promise<number> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*)::text as count FROM send_events WHERE workspace_id = $1 AND send_id = $2 AND event_type = 'processed'`,
          [workspaceId, sendId]
        );
        return Number(rows[0].count);
      })
    );
  }

  async function suppressionsCount(workspaceId: string): Promise<number> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*)::text as count FROM workspace_suppressions WHERE workspace_id = $1`,
          [workspaceId]
        );
        return Number(rows[0].count);
      })
    );
  }

  async function subscriptionHistoryCount(workspaceId: string, contactId: string): Promise<number> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*)::text as count FROM subscription_status_history WHERE workspace_id = $1 AND contact_id = $2`,
          [workspaceId, contactId]
        );
        return Number(rows[0].count);
      })
    );
  }

  // Phase 13 (CMP-05, plan 13-04): a fixed 2023-era timestamp is now OLD
  // ENOUGH to fall outside classifyOccurredAt's [now-7d, now+5min] window and
  // get quarantined instead of inserted.
  const FIXED_TIMESTAMP = Math.floor(Date.now() / 1000) - 3600;

  // Real SendGrid `processed` events flatten custom_args directly onto the
  // event object's TOP LEVEL, same shape as every other event type
  // (webhook-events-attribution.test.ts's fixture, same convention here).
  function processedEvent(
    workspaceId: string,
    campaignId: string | null,
    sendId: string | null,
    overrides: Record<string, unknown> = {}
  ): Record<string, unknown> {
    return {
      email: "hello@fixture.test",
      event: "processed",
      sg_event_id: `sg-${randomUUID()}`,
      sg_message_id: "abc.filterdrecv-x",
      timestamp: FIXED_TIMESTAMP,
      send_id: sendId,
      workspace_id: workspaceId,
      campaign_id: campaignId,
      ...overrides,
    };
  }

  it("inserts one send_events row with event_type='processed' and a non-null send_id, leaves sends.status unchanged", async () => {
    const workspaceId = await freshWorkspaceId("proc-basic");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId, "sent");

    const before = await sendRow(workspaceId, sendId);
    expect(before?.status).toBe("sent");

    const result = await processWebhookEventBatch({
      workspaceId,
      events: [processedEvent(workspaceId, campaignId, sendId)],
    });

    expect(result.inserted).toBe(1);
    expect(await processedEventCount(workspaceId, sendId)).toBe(1);

    const after = await sendRow(workspaceId, sendId);
    expect(after?.status, "processed ingestion must never move sends.status").toBe(before?.status);
  });

  it("leaves every delivery fact column null and both repeat counters at zero", async () => {
    const workspaceId = await freshWorkspaceId("proc-facts");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId, "sent");

    await processWebhookEventBatch({
      workspaceId,
      events: [processedEvent(workspaceId, campaignId, sendId)],
    });

    const row = await sendRow(workspaceId, sendId);
    expect(row?.deliveredAt).toBeNull();
    expect(row?.firstOpenedAt).toBeNull();
    expect(row?.firstClickedAt).toBeNull();
    expect(row?.bouncedAt).toBeNull();
    expect(row?.droppedAt).toBeNull();
    expect(row?.unsubscribedAt).toBeNull();
    expect(row?.spamReportedAt).toBeNull();
    expect(row?.openCount).toBe(0);
    expect(row?.clickCount).toBe(0);
  });

  it("creates no suppressions row and no subscription_status_history row", async () => {
    const workspaceId = await freshWorkspaceId("proc-no-suppression");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId, "sent");

    await processWebhookEventBatch({
      workspaceId,
      events: [processedEvent(workspaceId, campaignId, sendId)],
    });

    expect(await suppressionsCount(workspaceId)).toBe(0);
    expect(await subscriptionHistoryCount(workspaceId, contactId)).toBe(0);
  });

  it("replaying the identical batch inserts no second send_events row (existing dedup key holds for processed too)", async () => {
    const workspaceId = await freshWorkspaceId("proc-replay");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId, "sent");

    const events = [processedEvent(workspaceId, campaignId, sendId)];

    const first = await processWebhookEventBatch({ workspaceId, events });
    expect(first.inserted).toBe(1);
    expect(await processedEventCount(workspaceId, sendId)).toBe(1);

    const replay = await processWebhookEventBatch({ workspaceId, events });
    expect(replay.inserted).toBe(0);
    expect(await processedEventCount(workspaceId, sendId)).toBe(1);
  });

  it("a processed event whose custom_args.send_id matches no row is still stored, with a null send_id, and throws nothing", async () => {
    const workspaceId = await freshWorkspaceId("proc-orphan");
    const unmatchedSendId = randomUUID();

    const result = await processWebhookEventBatch({
      workspaceId,
      events: [processedEvent(workspaceId, null, unmatchedSendId)],
    });

    expect(result.inserted).toBe(1);

    const storedSendId = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ sendId: string | null }>(
          `SELECT send_id as "sendId" FROM send_events WHERE workspace_id = $1 AND event_type = 'processed'`,
          [workspaceId]
        );
        return rows[0]?.sendId ?? null;
      })
    );
    expect(storedSendId).toBeNull();
  });

  it("after a processed row exists for a send in reconciling, one runReconcilerTick() resolves that send to sent -- the seam between evidence arriving and the reconciler acting on it", async () => {
    const workspaceId = await freshWorkspaceId("proc-reconciler-seam");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId, "reconciling");

    const before = await sendRow(workspaceId, sendId);
    expect(before?.status).toBe("reconciling");

    await processWebhookEventBatch({
      workspaceId,
      events: [processedEvent(workspaceId, campaignId, sendId)],
    });

    // Evidence lands, but status is still untouched by the ingestion path
    // itself -- only the reconciler, on its own tick, may leave reconciling.
    const afterIngest = await sendRow(workspaceId, sendId);
    expect(afterIngest?.status).toBe("reconciling");

    const tick = await runReconcilerTick();
    expect(tick.resolvedSent).toBeGreaterThanOrEqual(1);

    const afterTick = await sendRow(workspaceId, sendId);
    expect(afterTick?.status).toBe("sent");
  });
});
