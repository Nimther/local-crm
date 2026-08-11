import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getScanTestDatabaseUrl } from "@mega-crm/test-support";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { insertFixtureOrganization, createFixtureContact } from "../../test/failure-fixtures.js";
import { runReputationTick, computeWorkspaceReputation, recordReputationObservation } from "../reputation-tick.worker.js";
import { classifyReputationRate, REPUTATION_WINDOW_DAYS } from "@mega-crm/delivery-core";

/**
 * Phase 13 (CMP-09, D-09 through D-12, plan 13-09), Task 3: proves
 * `runReputationTick`'s discovery-plus-per-workspace compute/tier/record
 * pipeline end-to-end against a real (ephemeral) Postgres database.
 *
 * Every assertion here is scoped to workspace ids this test itself creates
 * and passes through `runReputationTick`'s `workspaceIds` test-only override
 * -- the ephemeral test database is shared across parallel test files (this
 * project's own wave-context convention), so an unscoped cross-workspace
 * scan's counts would be flaky.
 *
 * Fixture timestamps are always relative to an injected `now` (never the
 * wall clock, and never a fixed 2023-era literal -- plan 13-04's
 * `classifyOccurredAt` quarantine window is irrelevant here since these rows
 * are inserted directly via SQL, not through event ingestion, but the
 * project-wide convention of runtime-relative fixture timestamps is kept
 * anyway for consistency).
 */
