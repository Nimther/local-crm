import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { reconcileWorkspaceDay } from "../analytics-reconciliation.worker.js";
import { insertFixtureOrganization } from "../../test/failure-fixtures.js";

/**
 * Analytics reconciliation worker (07-06, ANLT-04): `reconcileWorkspaceDay`
 * overwrites a (workspace, day) rollup row from a fresh `COUNT` over `sends`
 * -- including `sent_count`, which the incremental webhook-driven path
 * never sets. Running it a second time with zero new sends must leave
 * every count unchanged (overwrite, never additive -- Pitfall 2).
 */
describe("analytics reconciliation worker (07-06, ANLT-04)", () => {
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

  interface SendFacts {
    sentAt?: string | null;
    deliveredAt?: string | null;
    firstOpenedAt?: string | null;
    firstClickedAt?: string | null;
    bouncedAt?: string | null;
    droppedAt?: string | null;
    spamReportedAt?: string | null;
    unsubscribedAt?: string | null;
  }

  async function createFixtureSend(
    workspaceId: string,
    campaignId: string,
    contactId: string,
    facts: SendFacts
  ): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO sends (
             workspace_id, campaign_id, contact_id, kind, status,
             sent_at, delivered_at, first_opened_at, first_clicked_at,
             bounced_at, dropped_at, spam_reported_at, unsubscribed_at
           )
           VALUES ($1, $2, $3, 'campaign', 'sent', $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING id`,
          [
            workspaceId,
            campaignId,
            contactId,
            facts.sentAt ?? null,
            facts.deliveredAt ?? null,
            facts.firstOpenedAt ?? null,
            facts.firstClickedAt ?? null,
            facts.bouncedAt ?? null,
            facts.droppedAt ?? null,
            facts.spamReportedAt ?? null,
            facts.unsubscribedAt ?? null,
          ]
        );
        return rows[0].id;
      })
    );
  }

  interface RollupRow {
    sentCount: number;
    deliveredCount: number;
    openedCount: number;
    clickedCount: number;
    bouncedCount: number;
    unsubscribedCount: number;
  }

  async function rollupRow(workspaceId: string, day: string): Promise<RollupRow | null> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<RollupRow>(
          `SELECT sent_count as "sentCount", delivered_count as "deliveredCount",
                  opened_count as "openedCount", clicked_count as "clickedCount",
                  bounced_count as "bouncedCount", unsubscribed_count as "unsubscribedCount"
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

  const DAY = "2026-01-15";
  const DAY_TS = `${DAY}T10:00:00.000Z`;

  it("overwrites the rollup row to match a fresh COUNT over sends, including sent_count", async () => {
    const workspaceId = await freshWorkspaceId("reconcile-fresh");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contact1 = await createFixtureContact(workspaceId);
    const contact2 = await createFixtureContact(workspaceId);
    const contact3 = await createFixtureContact(workspaceId);
    const contact4 = await createFixtureContact(workspaceId);

    // 4 sends on DAY: 2 delivered (1 also opened), 1 hard-bounced, 1 dropped.
    await createFixtureSend(workspaceId, campaignId, contact1, {
      sentAt: DAY_TS,
      deliveredAt: DAY_TS,
      firstOpenedAt: DAY_TS,
    });
    await createFixtureSend(workspaceId, campaignId, contact2, { sentAt: DAY_TS, deliveredAt: DAY_TS });
    await createFixtureSend(workspaceId, campaignId, contact3, { sentAt: DAY_TS, bouncedAt: DAY_TS });
    await createFixtureSend(workspaceId, campaignId, contact4, { sentAt: DAY_TS, droppedAt: DAY_TS });

    await runReconcile(workspaceId, DAY);

    const row = await rollupRow(workspaceId, DAY);
    expect(row).toEqual({
      sentCount: 4,
      deliveredCount: 2,
      openedCount: 1,
      clickedCount: 0,
      bouncedCount: 2, // hard-bounce + dropped both fold into bounced_count (D-08 grouping)
      unsubscribedCount: 0,
    });
  });

  it("running reconciliation a second time with zero new sends leaves every count unchanged (overwrite, not additive)", async () => {
    const workspaceId = await freshWorkspaceId("reconcile-idempotent");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contact1 = await createFixtureContact(workspaceId);
    const contact2 = await createFixtureContact(workspaceId);

    await createFixtureSend(workspaceId, campaignId, contact1, { sentAt: DAY_TS, deliveredAt: DAY_TS });
    await createFixtureSend(workspaceId, campaignId, contact2, { sentAt: DAY_TS });

    await runReconcile(workspaceId, DAY);
    const firstRun = await rollupRow(workspaceId, DAY);
    expect(firstRun).toEqual({
      sentCount: 2,
      deliveredCount: 1,
      openedCount: 0,
      clickedCount: 0,
      bouncedCount: 0,
      unsubscribedCount: 0,
    });

    // Re-run with no new sends -- must be byte-identical, never additive.
    await runReconcile(workspaceId, DAY);
    const secondRun = await rollupRow(workspaceId, DAY);
    expect(secondRun).toEqual(firstRun);

    await runReconcile(workspaceId, DAY);
    const thirdRun = await rollupRow(workspaceId, DAY);
    expect(thirdRun).toEqual(firstRun);
  });

  it("reconciles only the requested workspace's own sends (per-workspace scoping)", async () => {
    const workspaceA = await freshWorkspaceId("reconcile-tenant-a");
    const workspaceB = await freshWorkspaceId("reconcile-tenant-b");

    const campaignA = await createFixtureCampaign(workspaceA);
    const contactA = await createFixtureContact(workspaceA);
    await createFixtureSend(workspaceA, campaignA, contactA, { sentAt: DAY_TS, deliveredAt: DAY_TS });

    const campaignB = await createFixtureCampaign(workspaceB);
    const contactB1 = await createFixtureContact(workspaceB);
    const contactB2 = await createFixtureContact(workspaceB);
    await createFixtureSend(workspaceB, campaignB, contactB1, { sentAt: DAY_TS });
    await createFixtureSend(workspaceB, campaignB, contactB2, { sentAt: DAY_TS });

    await runReconcile(workspaceA, DAY);
    await runReconcile(workspaceB, DAY);

    expect((await rollupRow(workspaceA, DAY))?.sentCount).toBe(1);
    expect((await rollupRow(workspaceA, DAY))?.deliveredCount).toBe(1);
    expect((await rollupRow(workspaceB, DAY))?.sentCount).toBe(2);
    expect((await rollupRow(workspaceB, DAY))?.deliveredCount).toBe(0);
  });
});
