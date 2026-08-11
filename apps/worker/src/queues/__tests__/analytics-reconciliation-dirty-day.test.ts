import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { insertFixtureOrganization } from "../../test/failure-fixtures.js";
import { incrementWorkspaceDailyRollup, isNotToday } from "@mega-crm/db/src/analytics/daily-rollup.js";

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
