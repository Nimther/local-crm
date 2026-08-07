import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { processWebhookEventBatch } from "../webhook-events.worker.js";
import { reconcileWorkspaceDay } from "../analytics-reconciliation.worker.js";
import { insertFixtureOrganization } from "../../test/failure-fixtures.js";

/**
 * Dual-write invariant (07-09, ANLT-04 / CR-01 gap closure): the incremental
 * webhook path (`processWebhookEventBatch`) and the reconciliation backstop
 * (`reconcileWorkspaceDay`) must compute the SAME `opened_count`/
 * `clicked_count`/`bounced_count` for a given (workspace, day) -- both are
 * unique-send counts, never a repeat-event count. Running reconciliation
 * after the incremental path has already incremented a rollup row must
 * leave every count byte-identical (no oscillation between the two
 * writers' definitions).
 */
describe("workspace_daily_rollup dual-write invariant (07-09, ANLT-04)", () => {
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

  async function rollupCounts(
    workspaceId: string,
    day: string
  ): Promise<{ openedCount: number; clickedCount: number; bouncedCount: number } | null> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ openedCount: number; clickedCount: number; bouncedCount: number }>(
          `SELECT opened_count as "openedCount", clicked_count as "clickedCount", bounced_count as "bouncedCount"
           FROM workspace_daily_rollup WHERE workspace_id = $1 AND day = $2`,
          [workspaceId, day]
        );
        return rows[0] ?? null;
      })
    );
  }

  async function runReconcile(workspaceId: string, day: string): Promise<void> {
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) => reconcileWorkspaceDay(client, workspaceId, day))
    );
  }

  // Noon-UTC fixture timestamp: the incremental path's `occurredAt.slice(0,10)`
  // UTC-day bucket and reconciliation's `::date` cast resolve to the same
  // calendar day regardless of the test DB session's timezone (side-steps
  // the WR-01 session-timezone `::date` caveat, out of scope here).
  const FIXED_TIMESTAMP = 1_768_478_400; // -> 2026-01-15T12:00:00.000Z
  const FIXED_ISO = new Date(FIXED_TIMESTAMP * 1000).toISOString();
  const DAY = FIXED_ISO.slice(0, 10);

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
      timestamp: FIXED_TIMESTAMP,
      send_id: sendId,
      workspace_id: workspaceId,
      campaign_id: campaignId,
      ...overrides,
    };
  }

  it("fixture timestamp lands on noon UTC and derives DAY consistently", () => {
    expect(FIXED_ISO.endsWith("T12:00:00.000Z")).toBe(true);
  });

  it("Scenario A: opened_count/clicked_count stay unique-send counts across a reconcile tick", async () => {
    const workspaceId = await freshWorkspaceId("invariant-open-click");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);

    // Two DISTINCT open events (different sg_event_id, same send).
    await processWebhookEventBatch({
      workspaceId,
      events: [sendgridEvent(workspaceId, campaignId, sendId, { event: "open" })],
    });
    await processWebhookEventBatch({
      workspaceId,
      events: [sendgridEvent(workspaceId, campaignId, sendId, { event: "open" })],
    });

    const openedBeforeReconcile = (await rollupCounts(workspaceId, DAY))?.openedCount;
    expect(openedBeforeReconcile).toBe(1);

    await runReconcile(workspaceId, DAY);

    const openedAfterReconcile = (await rollupCounts(workspaceId, DAY))?.openedCount;
    expect(openedAfterReconcile).toBe(openedBeforeReconcile);
    expect(openedAfterReconcile).toBe(1);

    // Two DISTINCT click events (different sg_event_id, same send).
    await processWebhookEventBatch({
      workspaceId,
      events: [sendgridEvent(workspaceId, campaignId, sendId, { event: "click" })],
    });
    await processWebhookEventBatch({
      workspaceId,
      events: [sendgridEvent(workspaceId, campaignId, sendId, { event: "click" })],
    });

    const clickedBeforeReconcile = (await rollupCounts(workspaceId, DAY))?.clickedCount;
    expect(clickedBeforeReconcile).toBe(1);

    await runReconcile(workspaceId, DAY);

    const clickedAfterReconcile = (await rollupCounts(workspaceId, DAY))?.clickedCount;
    expect(clickedAfterReconcile).toBe(clickedBeforeReconcile);
    expect(clickedAfterReconcile).toBe(1);
  });

  it("Scenario B: a hard bounce + a spam report on the same send contribute exactly 1 to bounced_count, unchanged after reconcile", async () => {
    const workspaceId = await freshWorkspaceId("invariant-bounce-spam");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);

    await processWebhookEventBatch({
      workspaceId,
      events: [sendgridEvent(workspaceId, campaignId, sendId, { event: "bounce", type: "bounce", reason: "550 hard" })],
    });
    await processWebhookEventBatch({
      workspaceId,
      events: [sendgridEvent(workspaceId, campaignId, sendId, { event: "spamreport" })],
    });

    const bouncedBeforeReconcile = (await rollupCounts(workspaceId, DAY))?.bouncedCount;
    expect(bouncedBeforeReconcile).toBe(1);

    await runReconcile(workspaceId, DAY);

    const bouncedAfterReconcile = (await rollupCounts(workspaceId, DAY))?.bouncedCount;
    expect(bouncedAfterReconcile).toBe(bouncedBeforeReconcile);
    expect(bouncedAfterReconcile).toBe(1);
  });
});
