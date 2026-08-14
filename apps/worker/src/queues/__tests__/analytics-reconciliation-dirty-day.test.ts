import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { insertFixtureOrganization } from "../../test/failure-fixtures.js";
import { incrementWorkspaceDailyRollup, isNotToday } from "@mega-crm/db/src/analytics/daily-rollup.js";
import {
  DIRTY_DAY_SWEEP_PAGE_LIMIT,
  RECONCILE_WINDOW_DAYS,
  clearDirtyRollupDays,
  findDirtyRollupDays,
  reconcileWorkspace,
} from "../analytics-reconciliation.worker.js";

/** The UTC calendar day `daysAgo` days before the REAL wall clock, as `YYYY-MM-DD`. Task 2's sweep runs against the real clock (`reconcileWorkspace`/`clearDirtyRollupDays` are not clock-injectable), so fixture days are computed relative to it rather than a fixed literal. */
function utcDateString(daysAgo: number): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysAgo));
  return d.toISOString().slice(0, 10);
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
  deliveredAt: string
): Promise<void> {
  await withTenant(workspaceId, () =>
    withTenantTransaction(async (client) => {
      await client.query(
        `INSERT INTO sends (workspace_id, campaign_id, contact_id, kind, status, sent_at, delivered_at)
         VALUES ($1, $2, $3, 'campaign', 'sent', $4, $4)`,
        [workspaceId, campaignId, contactId, deliveredAt]
      );
    })
  );
}

/** Directly writes a `workspace_daily_rollup` row, bypassing `incrementWorkspaceDailyRollup` -- lets a test seed a DELIBERATELY WRONG stored count and an arbitrary `dirtied_at`. */
async function seedRollupRow(
  workspaceId: string,
  day: string,
  deliveredCount: number,
  dirtiedAt: Date | null
): Promise<void> {
  await withTenant(workspaceId, () =>
    withTenantTransaction((client) =>
      client.query(
        `INSERT INTO workspace_daily_rollup (workspace_id, day, delivered_count, dirtied_at)
         VALUES ($1, $2::date, $3, $4)
         ON CONFLICT (workspace_id, day) DO UPDATE SET
           delivered_count = EXCLUDED.delivered_count,
           dirtied_at = EXCLUDED.dirtied_at`,
        [workspaceId, day, deliveredCount, dirtiedAt]
      )
    )
  );
}

async function readDeliveredCountAndDirtiedAt(
  workspaceId: string,
  day: string
): Promise<{ deliveredCount: number; dirtiedAt: Date | null } | null> {
  return withTenant(workspaceId, () =>
    withTenantTransaction(async (client) => {
      const { rows } = await client.query<{ deliveredCount: number; dirtiedAt: Date | null }>(
        `SELECT delivered_count as "deliveredCount", dirtied_at as "dirtiedAt"
           FROM workspace_daily_rollup WHERE workspace_id = $1 AND day = $2`,
        [workspaceId, day]
      );
      return rows[0] ?? null;
    })
  );
}

/**
 * CMP-03 (D-14, plan 13-05): the dirty-day marker. This file covers BOTH
 * halves of the mechanism:
 *
 * - Task 1's marking half: `incrementWorkspaceDailyRollup`'s `isNotToday`
 *   predicate decides whether a (workspace, day) rollup row's `dirtied_at`
 *   gets set, and the COALESCE-guarded upsert stops a burst of late events
 *   from pushing the mark forward.
 * - Task 2's sweep half (added below in a later block): the reconciliation
 *   tick's dirty-day sweep and its race-free conditional clear.
 *
 * Kept as ONE file per the plan's named artifact
 * (`apps/worker/src/queues/__tests__/analytics-reconciliation-dirty-day.test.ts`)
 * rather than split across two, since both halves exercise the same
 * `workspace_daily_rollup.dirtied_at` column end-to-end.
 */
