import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { processWebhookEventBatch } from "../webhook-events.worker.js";

/**
 * Phase 10 (SEC-09, WR-01): with one BYO SendGrid key backing several
 * workspaces, a single webhook delivery can carry events for more than one
 * workspace. This suite proves the per-event ownership resolution added to
 * `processWebhookEventBatch`: the receiving workspace's own events persist,
 * a sibling workspace's events are dropped (not redirected, not stored
 * anywhere) without failing the rest of the batch, the drop is signalled
 * with workspace ids and a count only (never the sibling's payload content),
 * and the pre-existing D-15 orphan behaviour (a `send_id` that exists in NO
 * workspace) is unchanged.
 */
describe("webhook-events worker: sibling-workspace event drop (SEC-09, WR-01)", () => {
  let pool: Pool;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    pool = createTestPool();
  });

  afterAll(async () => {
    await pool.end();
  });

  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  async function freshWorkspaceId(nameSeed: string): Promise<string> {
    const slug = `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO organization (name, slug) VALUES ($1, $2) RETURNING id`,
      [`${nameSeed} Co`, slug]
    );
    return rows[0].id;
  }

  // segments/campaigns/contacts/sends/send_events all carry ENABLE + FORCE
  // ROW LEVEL SECURITY -- every fixture insert/read MUST run inside
  // withTenant/withTenantTransaction.
  async function createFixtureCampaign(workspaceId: string): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows: segmentRows } = await client.query<{ id: string }>(
          `INSERT INTO segments (workspace_id, name, definition, created_by_user_id)
           VALUES ($1, 'Sibling-drop fixture segment', $2, 'test-user') RETURNING id`,
          [workspaceId, { operator: "and", conditions: [] }]
        );
        const { rows: campaignRows } = await client.query<{ id: string }>(
          `INSERT INTO campaigns (workspace_id, name, status, segment_id, template_id, from_email, created_by_user_id)
           VALUES ($1, 'Sibling-drop fixture campaign', 'sent', $2, 'd-fixture-template', 'sender@fixture.test', 'test-user')
           RETURNING id`,
          [workspaceId, segmentRows[0].id]
        );
        return campaignRows[0].id;
      })
    );
  }

  async function createFixtureContact(workspaceId: string, email?: string): Promise<string> {
    const resolvedEmail = email ?? `contact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@fixture.test`;
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO contacts (workspace_id, email, first_name, subscription_status)
           VALUES ($1, $2, 'Fixture', 'subscribed') RETURNING id`,
          [workspaceId, resolvedEmail]
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

  async function sendEventSendIds(workspaceId: string): Promise<Array<string | null>> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ sendId: string | null }>(
          `SELECT send_id as "sendId" FROM send_events WHERE workspace_id = $1 ORDER BY received_at`,
          [workspaceId]
        );
        return rows.map((r) => r.sendId);
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

  /** The VERBATIM flattened shape SendGrid's Event Webhook posts (05-13). */
  function flattenedSendgridEvent(
    workspaceId: string,
    sendId: string | undefined,
    overrides: Record<string, unknown> = {}
  ): Record<string, unknown> {
    return {
      email: "hello@fixture.test",
      event: "delivered",
      sg_event_id: `sg-${randomUUID()}`,
      sg_message_id: "abc.filterdrecv-x",
      timestamp: 1_700_000_000,
      workspace_id: workspaceId,
      ...(sendId !== undefined ? { send_id: sendId } : {}),
      ...overrides,
    };
  }

  it("Test 1: a mixed batch persists the receiving workspace's own event and the orphan, and discards the sibling's", async () => {
    const receivingWorkspaceId = await freshWorkspaceId("sib-recv");
    const siblingWorkspaceId = await freshWorkspaceId("sib-sibling");

    const receivingCampaignId = await createFixtureCampaign(receivingWorkspaceId);
    const receivingContactId = await createFixtureContact(receivingWorkspaceId);
    const receivingSendId = await createFixtureSend(receivingWorkspaceId, receivingCampaignId, receivingContactId);

    const siblingCampaignId = await createFixtureCampaign(siblingWorkspaceId);
    const siblingContactId = await createFixtureContact(siblingWorkspaceId);
    const siblingSendId = await createFixtureSend(siblingWorkspaceId, siblingCampaignId, siblingContactId);

    const ownEvent = flattenedSendgridEvent(receivingWorkspaceId, receivingSendId);
    const siblingEvent = flattenedSendgridEvent(receivingWorkspaceId, siblingSendId);
    const orphanEvent = flattenedSendgridEvent(receivingWorkspaceId, undefined);

    const result = await processWebhookEventBatch({
      workspaceId: receivingWorkspaceId,
      events: [ownEvent, siblingEvent, orphanEvent],
    });

    expect(result.inserted).toBe(2);
    expect(await countSendEvents(receivingWorkspaceId)).toBe(2);

    const storedSendIds = await sendEventSendIds(receivingWorkspaceId);
    expect(storedSendIds).toContain(receivingSendId);
    expect(storedSendIds).not.toContain(siblingSendId);
    expect(storedSendIds).toContain(null);
  });

  it("Test 2: the sibling workspace's own send_events is unchanged -- the dropped event is discarded, not redirected", async () => {
    const receivingWorkspaceId = await freshWorkspaceId("sib-recv2");
    const siblingWorkspaceId = await freshWorkspaceId("sib-sibling2");

    const siblingCampaignId = await createFixtureCampaign(siblingWorkspaceId);
    const siblingContactId = await createFixtureContact(siblingWorkspaceId);
    const siblingSendId = await createFixtureSend(siblingWorkspaceId, siblingCampaignId, siblingContactId);

    expect(await countSendEvents(siblingWorkspaceId)).toBe(0);

    const siblingEvent = flattenedSendgridEvent(receivingWorkspaceId, siblingSendId);
    await processWebhookEventBatch({ workspaceId: receivingWorkspaceId, events: [siblingEvent] });

    expect(await countSendEvents(siblingWorkspaceId)).toBe(0);
  });

  it("Test 3: one sibling event does not fail the batch -- the receiving workspace's own side effects still apply", async () => {
    const receivingWorkspaceId = await freshWorkspaceId("sib-recv3");
    const siblingWorkspaceId = await freshWorkspaceId("sib-sibling3");

    const receivingCampaignId = await createFixtureCampaign(receivingWorkspaceId);
    const receivingContactId = await createFixtureContact(receivingWorkspaceId);
    const receivingSendId = await createFixtureSend(receivingWorkspaceId, receivingCampaignId, receivingContactId);

    const siblingCampaignId = await createFixtureCampaign(siblingWorkspaceId);
    const siblingContactId = await createFixtureContact(siblingWorkspaceId);
    const siblingSendId = await createFixtureSend(siblingWorkspaceId, siblingCampaignId, siblingContactId);

    const ownEvent = flattenedSendgridEvent(receivingWorkspaceId, receivingSendId, { event: "delivered" });
    const siblingEvent = flattenedSendgridEvent(receivingWorkspaceId, siblingSendId, { event: "delivered" });

    const result = await processWebhookEventBatch({
      workspaceId: receivingWorkspaceId,
      events: [ownEvent, siblingEvent],
    });

    expect(result.inserted).toBe(1);
    expect(await sendDeliveredAt(receivingWorkspaceId, receivingSendId)).not.toBeNull();
    expect(await campaignDeliveredCount(receivingWorkspaceId, receivingCampaignId)).toBe(1);
  });

  it("Test 4: the drop signal carries only workspace ids and a count -- no sibling email, payload marker, or send_id", async () => {
    const receivingWorkspaceId = await freshWorkspaceId("sib-recv4");
    const siblingWorkspaceId = await freshWorkspaceId("sib-sibling4");

    const siblingCampaignId = await createFixtureCampaign(siblingWorkspaceId);
    const siblingDistinctiveEmail = `sibling-secret-${randomUUID()}@do-not-leak.test`;
    const siblingContactId = await createFixtureContact(siblingWorkspaceId, siblingDistinctiveEmail);
    const siblingSendId = await createFixtureSend(siblingWorkspaceId, siblingCampaignId, siblingContactId);

    const distinctivePayloadMarker = `sibling-payload-marker-${randomUUID()}`;
    const siblingEvent = flattenedSendgridEvent(receivingWorkspaceId, siblingSendId, {
      email: siblingDistinctiveEmail,
      distinctive_marker: distinctivePayloadMarker,
    });

    consoleLogSpy.mockClear();
    await processWebhookEventBatch({ workspaceId: receivingWorkspaceId, events: [siblingEvent] });

    const dropCalls = consoleLogSpy.mock.calls.filter(
      (call: unknown[]) => call[0] === "webhook.sibling_workspace_event_dropped"
    );
    expect(dropCalls.length).toBe(1);

    const [eventName, payload] = dropCalls[0] as [string, Record<string, unknown>];
    expect(eventName).toBe("webhook.sibling_workspace_event_dropped");
    expect(Object.keys(payload).sort()).toEqual(["count", "owningWorkspaceId", "receivingWorkspaceId"]);
    expect(payload.receivingWorkspaceId).toBe(receivingWorkspaceId);
    expect(payload.owningWorkspaceId).toBe(siblingWorkspaceId);
    expect(payload.count).toBe(1);

    const serialized = JSON.stringify(dropCalls);
    expect(serialized).not.toContain(siblingDistinctiveEmail);
    expect(serialized).not.toContain(distinctivePayloadMarker);
    expect(serialized).not.toContain(siblingSendId);
  });

  it("Test 5: an event whose send_id exists in no workspace at all is still stored with a null send_id and no side effects (D-15 unchanged)", async () => {
    const receivingWorkspaceId = await freshWorkspaceId("sib-recv5");
    const nonExistentSendId = randomUUID();

    const orphanEvent = flattenedSendgridEvent(receivingWorkspaceId, nonExistentSendId, { event: "delivered" });
    const result = await processWebhookEventBatch({ workspaceId: receivingWorkspaceId, events: [orphanEvent] });

    expect(result.inserted).toBe(1);
    const storedSendIds = await sendEventSendIds(receivingWorkspaceId);
    expect(storedSendIds).toEqual([null]);
  });

  it("Test 6: a batch with no send_id values performs no cross-workspace lookup -- succeeds even with SCAN_DATABASE_URL removed", async () => {
    const receivingWorkspaceId = await freshWorkspaceId("sib-recv6");
    const savedScanDsn = process.env.SCAN_DATABASE_URL;
    delete process.env.SCAN_DATABASE_URL;

    try {
      const event = flattenedSendgridEvent(receivingWorkspaceId, undefined, { event: "delivered" });
      const result = await processWebhookEventBatch({ workspaceId: receivingWorkspaceId, events: [event] });

      expect(result.inserted).toBe(1);
      const storedSendIds = await sendEventSendIds(receivingWorkspaceId);
      expect(storedSendIds).toEqual([null]);
    } finally {
      if (savedScanDsn !== undefined) process.env.SCAN_DATABASE_URL = savedScanDsn;
    }
  });
});