describe("reputation-tick.worker.ts (CMP-09, plan 13-09)", () => {
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

  /**
   * Bulk-seeds `count` sends for one workspace, all sharing ONE fixture
   * contact and a NULL `campaign_id` -- `sends_workspace_campaign_contact_unique`
   * treats every NULL `campaign_id` as distinct (Postgres unique-constraint
   * NULL semantics), so this never collides regardless of how many rows
   * share the same contact.
   */
  async function seedSends(
    workspaceId: string,
    contactId: string,
    count: number,
    overrides: { deliveredAt?: Date | null; spamReportedAt?: Date | null; bouncedAt?: Date | null } = {},
  ): Promise<void> {
    if (count === 0) return;
    await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        await client.query(
          `INSERT INTO sends (workspace_id, contact_id, kind, status, delivered_at, spam_reported_at, bounced_at)
           SELECT $1, $2, 'campaign', 'sent', $3, $4, $5
           FROM generate_series(1, $6)`,
          [
            workspaceId,
            contactId,
            overrides.deliveredAt ?? null,
            overrides.spamReportedAt ?? null,
            overrides.bouncedAt ?? null,
            count,
          ],
        );
      }),
    );
  }

  async function readObservation(
    workspaceId: string,
    metric: string,
  ): Promise<
    | {
        observedTier: string | null;
        observedRate: string | null;
        observedNumerator: number | null;
        observedDenominator: number | null;
        alertedTier: string | null;
        lastAlertSentAt: Date | null;
      }
    | undefined
  > {
    const { rows } = await pool.query(
      `SELECT observed_tier as "observedTier", observed_rate as "observedRate",
              observed_numerator as "observedNumerator", observed_denominator as "observedDenominator",
              alerted_tier as "alertedTier", last_alert_sent_at as "lastAlertSentAt"
       FROM reputation_alert_state WHERE workspace_id = $1 AND metric = $2`,
      [workspaceId, metric],
    );
    return rows[0];
  }

  it("one tick over a workspace with 1000 delivered and 3 spam-reported sends in-window records complaint_rate at tier critical", async () => {
    const workspaceId = await freshWorkspaceId("rep-tick-critical");
    const contactId = await createFixtureContact(workspaceId);
    const now = new Date();
    const inWindow = new Date(now.getTime() - 2 * 24 * 60 * 60_000);

    await seedSends(workspaceId, contactId, 997, { deliveredAt: inWindow });
    await seedSends(workspaceId, contactId, 3, { deliveredAt: inWindow, spamReportedAt: inWindow });

    await runReputationTick({ now, workspaceIds: [workspaceId] });

    const complaint = await readObservation(workspaceId, "complaint_rate");
    expect(complaint?.observedTier).toBe("critical");
    expect(complaint?.observedNumerator).toBe(3);
    expect(complaint?.observedDenominator).toBe(1000);
  });

  it("the same tick also records a separate hard_bounce_rate row from the same scan", async () => {
    const workspaceId = await freshWorkspaceId("rep-tick-both-metrics");
    const contactId = await createFixtureContact(workspaceId);
    const now = new Date();
    const inWindow = new Date(now.getTime() - 2 * 24 * 60 * 60_000);

    await seedSends(workspaceId, contactId, 1000, { deliveredAt: inWindow });

    await runReputationTick({ now, workspaceIds: [workspaceId] });

    const complaint = await readObservation(workspaceId, "complaint_rate");
    const hardBounce = await readObservation(workspaceId, "hard_bounce_rate");
    expect(complaint).toBeDefined();
    expect(hardBounce).toBeDefined();
    expect(hardBounce?.observedDenominator).toBe(1000);
  });

  it("sends whose fact timestamps fall outside the rolling window are excluded from both numerator and denominator", async () => {
    const workspaceId = await freshWorkspaceId("rep-tick-window-excl");
    const contactId = await createFixtureContact(workspaceId);
    const now = new Date();
    const inWindow = new Date(now.getTime() - 1 * 24 * 60 * 60_000);
    const outsideWindow = new Date(now.getTime() - (REPUTATION_WINDOW_DAYS + 5) * 24 * 60 * 60_000);

    // In-window: 500 delivered, 2 complaints.
    await seedSends(workspaceId, contactId, 498, { deliveredAt: inWindow });
    await seedSends(workspaceId, contactId, 2, { deliveredAt: inWindow, spamReportedAt: inWindow });
    // Outside the window entirely -- must not affect either count.
    await seedSends(workspaceId, contactId, 5000, { deliveredAt: outsideWindow });
    await seedSends(workspaceId, contactId, 50, { deliveredAt: outsideWindow, spamReportedAt: outsideWindow });

    await runReputationTick({ now, workspaceIds: [workspaceId] });

    const complaint = await readObservation(workspaceId, "complaint_rate");
    expect(complaint?.observedDenominator).toBe(500);
    expect(complaint?.observedNumerator).toBe(2);
  });

  it("a workspace with 100 delivered sends records tier none for both metrics (below the volume floor)", async () => {
    const workspaceId = await freshWorkspaceId("rep-tick-below-floor");
    const contactId = await createFixtureContact(workspaceId);
    const now = new Date();
    const inWindow = new Date(now.getTime() - 1 * 24 * 60 * 60_000);

    await seedSends(workspaceId, contactId, 100, { deliveredAt: inWindow });

    await runReputationTick({ now, workspaceIds: [workspaceId] });

    const complaint = await readObservation(workspaceId, "complaint_rate");
    const hardBounce = await readObservation(workspaceId, "hard_bounce_rate");
    expect(complaint?.observedTier).toBe("none");
    expect(complaint?.observedRate).toBeNull();
    expect(hardBounce?.observedTier).toBe("none");
    expect(hardBounce?.observedRate).toBeNull();
  });

  it("a second tick with no new sends overwrites the observation with identical values rather than accumulating", async () => {
    const workspaceId = await freshWorkspaceId("rep-tick-idempotent");
    const contactId = await createFixtureContact(workspaceId);
    const now = new Date();
    const inWindow = new Date(now.getTime() - 2 * 24 * 60 * 60_000);

    await seedSends(workspaceId, contactId, 500, { deliveredAt: inWindow });
    await seedSends(workspaceId, contactId, 10, { deliveredAt: inWindow, bouncedAt: inWindow });

    await runReputationTick({ now, workspaceIds: [workspaceId] });
    const first = await readObservation(workspaceId, "hard_bounce_rate");

    await runReputationTick({ now, workspaceIds: [workspaceId] });
    const second = await readObservation(workspaceId, "hard_bounce_rate");

    expect(second?.observedNumerator).toBe(first?.observedNumerator);
    expect(second?.observedDenominator).toBe(first?.observedDenominator);
    expect(second?.observedTier).toBe(first?.observedTier);
    expect(second?.observedRate).toBe(first?.observedRate);
  });

  it("the tick records an observation for a workspace with zero sends -- distinguishable from never having been measured", async () => {
    const workspaceId = await freshWorkspaceId("rep-tick-zero-sends");
    const now = new Date();

    await runReputationTick({ now, workspaceIds: [workspaceId] });

    const complaint = await readObservation(workspaceId, "complaint_rate");
    expect(complaint).toBeDefined();
    expect(complaint?.observedTier).toBe("none");
    expect(complaint?.observedDenominator).toBe(0);
  });

  it("the tick writes only observed_* columns and leaves alerted_tier/last_alert_sent_at untouched", async () => {
    const workspaceId = await freshWorkspaceId("rep-tick-disjoint-writers");
    const contactId = await createFixtureContact(workspaceId);
    const now = new Date();
    const inWindow = new Date(now.getTime() - 1 * 24 * 60 * 60_000);

    await seedSends(workspaceId, contactId, 500, { deliveredAt: inWindow });

    // Simulate plan 13-11's watchdog having already claimed an alert for this
    // workspace/metric before this tick runs.
    const alertSentAt = new Date();
    await pool.query(
      `INSERT INTO reputation_alert_state (workspace_id, metric, alerted_tier, last_alert_sent_at)
       VALUES ($1, 'complaint_rate', 'critical', $2)`,
      [workspaceId, alertSentAt],
    );

    await runReputationTick({ now, workspaceIds: [workspaceId] });

    const complaint = await readObservation(workspaceId, "complaint_rate");
    expect(complaint?.alertedTier).toBe("critical");
    expect(complaint?.lastAlertSentAt?.getTime()).toBe(alertSentAt.getTime());
    // The tick still updated the observed_* half of the same row.
    expect(complaint?.observedDenominator).toBe(500);
  });

  it("cross-tenant isolation: each workspace's own sends are counted, never a sibling's", async () => {
    const workspaceA = await freshWorkspaceId("rep-tick-tenant-a");
    const workspaceB = await freshWorkspaceId("rep-tick-tenant-b");
    const contactA = await createFixtureContact(workspaceA);
    const contactB = await createFixtureContact(workspaceB);
    const now = new Date();
    const inWindow = new Date(now.getTime() - 1 * 24 * 60 * 60_000);

    await seedSends(workspaceA, contactA, 600, { deliveredAt: inWindow });
    await seedSends(workspaceB, contactB, 700, { deliveredAt: inWindow });

    await runReputationTick({ now, workspaceIds: [workspaceA, workspaceB] });

    const a = await readObservation(workspaceA, "complaint_rate");
    const b = await readObservation(workspaceB, "complaint_rate");
    expect(a?.observedDenominator).toBe(600);
    expect(b?.observedDenominator).toBe(700);
  });

  it("computeWorkspaceReputation and recordReputationObservation compose to the same result runReputationTick produces", async () => {
    const workspaceId = await freshWorkspaceId("rep-tick-unit-compose");
    const contactId = await createFixtureContact(workspaceId);
    const now = new Date();
    const inWindow = new Date(now.getTime() - 1 * 24 * 60 * 60_000);

    await seedSends(workspaceId, contactId, 500, { deliveredAt: inWindow });
    await seedSends(workspaceId, contactId, 1, { deliveredAt: inWindow, spamReportedAt: inWindow });

    await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const counts = await computeWorkspaceReputation(client, now);
        expect(counts.complaintRate).toEqual({ numerator: 1, denominator: 501 });

        const observation = classifyReputationRate("complaint_rate", counts.complaintRate.numerator, counts.complaintRate.denominator);
        await recordReputationObservation(client, workspaceId, observation, now);
      }),
    );

    const complaint = await readObservation(workspaceId, "complaint_rate");
    expect(complaint?.observedNumerator).toBe(1);
    expect(complaint?.observedDenominator).toBe(501);
  });
});
