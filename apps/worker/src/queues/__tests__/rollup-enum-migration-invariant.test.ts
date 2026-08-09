import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { reconcileWorkspaceDay } from "../analytics-reconciliation.worker.js";
import {
  freshWorkspaceId,
  createFixtureCampaign,
  createFixtureContact,
} from "../../test/failure-fixtures.js";

/**
 * Phase 11, plan 11-02 (Pitfall 2, locked) — the executable form of the
 * requirement that adding the `reconciling`/`unknown` enum values moves NO
 * `workspace_daily_rollup` number. `reconcileWorkspaceDay`
 * (`analytics-reconciliation.worker.ts`) is entirely fact-column-driven
 * (`sent_at IS NOT NULL`, `delivered_at IS NOT NULL`, etc.) rather than
 * `status`-driven, so a row sitting in the two brand-new statuses can only
 * ever affect a rollup count through whichever fact columns it happens to
 * carry -- never through its `status` value alone. This suite proves that
 * property rather than assuming it.
 */
describe("workspace_daily_rollup enum-migration invariant (11-02, Pitfall 2)", () => {
  let pool: Pool;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    pool = createTestPool();
  });

  afterAll(async () => {
    await pool.end();
  });

  // Noon-UTC fixture timestamp, same convention as
  // analytics-rollup-reconciliation-invariant.test.ts: side-steps any
  // session-timezone `::date` cast ambiguity at the day boundary.
  const FIXED_TIMESTAMP_MS = 1_768_478_400_000; // -> 2026-01-15T12:00:00.000Z
  const FIXED_DATE = new Date(FIXED_TIMESTAMP_MS);
  const DAY = FIXED_DATE.toISOString().slice(0, 10);

  interface SendFactColumns {
    status: "sent" | "failed" | "excluded" | "reconciling" | "unknown";
    sentAt?: Date;
    deliveredAt?: Date;
    firstOpenedAt?: Date;
    firstClickedAt?: Date;
    bouncedAt?: Date;
    unsubscribedAt?: Date;
  }

  async function insertFixtureSend(
    workspaceId: string,
    campaignId: string,
    contactId: string,
    columns: SendFactColumns,
  ): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO sends (
             workspace_id, campaign_id, contact_id, kind, status,
             sent_at, delivered_at, first_opened_at, first_clicked_at, bounced_at, unsubscribed_at
           )
           VALUES ($1, $2, $3, 'campaign', $4::send_status, $5, $6, $7, $8, $9, $10)
           RETURNING id`,
          [
            workspaceId,
            campaignId,
            contactId,
            columns.status,
            columns.sentAt ?? null,
            columns.deliveredAt ?? null,
            columns.firstOpenedAt ?? null,
            columns.firstClickedAt ?? null,
            columns.bouncedAt ?? null,
            columns.unsubscribedAt ?? null,
          ],
        );
        return rows[0].id;
      }),
    );
  }

  interface RollupCounts {
    sentCount: number;
    deliveredCount: number;
    openedCount: number;
    clickedCount: number;
    bouncedCount: number;
    unsubscribedCount: number;
  }

  async function rollupCountsFor(workspaceId: string, day: string): Promise<RollupCounts | null> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<RollupCounts>(
          `SELECT
             sent_count AS "sentCount",
             delivered_count AS "deliveredCount",
             opened_count AS "openedCount",
             clicked_count AS "clickedCount",
             bounced_count AS "bouncedCount",
             unsubscribed_count AS "unsubscribedCount"
           FROM workspace_daily_rollup
           WHERE workspace_id = $1 AND day = $2`,
          [workspaceId, day],
        );
        return rows[0] ?? null;
      }),
    );
  }

  async function runReconcile(workspaceId: string, day: string): Promise<RollupCounts> {
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) => reconcileWorkspaceDay(client, workspaceId, day)),
    );
    const counts = await rollupCountsFor(workspaceId, day);
    expect(counts, "reconcileWorkspaceDay must always produce a row for a workspace with sends").not.toBeNull();
    return counts as RollupCounts;
  }

  it(
    "reconcileWorkspaceDay produces IDENTICAL counts across all six columns before and after " +
      "a 'reconciling' row, and again after an 'unknown' row with no fact columns set",
    async () => {
      const workspaceId = await freshWorkspaceId(pool, "rollup-enum-invariant-neutral");
      const campaignId = await createFixtureCampaign(workspaceId);

      // Baseline ledger: one of each PRE-Phase-11 terminal status, with the
      // fact columns a real send of that kind would carry.
      const sentContactId = await createFixtureContact(workspaceId);
      await insertFixtureSend(workspaceId, campaignId, sentContactId, {
        status: "sent",
        sentAt: FIXED_DATE,
        deliveredAt: FIXED_DATE,
        firstOpenedAt: FIXED_DATE,
        firstClickedAt: FIXED_DATE,
      });

      const bouncedContactId = await createFixtureContact(workspaceId);
      await insertFixtureSend(workspaceId, campaignId, bouncedContactId, {
        status: "sent",
        sentAt: FIXED_DATE,
        bouncedAt: FIXED_DATE,
      });

      const failedContactId = await createFixtureContact(workspaceId);
      await insertFixtureSend(workspaceId, campaignId, failedContactId, { status: "failed" });

      const excludedContactId = await createFixtureContact(workspaceId);
      await insertFixtureSend(workspaceId, campaignId, excludedContactId, { status: "excluded" });

      const baseline = await runReconcile(workspaceId, DAY);
      expect(baseline).toEqual({
        sentCount: 2,
        deliveredCount: 1,
        openedCount: 1,
        clickedCount: 1,
        bouncedCount: 1,
        unsubscribedCount: 0,
      });

      // Insert a 'reconciling' row with NO fact columns -- the ambiguous
      // in-flight state a crash/timeout produces before any webhook
      // evidence has arrived. Must move nothing.
      const reconcilingContactId = await createFixtureContact(workspaceId);
      await insertFixtureSend(workspaceId, campaignId, reconcilingContactId, { status: "reconciling" });

      const afterReconciling = await runReconcile(workspaceId, DAY);
      expect(afterReconciling, "a bare 'reconciling' row must not move any rollup count").toEqual(baseline);

      // Insert an 'unknown' row with NO fact columns -- the resolution
      // window elapsed with no evidence ever found. Must ALSO move nothing.
      const unknownContactId = await createFixtureContact(workspaceId);
      await insertFixtureSend(workspaceId, campaignId, unknownContactId, { status: "unknown" });

      const afterUnknown = await runReconcile(workspaceId, DAY);
      expect(afterUnknown, "a bare 'unknown' row must not move any rollup count either").toEqual(baseline);
    },
  );

  it(
    "a 'sends' row with status = 'unknown' but a non-null delivered_at STILL contributes to " +
      "delivered_count -- the rollup is fact-driven, deliberately, not status-driven",
    async () => {
      const workspaceId = await freshWorkspaceId(pool, "rollup-enum-invariant-fact-driven");
      const campaignId = await createFixtureCampaign(workspaceId);

      const contactId = await createFixtureContact(workspaceId);
      await insertFixtureSend(workspaceId, campaignId, contactId, {
        status: "unknown",
        deliveredAt: FIXED_DATE,
      });

      const counts = await runReconcile(workspaceId, DAY);

      // sent_count stays 0: this row's status is 'unknown', not 'sent', and
      // reconcileWorkspaceDay's sent_count filter is `sent_at IS NOT NULL`
      // -- this fixture deliberately leaves sent_at null to isolate the
      // delivered_at-only contribution the test title describes.
      expect(counts.sentCount).toBe(0);
      expect(counts.deliveredCount, "delivered_at IS NOT NULL must count regardless of status").toBe(1);
      expect(counts.openedCount).toBe(0);
      expect(counts.clickedCount).toBe(0);
      expect(counts.bouncedCount).toBe(0);
      expect(counts.unsubscribedCount).toBe(0);
    },
  );
});
