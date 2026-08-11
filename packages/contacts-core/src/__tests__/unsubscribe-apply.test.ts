import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { ensureTestDbMigrated, getTestDatabaseUrl, getAuthTestDatabaseUrl, createTestPool } from "@mega-crm/test-support";
import { applyUnsubscribeWithSendFact } from "../unsubscribe-apply.js";

/**
 * CMP-01 (Phase 13, plan 13-08, Task 1): exercises `applyUnsubscribeWithSendFact`
 * directly against a real Postgres connection (RLS-forced fixtures, mirroring
 * packages/delivery-core/src/__tests__/send-ledger-integrity.test.ts's
 * convention) -- the function issues real SQL against `contacts`,
 * `subscription_status_history`, and `sends`, so a stubbed PoolClient cannot
 * exercise its idempotency gates.
 */
describe("applyUnsubscribeWithSendFact (CMP-01)", () => {
  let pool: Pool;
  let authPool: Pool | undefined;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    pool = createTestPool();
  });

  afterAll(async () => {
    await pool.end();
    await authPool?.end();
  });

  function getAuthTestPool(): Pool {
    if (!authPool) authPool = new Pool({ connectionString: getAuthTestDatabaseUrl() });
    return authPool;
  }

  async function freshWorkspaceId(nameSeed: string): Promise<string> {
    const slug = `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { rows } = await getAuthTestPool().query<{ id: string }>(
      `INSERT INTO organization (name, slug) VALUES ($1, $2) RETURNING id`,
      [`${nameSeed} Co`, slug]
    );
    return rows[0].id;
  }

  async function createFixtureContact(workspaceId: string, status: string): Promise<string> {
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

  async function createFixtureCampaign(workspaceId: string): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows: segmentRows } = await client.query<{ id: string }>(
          `INSERT INTO segments (workspace_id, name, definition, created_by_user_id)
           VALUES ($1, 'Fixture segment', $2, 'test-user') RETURNING id`,
          [workspaceId, { operator: "and", conditions: [] }]
        );
        const segmentId = segmentRows[0].id;

        const { rows: campaignRows } = await client.query<{ id: string }>(
          `INSERT INTO campaigns (workspace_id, name, status, segment_id, template_id, from_email, created_by_user_id)
           VALUES ($1, 'Fixture campaign', 'sending', $2, 'd-fixture-template', 'sender@fixture.test', 'test-user')
           RETURNING id`,
          [workspaceId, segmentId]
        );
        return campaignRows[0].id;
      })
    );
  }

  async function createFixtureSend(
    workspaceId: string,
    campaignId: string | null,
    contactId: string
  ): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO sends (workspace_id, campaign_id, contact_id, kind, status)
           VALUES ($1, $2, $3, 'campaign', 'sent') RETURNING id`,
          [workspaceId, campaignId, contactId]
        );
        return rows[0].id;
      })
    );
  }

  async function sendRow(
    workspaceId: string,
    sendId: string
  ): Promise<{ unsubscribedAt: Date | null } | undefined> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ unsubscribedAt: Date | null }>(
          `SELECT unsubscribed_at as "unsubscribedAt" FROM sends WHERE id = $1`,
          [sendId]
        );
        return rows[0];
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

  async function historyRows(
    workspaceId: string,
    contactId: string
  ): Promise<Array<{ oldStatus: string | null; newStatus: string }>> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ oldStatus: string | null; newStatus: string }>(
          `SELECT old_status as "oldStatus", new_status as "newStatus" FROM subscription_status_history
           WHERE contact_id = $1 ORDER BY changed_at ASC`,
          [contactId]
        );
        return rows;
      })
    );
  }

  it("subscribed contact + live send: flips status, writes one history row with the correct prior status, and sets sends.unsubscribed_at", async () => {
    const workspaceId = await freshWorkspaceId("unsub-happy");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId, "subscribed");
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);

    const result = await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        applyUnsubscribeWithSendFact(client, {
          workspaceId,
          contactId,
          sendId,
          occurredAt: new Date().toISOString(),
          source: "unsubscribe_route",
        })
      )
    );

    expect(result.statusChanged).toBe(true);
    expect(result.sendFactJustSet).toBe(true);
    expect(result.campaignId).toBe(campaignId);
    expect(await contactStatus(workspaceId, contactId)).toBe("unsubscribed");
    const history = await historyRows(workspaceId, contactId);
    expect(history).toHaveLength(1);
    expect(history[0].oldStatus).toBe("subscribed");
    expect(history[0].newStatus).toBe("unsubscribed");
    expect((await sendRow(workspaceId, sendId))?.unsubscribedAt).not.toBeNull();
  });

  it("called a second time with identical input: no additional history row, unsubscribed_at unchanged, both flags false", async () => {
    const workspaceId = await freshWorkspaceId("unsub-idempotent");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId, "subscribed");
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);
    const occurredAt = new Date().toISOString();

    const input = { workspaceId, contactId, sendId, occurredAt, source: "unsubscribe_route" as const };

    await withTenant(workspaceId, () => withTenantTransaction((client) => applyUnsubscribeWithSendFact(client, input)));
    const firstUnsubscribedAt = (await sendRow(workspaceId, sendId))?.unsubscribedAt;

    const second = await withTenant(workspaceId, () =>
      withTenantTransaction((client) => applyUnsubscribeWithSendFact(client, input))
    );

    expect(second.statusChanged).toBe(false);
    expect(second.sendFactJustSet).toBe(false);
    expect(await historyRows(workspaceId, contactId)).toHaveLength(1);
    expect((await sendRow(workspaceId, sendId))?.unsubscribedAt).toEqual(firstUnsubscribedAt);
  });

  it("sendId names no sends row: still flips status and writes one history row, reports sendFactJustSet false", async () => {
    const workspaceId = await freshWorkspaceId("unsub-no-send-row");
    const contactId = await createFixtureContact(workspaceId, "subscribed");
    const missingSendId = "00000000-0000-0000-0000-000000000000";

    const result = await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        applyUnsubscribeWithSendFact(client, {
          workspaceId,
          contactId,
          sendId: missingSendId,
          occurredAt: new Date().toISOString(),
          source: "unsubscribe_route",
        })
      )
    );

    expect(result.statusChanged).toBe(true);
    expect(result.sendFactJustSet).toBe(false);
    expect(result.campaignId).toBeNull();
    expect(await contactStatus(workspaceId, contactId)).toBe("unsubscribed");
    expect(await historyRows(workspaceId, contactId)).toHaveLength(1);
  });

  it("null contactId + live sendId: resolves the contact from the send row and performs the full write set", async () => {
    const workspaceId = await freshWorkspaceId("unsub-resolve-from-send");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId, "subscribed");
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);

    const result = await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        applyUnsubscribeWithSendFact(client, {
          workspaceId,
          contactId: null,
          sendId,
          occurredAt: new Date().toISOString(),
          source: "webhook_unsubscribe",
        })
      )
    );

    expect(result.statusChanged).toBe(true);
    expect(result.sendFactJustSet).toBe(true);
    expect(await contactStatus(workspaceId, contactId)).toBe("unsubscribed");
  });

  it("non-UUID contactId + null sendId: writes nothing and does not throw", async () => {
    const workspaceId = await freshWorkspaceId("unsub-cr01-fallthrough");

    const result = await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        applyUnsubscribeWithSendFact(client, {
          workspaceId,
          contactId: "not-a-real-uuid",
          sendId: null,
          occurredAt: new Date().toISOString(),
          source: "unsubscribe_route",
        })
      )
    );

    expect(result.statusChanged).toBe(false);
    expect(result.sendFactJustSet).toBe(false);
    expect(result.campaignId).toBeNull();
  });

  it("already-unsubscribed contact: reports statusChanged false and writes no additional history row", async () => {
    const workspaceId = await freshWorkspaceId("unsub-already");
    const contactId = await createFixtureContact(workspaceId, "unsubscribed");

    const result = await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        applyUnsubscribeWithSendFact(client, {
          workspaceId,
          contactId,
          sendId: null,
          occurredAt: new Date().toISOString(),
          source: "unsubscribe_route",
        })
      )
    );

    expect(result.statusChanged).toBe(false);
    expect(await historyRows(workspaceId, contactId)).toHaveLength(0);
  });

  it("records the correct prior status (suppressed, not guessed) in the history row", async () => {
    const workspaceId = await freshWorkspaceId("unsub-prior-status");
    const contactId = await createFixtureContact(workspaceId, "suppressed");

    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        applyUnsubscribeWithSendFact(client, {
          workspaceId,
          contactId,
          sendId: null,
          occurredAt: new Date().toISOString(),
          source: "unsubscribe_route",
        })
      )
    );

    const history = await historyRows(workspaceId, contactId);
    expect(history).toHaveLength(1);
    expect(history[0].oldStatus).toBe("suppressed");
    expect(history[0].newStatus).toBe("unsubscribed");
  });
});
