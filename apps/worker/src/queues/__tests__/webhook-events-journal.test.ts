import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { withCrossWorkspaceScan, withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { getScanTestDatabaseUrl } from "@mega-crm/test-support";
import { writeIngressJournal } from "@mega-crm/db/src/webhooks/ingress-journal.js";
import { WEBHOOK_EVENTS_SCHEMA_VERSION } from "@mega-crm/shared-schemas";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { processWebhookEventBatch } from "../webhook-events.worker.js";
import { insertFixtureOrganization } from "../../test/failure-fixtures.js";

/**
 * Phase 13 (CMP-08, D-05, plan 13-01, tracer task): proves the worker half
 * of the journal-then-enqueue-then-close-the-loop contract --
 * `processWebhookEventBatch` marks a journaled batch's `ingress_journal` row
 * ingested on every terminal-success path, including the two zero-row early
 * returns, defers (never throws) an unrecognized `schemaVersion`, still
 * processes a legacy (pre-13-01) payload with neither field, and the new
 * table is cross-tenant-unreadable while remaining readable by the scan
 * role for plan 13-11's health question.
 *
 * The three HTTP-level behaviors in 13-01-PLAN.md's `<behavior>` list --
 * "a verified batch POST creates exactly one ingress_journal row",
 * "an invalid signature creates zero rows", and "a simulated journal INSERT
 * failure produces a 5xx response and zero enqueued jobs" -- are asserted in
 * apps/api/src/modules/webhooks/__tests__/ingress-journal.test.ts instead of
 * here (documented deviation, 13-01-SUMMARY.md): driving the real Fastify
 * route requires apps/api's full env schema (AUTH_DATABASE_URL, REDIS_URL,
 * BETTER_AUTH_SECRET, etc.), which apps/worker's vitest project does not
 * provision, whereas apps/api's own test project already boots
 * `buildServer()` successfully (webhooks-signature.test.ts's existing
 * precedent). This file proves everything downstream of a journal row
 * already existing.
 */
describe("webhook-events worker: journal completion (CMP-08, D-05, 13-01)", () => {
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

  async function freshWorkspaceId(nameSeed: string): Promise<string> {
    return insertFixtureOrganization(nameSeed);
  }

  async function createFixtureCampaign(workspaceId: string): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows: segmentRows } = await client.query<{ id: string }>(
          `INSERT INTO segments (workspace_id, name, definition, created_by_user_id)
           VALUES ($1, 'Journal fixture segment', $2, 'test-user') RETURNING id`,
          [workspaceId, { operator: "and", conditions: [] }]
        );
        const { rows: campaignRows } = await client.query<{ id: string }>(
          `INSERT INTO campaigns (workspace_id, name, status, segment_id, template_id, from_email, created_by_user_id)
           VALUES ($1, 'Journal fixture campaign', 'sent', $2, 'd-fixture-template', 'sender@fixture.test', 'test-user')
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

  async function seedJournalRow(workspaceId: string, events: unknown[]): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction((client) => writeIngressJournal(client, workspaceId, events))
    );
  }

  interface JournalRow {
    ingestionCompletedAt: Date | null;
  }

  async function readJournalRow(workspaceId: string, journalId: string): Promise<JournalRow | undefined> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<JournalRow>(
          `SELECT ingestion_completed_at as "ingestionCompletedAt" FROM ingress_journal WHERE id = $1`,
          [journalId]
        );
        return rows[0];
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

  // Phase 13 (CMP-05, plan 13-04): a fixed 2023-era timestamp is now OLD
  // ENOUGH to fall outside classifyOccurredAt's [now-7d, now+5min] window and
  // get quarantined instead of inserted -- Tests 1/4 below assert
  // `inserted: 1` on the normal insert path, which requires an in-window
  // timestamp.
  const FIXED_TIMESTAMP = Math.floor(Date.now() / 1000) - 3600;

  function flattenedSendgridEvent(sendId: string | undefined, overrides: Record<string, unknown> = {}) {
    return {
      email: "hello@fixture.test",
      event: "delivered",
      sg_event_id: `sg-${randomUUID()}`,
      sg_message_id: "abc.filterdrecv-x",
      timestamp: FIXED_TIMESTAMP,
      ...(sendId !== undefined ? { send_id: sendId } : {}),
      ...overrides,
    };
  }

  it("Test 1: a journaled batch on the normal insert path marks ingestion_completed_at non-null", async () => {
    const workspaceId = await freshWorkspaceId("journal-normal");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);
    const event = flattenedSendgridEvent(sendId);

    const journalId = await seedJournalRow(workspaceId, [event]);
    expect((await readJournalRow(workspaceId, journalId))?.ingestionCompletedAt).toBeNull();

    const result = await processWebhookEventBatch({
      workspaceId,
      events: [event],
      schemaVersion: WEBHOOK_EVENTS_SCHEMA_VERSION,
      journalId,
    });

    expect(result.inserted).toBe(1);
    expect((await readJournalRow(workspaceId, journalId))?.ingestionCompletedAt).not.toBeNull();
  });

  it("Test 2: a journaled batch whose every event belongs to a sibling workspace marks ingestion_completed_at non-null and inserts zero send_events rows", async () => {
    const receivingWorkspaceId = await freshWorkspaceId("journal-sib-recv");
    const siblingWorkspaceId = await freshWorkspaceId("journal-sib-sibling");

    const siblingCampaignId = await createFixtureCampaign(siblingWorkspaceId);
    const siblingContactId = await createFixtureContact(siblingWorkspaceId);
    const siblingSendId = await createFixtureSend(siblingWorkspaceId, siblingCampaignId, siblingContactId);

    const event = flattenedSendgridEvent(siblingSendId);
    const journalId = await seedJournalRow(receivingWorkspaceId, [event]);

    const result = await processWebhookEventBatch({
      workspaceId: receivingWorkspaceId,
      events: [event],
      schemaVersion: WEBHOOK_EVENTS_SCHEMA_VERSION,
      journalId,
    });

    expect(result.inserted).toBe(0);
    expect(await countSendEvents(receivingWorkspaceId)).toBe(0);
    expect((await readJournalRow(receivingWorkspaceId, journalId))?.ingestionCompletedAt).not.toBeNull();
  });

  it("Test 3: a journaled batch with no extractable events marks ingestion_completed_at non-null", async () => {
    const workspaceId = await freshWorkspaceId("journal-no-extract");
    // No sg_event_id -- extractEventRow returns null for this event.
    const unusableEvent = { email: "hello@fixture.test", event: "delivered", timestamp: 1_700_000_000 };
    const journalId = await seedJournalRow(workspaceId, [unusableEvent]);

    const result = await processWebhookEventBatch({
      workspaceId,
      events: [unusableEvent],
      schemaVersion: WEBHOOK_EVENTS_SCHEMA_VERSION,
      journalId,
    });

    expect(result.inserted).toBe(0);
    expect((await readJournalRow(workspaceId, journalId))?.ingestionCompletedAt).not.toBeNull();
  });

  it("Test 4: a legacy payload (no schemaVersion, no journalId) still processes to completion without throwing", async () => {
    const workspaceId = await freshWorkspaceId("journal-legacy");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);
    const event = flattenedSendgridEvent(sendId);

    const result = await processWebhookEventBatch({ workspaceId, events: [event] });

    expect(result.inserted).toBe(1);
    expect(await countSendEvents(workspaceId)).toBe(1);
  });

  it("Test 5: a payload with an unrecognized schemaVersion resolves without throwing and leaves the journal row unmarked", async () => {
    const workspaceId = await freshWorkspaceId("journal-bad-version");
    const event = flattenedSendgridEvent(undefined);
    const journalId = await seedJournalRow(workspaceId, [event]);

    const result = await processWebhookEventBatch({
      workspaceId,
      events: [event],
      schemaVersion: 2,
      journalId,
    });

    expect(result.inserted).toBe(0);
    expect((await readJournalRow(workspaceId, journalId))?.ingestionCompletedAt).toBeNull();
  });

  it("Test 6: ingress_journal is unreadable from a tenant transaction scoped to a different workspace", async () => {
    const ownerWorkspaceId = await freshWorkspaceId("journal-rls-owner");
    const otherWorkspaceId = await freshWorkspaceId("journal-rls-other");
    const journalId = await seedJournalRow(ownerWorkspaceId, [flattenedSendgridEvent(undefined)]);

    const rowFromOtherTenant = await withTenant(otherWorkspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query(`SELECT id FROM ingress_journal WHERE id = $1`, [journalId]);
        return rows;
      })
    );
    expect(rowFromOtherTenant).toHaveLength(0);
  });

  it("Test 7: ingress_journal is readable cross-workspace by the scan role for more than one workspace", async () => {
    const workspaceA = await freshWorkspaceId("journal-scan-a");
    const workspaceB = await freshWorkspaceId("journal-scan-b");
    // The scan policy is narrowed to ingestion_completed_at IS NULL --
    // seed incomplete rows so both are visible through it.
    await seedJournalRow(workspaceA, [flattenedSendgridEvent(undefined)]);
    await seedJournalRow(workspaceB, [flattenedSendgridEvent(undefined)]);

    const distinctWorkspaceIds = await withCrossWorkspaceScan(async (client) => {
      const { rows } = await client.query<{ workspaceId: string }>(
        `SELECT DISTINCT workspace_id as "workspaceId" FROM ingress_journal WHERE workspace_id = ANY($1::uuid[])`,
        [[workspaceA, workspaceB]]
      );
      return rows.map((r) => r.workspaceId);
    });

    expect(new Set(distinctWorkspaceIds)).toEqual(new Set([workspaceA, workspaceB]));
  });

  // Sanity check the mock-avoidance decision above is real: assert
  // scrubbedConsole logging actually happens on the deferred path (Test 5),
  // matching send-reconciler.worker.ts's own deferred-payload precedent.
  it("Test 8: the unrecognized-schemaVersion defer path logs through scrubbedConsole", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const workspaceId = await freshWorkspaceId("journal-bad-version-log");
      const event = flattenedSendgridEvent(undefined);
      const journalId = await seedJournalRow(workspaceId, [event]);

      await processWebhookEventBatch({ workspaceId, events: [event], schemaVersion: 2, journalId });

      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