describe("dirty-day marking (CMP-03, D-14, Task 1)", () => {
  let pool: Pool;

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

  interface RollupRow {
    dirtiedAt: Date | null;
    deliveredCount: number;
  }

  async function rollupRow(workspaceId: string, day: string): Promise<RollupRow | null> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<RollupRow>(
          `SELECT dirtied_at as "dirtiedAt", delivered_count as "deliveredCount"
           FROM workspace_daily_rollup WHERE workspace_id = $1 AND day = $2`,
          [workspaceId, day]
        );
        return rows[0] ?? null;
      })
    );
  }

  async function increment(workspaceId: string, occurredAt: string, now: Date): Promise<void> {
    await withTenant(workspaceId, () =>
      withTenantTransaction((client: PoolClient) =>
        incrementWorkspaceDailyRollup(client, workspaceId, occurredAt, "delivered", now)
      )
    );
  }

  const FIXED_NOW = new Date("2026-08-11T12:00:00.000Z");
  const TODAY = "2026-08-11";
  const YESTERDAY = "2026-08-10";
  const FIVE_DAYS_AGO = "2026-08-06";

  describe("isNotToday (pure, injected clock)", () => {
    it("is false for a YYYY-MM-DD equal to now's UTC calendar day", () => {
      expect(isNotToday("2026-08-11", new Date("2026-08-11T23:59:00.000Z"))).toBe(false);
    });

    it("is true for every other day", () => {
      expect(isNotToday("2026-08-11", new Date("2026-08-12T00:01:00.000Z"))).toBe(true);
    });
  });

  describe("incrementWorkspaceDailyRollup", () => {
    it("occurredAt 5 days in the past sets dirtied_at to a non-null timestamp", async () => {
      const workspaceId = await freshWorkspaceId("dirty-5-days-ago");
      await increment(workspaceId, `${FIVE_DAYS_AGO}T10:00:00.000Z`, FIXED_NOW);

      const row = await rollupRow(workspaceId, FIVE_DAYS_AGO);
      expect(row?.dirtiedAt).not.toBeNull();
      expect(row?.deliveredCount).toBe(1);
    });

    it("occurredAt earlier today leaves dirtied_at null", async () => {
      const workspaceId = await freshWorkspaceId("dirty-today");
      await increment(workspaceId, `${TODAY}T08:00:00.000Z`, FIXED_NOW);

      const row = await rollupRow(workspaceId, TODAY);
      expect(row?.dirtiedAt).toBeNull();
      expect(row?.deliveredCount).toBe(1);
    });

    it("occurredAt from yesterday sets dirtied_at to a non-null timestamp", async () => {
      const workspaceId = await freshWorkspaceId("dirty-yesterday");
      await increment(workspaceId, `${YESTERDAY}T23:00:00.000Z`, FIXED_NOW);

      const row = await rollupRow(workspaceId, YESTERDAY);
      expect(row?.dirtiedAt).not.toBeNull();
      expect(row?.deliveredCount).toBe(1);
    });

    it("two late increments on the same day do not push dirtied_at forward past the first mark, and the additive count still applies", async () => {
      const workspaceId = await freshWorkspaceId("dirty-double-mark");

      await increment(workspaceId, `${FIVE_DAYS_AGO}T10:00:00.000Z`, FIXED_NOW);
      const first = await rollupRow(workspaceId, FIVE_DAYS_AGO);
      expect(first?.dirtiedAt).not.toBeNull();

      // A second late increment on the SAME day, at a distinctly later real
      // wall-clock moment -- would push dirtied_at forward if the upsert's
      // COALESCE were missing.
      await new Promise((resolve) => setTimeout(resolve, 20));
      await increment(workspaceId, `${FIVE_DAYS_AGO}T11:00:00.000Z`, FIXED_NOW);
      const second = await rollupRow(workspaceId, FIVE_DAYS_AGO);

      expect(second?.dirtiedAt?.getTime()).toBe(first?.dirtiedAt?.getTime());
      expect(second?.deliveredCount).toBe(2);
    });
  });
});

/**
 * Task 2 -- the reconciliation tick's dirty-day sweep and its race-free
 * conditional clear. `reconcileWorkspace` (exported test-only) is exactly
 * "one tick" for one workspace, the same unit the worker processor loops
 * over per discovered workspace.
 */
