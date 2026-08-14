import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { hashSuppressionEmail, loadWorkspaceSuppressionKey, normalizeSuppressionEmail } from "@mega-crm/contacts-core";
import { signUnsubscribeToken } from "@mega-crm/delivery-core";
import { registerUnsubscribeRoutes } from "@mega-crm/api/src/modules/delivery/unsubscribe.routes.js";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { processWebhookEventBatch } from "../webhook-events.worker.js";
import { insertFixtureOrganization } from "../../test/failure-fixtures.js";

/**
 * CMP-01 (Phase 13, plan 13-08, Task 2): proves the public unsubscribe route
 * and the SendGrid webhook path converge on identical state regardless of
 * which one runs first, now that both call `applyUnsubscribeWithSendFact`.
 * Drives the REAL route handler (`registerUnsubscribeRoutes`, the production
 * plugin, registered on a bare `Fastify()` instance -- no full `buildServer()`
 * bootstrap needed since the route depends on nothing beyond
 * `@mega-crm/tenant-context`, already configured by this test's own DB
 * fixture setup) and the REAL `processWebhookEventBatch`, mirroring
 * webhook-events-suppression.test.ts's and analytics-rollup-idempotency.test.ts's
 * real-Postgres fixture conventions.
 */
describe("Route + webhook unsubscribe convergence (CMP-01, plan 13-08)", () => {
  let pool: Pool;
  let app: FastifyInstance;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    pool = createTestPool();
    // 04-03 precedent (apps/api/src/server.ts): find-my-way's default
    // maxParamLength (100) is too small for the signed `:token` route
    // param -- without this, every genuine token 414s before the handler
    // ever runs.
    app = Fastify({ routerOptions: { maxParamLength: 1024 } });
    await app.register(registerUnsubscribeRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
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

  async function createFixtureContact(workspaceId: string, status = "subscribed"): Promise<string> {
    const email = `contact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@fixture.test`;
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO contacts (workspace_id, email, first_name, subscription_status)
           VALUES ($1, $2, 'Fixture', $3) RETURNING id`,
          [workspaceId, email, status]
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

  async function sendUnsubscribedAt(workspaceId: string, sendId: string): Promise<Date | null> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ unsubscribedAt: Date | null }>(
          `SELECT unsubscribed_at as "unsubscribedAt" FROM sends WHERE id = $1`,
          [sendId]
        );
        return rows[0]?.unsubscribedAt ?? null;
      })
    );
  }

  async function campaignUnsubscribedCount(workspaceId: string, campaignId: string): Promise<number> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ unsubscribedCount: number }>(
          `SELECT unsubscribed_count as "unsubscribedCount" FROM campaigns WHERE id = $1`,
          [campaignId]
        );
        return rows[0]?.unsubscribedCount ?? 0;
      })
    );
  }

  async function dailyRollupUnsubscribedCount(workspaceId: string, day: string): Promise<number> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ unsubscribedCount: number }>(
          `SELECT unsubscribed_count as "unsubscribedCount" FROM workspace_daily_rollup
           WHERE workspace_id = $1 AND day = $2`,
          [workspaceId, day]
        );
        return rows[0]?.unsubscribedCount ?? 0;
      })
    );
  }

  async function contactStatus(workspaceId: string, contactId: string): Promise<string | undefined> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ subscriptionStatus: string }>(
          `SELECT subscription_status as "subscriptionStatus" FROM contacts WHERE id = $1`,
          [contactId]
        );
        return rows[0]?.subscriptionStatus;
      })
    );
  }

  async function historyRowCount(workspaceId: string, contactId: string): Promise<number> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*)::text as count FROM subscription_status_history WHERE workspace_id = $1 AND contact_id = $2`,
          [workspaceId, contactId]
        );
        return Number(rows[0]?.count ?? "0");
      })
    );
  }

  // CMP-04 (D-02, plan 13-12): workspace_suppressions no longer stores
  // plaintext, so this can no longer join on `ws.email = c.email` -- that
  // join would silently always evaluate to zero matches once every write
  // site stops populating `email`, which would make this assertion pass
  // vacuously regardless of what actually happened. Reads the contact's
  // current email, hashes it under the workspace's own key (a workspace
  // with no key row has suppressed nothing, hence zero), and compares by hash.
  async function suppressionRows(workspaceId: string, contactId: string): Promise<number> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows: contactRows } = await client.query<{ email: string | null }>(
          `SELECT email FROM contacts WHERE id = $1`,
          [contactId]
        );
        const email = contactRows[0]?.email;
        if (!email) return 0;

        const key = await loadWorkspaceSuppressionKey(client, workspaceId);
        if (!key) return 0;
        const hash = hashSuppressionEmail(normalizeSuppressionEmail(email), key);

        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*)::text as count FROM workspace_suppressions WHERE workspace_id = $1 AND email_hash = $2`,
          [workspaceId, hash]
        );
        return Number(rows[0]?.count ?? "0");
      })
    );
  }

  function futureExp(): number {
    return Math.floor(Date.now() / 1000) + 3600;
  }

  function todayUtc(): string {
    return new Date().toISOString().slice(0, 10);
  }

  async function routeUnsubscribe(sendId: string, contactId: string, workspaceId: string) {
    const token = signUnsubscribeToken({ sendId, contactId, workspaceId, exp: futureExp() });
    return app.inject({ method: "POST", url: `/unsubscribe/${token}` });
  }

  // Phase 13 (CMP-05, plan 13-04): a runtime-computed, in-window timestamp --
  // a fixed 2023-era value now falls outside classifyOccurredAt's
  // [now-7d, now+5min] window and gets quarantined.
  function webhookOccurredAt(): number {
    return Math.floor(Date.now() / 1000) - 60;
  }

  function sendgridEvent(
    workspaceId: string,
    campaignId: string,
    sendId: string,
    overrides: Record<string, unknown> = {}
  ): Record<string, unknown> {
    return {
      email: "hello@world.com",
      event: "unsubscribe",
      sg_event_id: `sg-${randomUUID()}`,
      timestamp: webhookOccurredAt(),
      send_id: sendId,
      workspace_id: workspaceId,
      campaign_id: campaignId,
      ...overrides,
    };
  }

  it("a route unsubscribe sets sends.unsubscribed_at, which it did not do before this plan", async () => {
    const workspaceId = await freshWorkspaceId("conv-route-sets-fact");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);

    expect(await sendUnsubscribedAt(workspaceId, sendId)).toBeNull();
    const res = await routeUnsubscribe(sendId, contactId, workspaceId);
    expect(res.statusCode).toBe(200);
    expect(await sendUnsubscribedAt(workspaceId, sendId)).not.toBeNull();
  });

  it("a route unsubscribe increments the campaign's unsubscribed_count exactly once when it sets the send fact", async () => {
    const workspaceId = await freshWorkspaceId("conv-route-campaign-count");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);

    await routeUnsubscribe(sendId, contactId, workspaceId);
    expect(await campaignUnsubscribedCount(workspaceId, campaignId)).toBe(1);

    // A second route unsubscribe on the same send is a no-op on the counter.
    await routeUnsubscribe(sendId, contactId, workspaceId);
    expect(await campaignUnsubscribedCount(workspaceId, campaignId)).toBe(1);
  });

  it("a route unsubscribe increments that day's workspace_daily_rollup.unsubscribed_count by exactly 1, and a second is a no-op", async () => {
    const workspaceId = await freshWorkspaceId("conv-route-daily-rollup");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);

    await routeUnsubscribe(sendId, contactId, workspaceId);
    expect(await dailyRollupUnsubscribedCount(workspaceId, todayUtc())).toBe(1);

    await routeUnsubscribe(sendId, contactId, workspaceId);
    expect(await dailyRollupUnsubscribedCount(workspaceId, todayUtc())).toBe(1);
  });

  it("route-then-webhook on the same send: exactly 1 history row, 1 unsubscribed_at, unsubscribed_count = 1", async () => {
    const workspaceId = await freshWorkspaceId("conv-route-then-webhook");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);

    await routeUnsubscribe(sendId, contactId, workspaceId);
    await processWebhookEventBatch({
      workspaceId,
      events: [sendgridEvent(workspaceId, campaignId, sendId)],
    });

    expect(await contactStatus(workspaceId, contactId)).toBe("unsubscribed");
    expect(await historyRowCount(workspaceId, contactId)).toBe(1);
    expect(await sendUnsubscribedAt(workspaceId, sendId)).not.toBeNull();
    expect(await campaignUnsubscribedCount(workspaceId, campaignId)).toBe(1);
  });

  it("webhook-then-route on the same send: leaves the same state as the reverse ordering", async () => {
    const workspaceId = await freshWorkspaceId("conv-webhook-then-route");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);

    await processWebhookEventBatch({
      workspaceId,
      events: [sendgridEvent(workspaceId, campaignId, sendId)],
    });
    await routeUnsubscribe(sendId, contactId, workspaceId);

    expect(await contactStatus(workspaceId, contactId)).toBe("unsubscribed");
    expect(await historyRowCount(workspaceId, contactId)).toBe(1);
    expect(await sendUnsubscribedAt(workspaceId, sendId)).not.toBeNull();
    expect(await campaignUnsubscribedCount(workspaceId, campaignId)).toBe(1);
  });

  it("a dropped event whose reason resolves to an unsubscribed outcome writes the send fact through the same helper", async () => {
    const workspaceId = await freshWorkspaceId("conv-dropped-unsub");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);

    await processWebhookEventBatch({
      workspaceId,
      events: [
        sendgridEvent(workspaceId, campaignId, sendId, { event: "dropped", reason: "Unsubscribed Address" }),
      ],
    });

    expect(await contactStatus(workspaceId, contactId)).toBe("unsubscribed");
    expect(await sendUnsubscribedAt(workspaceId, sendId)).not.toBeNull();
    // Deliberate behavior change (13-08 flagged_assumptions): the campaign
    // counter now increments for a dropped-unsubscribed send, which it
    // previously did not.
    expect(await campaignUnsubscribedCount(workspaceId, campaignId)).toBe(1);
    expect(await suppressionRows(workspaceId, contactId)).toBe(0);
  });

  it("an unsubscribe (route or webhook) writes zero workspace_suppressions rows (D-11/D-13 preserved)", async () => {
    const workspaceId = await freshWorkspaceId("conv-zero-suppression");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);

    await routeUnsubscribe(sendId, contactId, workspaceId);
    expect(await suppressionRows(workspaceId, contactId)).toBe(0);
  });

  it("the route's response is byte-identical for success, already-unsubscribed, unknown-contact, and non-UUID-contact outcomes", async () => {
    const workspaceId = await freshWorkspaceId("conv-byte-identical");
    const campaignId = await createFixtureCampaign(workspaceId);

    const subscribedContactId = await createFixtureContact(workspaceId, "subscribed");
    const subscribedSendId = await createFixtureSend(workspaceId, campaignId, subscribedContactId);
    const successRes = await routeUnsubscribe(subscribedSendId, subscribedContactId, workspaceId);

    const alreadyUnsubContactId = await createFixtureContact(workspaceId, "unsubscribed");
    const alreadyUnsubSendId = await createFixtureSend(workspaceId, campaignId, alreadyUnsubContactId);
    const alreadyUnsubRes = await routeUnsubscribe(alreadyUnsubSendId, alreadyUnsubContactId, workspaceId);

    const unknownContactToken = signUnsubscribeToken({
      sendId: randomUUID(),
      contactId: randomUUID(),
      workspaceId,
      exp: futureExp(),
    });
    const unknownContactRes = await app.inject({ method: "POST", url: `/unsubscribe/${unknownContactToken}` });

    const nonUuidToken = signUnsubscribeToken({
      sendId: randomUUID(),
      contactId: "not-a-real-uuid",
      workspaceId,
      exp: futureExp(),
    });
    const nonUuidRes = await app.inject({ method: "POST", url: `/unsubscribe/${nonUuidToken}` });

    for (const res of [successRes, alreadyUnsubRes, unknownContactRes, nonUuidRes]) {
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe("");
    }
  });
});
