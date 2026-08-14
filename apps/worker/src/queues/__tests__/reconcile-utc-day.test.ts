import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { reconcileWorkspaceDay } from "../analytics-reconciliation.worker.js";
import { insertFixtureOrganization } from "../../test/failure-fixtures.js";

/**
 * CMP-02 (D-13): `reconcileWorkspaceDay`'s eight FILTER casts must bucket by
 * the send's UTC calendar day regardless of the session `TimeZone` GUC.
 * Before this fix, a bare `<col>::date` cast converted a `timestamptz` to
 * the session's `TimeZone` FIRST, then truncated -- so the same reconciliation
 * run could produce different daily numbers depending on which pooled
 * connection served it. `SET LOCAL TIME ZONE` (transaction-scoped, mirroring
 * `withTenantTransaction`'s own `SET LOCAL` discipline for the tenant GUC --
 * never a plain session-wide `SET`, which would leak into the next job that
 * reuses this pooled connection) simulates three different session
 * timezones a pooled connection could plausibly carry; a correct
 * implementation must be invariant to all three.
 */
describe("reconcileWorkspaceDay is UTC-day invariant under session TimeZone (CMP-02, D-13)", () => {
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

  async function createFixtureSend(
    workspaceId: string,
    campaignId: string,
    contactId: string,
    sentAt: string
  ): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO sends (workspace_id, campaign_id, contact_id, kind, status, sent_at)
           VALUES ($1, $2, $3, 'campaign', 'sent', $4) RETURNING id`,
          [workspaceId, campaignId, contactId, sentAt]
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

  /**
   * Runs `reconcileWorkspaceDay` inside a transaction whose session
   * `TimeZone` GUC is first set to `timezone` via `SET LOCAL TIME ZONE` --
   * transaction-scoped (auto-resets on COMMIT), so this never leaks into the
   * next test's pooled connection. `timezone` is always one of this file's
   * own fixed literals, never external input, so string interpolation here
   * carries no injection risk.
   */
  async function runReconcileUnderTimezone(workspaceId: string, day: string, timezone: string): Promise<void> {
    await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        await client.query(`SET LOCAL TIME ZONE '${timezone}'`);
        await reconcileWorkspaceDay(client, workspaceId, day);
      })
    );
  }

  const SESSION_TIMEZONES = ["UTC", "America/New_York", "Asia/Tokyo"];

  // A send at 23:30 UTC on the 15th must land on the 15th; a send at
  // 00:30 UTC on the 16th must land on the 16th -- under all three session
  // timezones, since America/New_York (-05:00 in March) and Asia/Tokyo
  // (+09:00) would each shift a bare ::date cast across the boundary in
  // OPPOSITE directions if the fix were missing.
  const DAY_15 = "2026-03-15";
  const DAY_16 = "2026-03-16";
  const LATE_ON_15_UTC = "2026-03-15T23:30:00.000Z";
  const EARLY_ON_16_UTC = "2026-03-16T00:30:00.000Z";

  for (const timezone of SESSION_TIMEZONES) {
    it(`buckets a 23:30 UTC send into ${DAY_15} and a 00:30 UTC send into ${DAY_16} under session TimeZone '${timezone}'`, async () => {
      const workspaceId = await freshWorkspaceId(`utc-day-boundary-${timezone.replace(/[^a-z]/gi, "-")}`);
      const campaignId = await createFixtureCampaign(workspaceId);
      const contactLate = await createFixtureContact(workspaceId);
      const contactEarly = await createFixtureContact(workspaceId);

      await createFixtureSend(workspaceId, campaignId, contactLate, LATE_ON_15_UTC);
      await createFixtureSend(workspaceId, campaignId, contactEarly, EARLY_ON_16_UTC);

      await runReconcileUnderTimezone(workspaceId, DAY_15, timezone);
      await runReconcileUnderTimezone(workspaceId, DAY_16, timezone);

      const day15 = await rollupRow(workspaceId, DAY_15);
      const day16 = await rollupRow(workspaceId, DAY_16);

      expect(day15?.sentCount).toBe(1);
      expect(day16?.sentCount).toBe(1);
    });
  }

  it("reconciling the same seeded workspace-day under UTC, America/New_York, and Asia/Tokyo yields identical counts", async () => {
    const workspaceId = await freshWorkspaceId("utc-day-tz-identical");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contact1 = await createFixtureContact(workspaceId);
    const contact2 = await createFixtureContact(workspaceId);

    await createFixtureSend(workspaceId, campaignId, contact1, LATE_ON_15_UTC);
    await createFixtureSend(workspaceId, campaignId, contact2, LATE_ON_15_UTC);

    const results: RollupRow[] = [];
    for (const timezone of SESSION_TIMEZONES) {
      await runReconcileUnderTimezone(workspaceId, DAY_15, timezone);
      const row = await rollupRow(workspaceId, DAY_15);
      expect(row).not.toBeNull();
      results.push(row as RollupRow);
    }

    expect(results[0]).toEqual(results[1]);
    expect(results[1]).toEqual(results[2]);
    expect(results[0].sentCount).toBe(2);
  });

  it("running reconciliation twice in a row with no intervening writes leaves all six counts unchanged, under a non-UTC session TimeZone", async () => {
    const workspaceId = await freshWorkspaceId("utc-day-double-run");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contact1 = await createFixtureContact(workspaceId);
    const contact2 = await createFixtureContact(workspaceId);

    await createFixtureSend(workspaceId, campaignId, contact1, LATE_ON_15_UTC);
    await createFixtureSend(workspaceId, campaignId, contact2, LATE_ON_15_UTC);

    await runReconcileUnderTimezone(workspaceId, DAY_15, "Asia/Tokyo");
    const firstRun = await rollupRow(workspaceId, DAY_15);
    expect(firstRun?.sentCount).toBe(2);

    await runReconcileUnderTimezone(workspaceId, DAY_15, "Asia/Tokyo");
    const secondRun = await rollupRow(workspaceId, DAY_15);
    expect(secondRun).toEqual(firstRun);
  });
});