describe("dirty-day sweep (CMP-03, D-14, Task 2)", () => {
  let pool: Pool;

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

  it("a dirty 5-day-old day with a wrong stored count is overwritten from a fresh scan and dirtied_at is cleared", async () => {
    const workspaceId = await freshWorkspaceId("sweep-dirty-overwrite");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const day = utcDateString(5);

    await createFixtureSend(workspaceId, campaignId, contactId, `${day}T10:00:00.000Z`);
    // A wrong stored count, deliberately in conflict with the one real send
    // above, marked dirty with a timestamp safely in the past (predates the
    // sweep this test is about to run).
    await seedRollupRow(workspaceId, day, 999, new Date(Date.now() - 60_000));

    await reconcileWorkspace(workspaceId, RECONCILE_WINDOW_DAYS);

    const row = await readDeliveredCountAndDirtiedAt(workspaceId, day);
    expect(row?.deliveredCount).toBe(1);
    expect(row?.dirtiedAt).toBeNull();
  });

  it("a non-dirty 5-day-old day with a wrong stored count is left untouched", async () => {
    const workspaceId = await freshWorkspaceId("sweep-non-dirty-untouched");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const day = utcDateString(5);

    await createFixtureSend(workspaceId, campaignId, contactId, `${day}T10:00:00.000Z`);
    await seedRollupRow(workspaceId, day, 999, null);

    await reconcileWorkspace(workspaceId, RECONCILE_WINDOW_DAYS);

    const row = await readDeliveredCountAndDirtiedAt(workspaceId, day);
    expect(row?.deliveredCount).toBe(999);
    expect(row?.dirtiedAt).toBeNull();
  });

  it("today and yesterday are reconciled on every tick regardless of an unrelated dirty mark", async () => {
    const workspaceId = await freshWorkspaceId("sweep-standing-window-always");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const today = utcDateString(0);
    const farDay = utcDateString(30);

    await createFixtureSend(workspaceId, campaignId, contactId, `${today}T10:00:00.000Z`);
    await seedRollupRow(workspaceId, today, 999, null); // wrong, never marked dirty
    await seedRollupRow(workspaceId, farDay, 5, new Date(Date.now() - 60_000)); // unrelated dirty day, no matching send

    await reconcileWorkspace(workspaceId, RECONCILE_WINDOW_DAYS);

    const todayRow = await readDeliveredCountAndDirtiedAt(workspaceId, today);
    expect(todayRow?.deliveredCount).toBe(1);

    const farDayRow = await readDeliveredCountAndDirtiedAt(workspaceId, farDay);
    expect(farDayRow?.deliveredCount).toBe(0); // overwritten by the fresh scan too (it was swept as a dirty day)
    expect(farDayRow?.dirtiedAt).toBeNull();
  });

  it("a single tick reconciles at most DIRTY_DAY_SWEEP_PAGE_LIMIT dirty days, leaving the remainder still marked", async () => {
    const workspaceId = await freshWorkspaceId("sweep-page-limit");
    const totalDirtyDays = DIRTY_DAY_SWEEP_PAGE_LIMIT + 5;
    // Days 1000, 1001, ... days before the real "today" -- far enough in the
    // past that none can ever collide with the standing today/yesterday
    // window, regardless of when this test actually runs. `utcDateString`
    // guarantees a distinct calendar day per distinct offset.
    const days: string[] = [];
    for (let i = 0; i < totalDirtyDays; i++) {
      days.push(utcDateString(1000 + i));
    }
    expect(new Set(days).size).toBe(totalDirtyDays);

    for (const day of days) {
      await seedRollupRow(workspaceId, day, 1, new Date(Date.now() - 60_000));
    }

    await reconcileWorkspace(workspaceId, RECONCILE_WINDOW_DAYS);

    let clearedCount = 0;
    let stillDirtyCount = 0;
    for (const day of days) {
      const row = await readDeliveredCountAndDirtiedAt(workspaceId, day);
      if (row?.dirtiedAt === null) clearedCount++;
      else stillDirtyCount++;
    }

    expect(clearedCount).toBe(DIRTY_DAY_SWEEP_PAGE_LIMIT);
    expect(stillDirtyCount).toBe(5);
  });

  it("clearDirtyRollupDays: a mark written strictly after sweepStartedAt survives the clear", async () => {
    const workspaceId = await freshWorkspaceId("sweep-race-survives");
    const day = utcDateString(10);
    await seedRollupRow(workspaceId, day, 1, null);

    await withTenant(workspaceId, () =>
      withTenantTransaction(async (client: PoolClient) => {
        const { rows } = await client.query<{ now: Date }>(`SELECT now() as now`);
        const sweepStartedAt = rows[0].now;

        // Deterministic interleaving: drive the sweep's own discovery query
        // first (as `reconcileWorkspace` would), THEN inject a late mark
        // with an EXPLICIT timestamp strictly after `sweepStartedAt` (never
        // `now()` again inside this same transaction -- `now()` is frozen
        // for the transaction's duration and would equal sweepStartedAt),
        // THEN run the clear.
        await findDirtyRollupDays(client, DIRTY_DAY_SWEEP_PAGE_LIMIT);
        await client.query(
          `UPDATE workspace_daily_rollup SET dirtied_at = $1::timestamptz + interval '1 second'
             WHERE workspace_id = $2 AND day = $3::date`,
          [sweepStartedAt, workspaceId, day]
        );
        await clearDirtyRollupDays(client, sweepStartedAt, [day]);
      })
    );

    const row = await readDeliveredCountAndDirtiedAt(workspaceId, day);
    expect(row?.dirtiedAt).not.toBeNull();
  });

  it("clearDirtyRollupDays: a mark written strictly before sweepStartedAt is null afterwards", async () => {
    const workspaceId = await freshWorkspaceId("sweep-race-cleared");
    const day = utcDateString(10);
    await seedRollupRow(workspaceId, day, 1, new Date(Date.now() - 60_000));

    await withTenant(workspaceId, () =>
      withTenantTransaction(async (client: PoolClient) => {
        const { rows } = await client.query<{ now: Date }>(`SELECT now() as now`);
        const sweepStartedAt = rows[0].now;
        await clearDirtyRollupDays(client, sweepStartedAt, [day]);
      })
    );

    const row = await readDeliveredCountAndDirtiedAt(workspaceId, day);
    expect(row?.dirtiedAt).toBeNull();
  });
});
