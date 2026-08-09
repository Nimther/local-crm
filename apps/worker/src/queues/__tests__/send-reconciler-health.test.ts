import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import * as tenantContext from "@mega-crm/tenant-context";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { readLatestReconcilerRun } from "@mega-crm/db/src/reconciler/reconciler-run.js";
import {
  evaluateReconcilerHealth,
  RECONCILING_AGE_ALERT_HOURS,
} from "@mega-crm/api/src/modules/ops/send-reconciler-watchdog.js";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import {
  insertFixtureOrganization,
  connectFixtureSendgridKey,
  createFixtureCampaign,
  createFixtureContact,
} from "../../test/failure-fixtures.js";
import { runReconcilerTick } from "../send-reconciler.worker.js";

/**
 * Phase 11, plan 11-09 (D-14), task 3: proves `runReconcilerTick` writes the
 * `send_reconciler_runs` health row every completed tick -- liveness AND the
 * oldest-outstanding-ambiguity signal -- and that a throwing tick skips the
 * write entirely. The final case imports `evaluateReconcilerHealth` from the
 * API module (`@mega-crm/api`, a DIFFERENT process's own package) DIRECTLY,
 * rather than re-implementing the evaluator here, and asserts the
 * end-to-end signal -- worker writes, evaluator reads, verdict matches --
 * which is what makes this a two-process test rather than two
 * independently-passing halves.
 *
 * `sends` carries FORCE ROW LEVEL SECURITY (Phase 10) -- there is no legal
 * cross-tenant DELETE against it, even from an admin connection (T-11-09
 * mirrors Phase 10's own fail-closed design: an unscoped connection THROWS
 * rather than silently seeing nothing). Every fixture this file seeds is
 * therefore either resolved to a terminal, non-`reconciling` status by the
 * SAME tick that observes it (evidence-backed, or aged past the resolution
 * window), or explicitly deleted afterward via a tenant-scoped
 * `withTenant`/`withTenantTransaction` DELETE -- never a blanket query
 * against the shared pool. Tests run in file order deliberately: each one
 * leaves zero `reconciling` rows behind for the next.
 */
describe("send-reconciler.worker.ts writes the health row every tick (11-09, D-14)", () => {
  let pool: Pool;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    pool = createTestPool();
  });

  afterAll(async () => {
    await pool.end();
  });

  async function seedReconcilingSend(
    workspaceId: string,
    campaignId: string,
    contactId: string,
    reconcilingSinceAgoMs: number
  ): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO sends (workspace_id, campaign_id, contact_id, kind, status, queued_at, reconciling_since)
           VALUES ($1, $2, $3, 'campaign', 'reconciling', now() - ($4::bigint * INTERVAL '1 millisecond'), now() - ($4::bigint * INTERVAL '1 millisecond'))
           RETURNING id`,
          [workspaceId, campaignId, contactId, reconcilingSinceAgoMs]
        );
        return rows[0].id;
      })
    );
  }

  /** Correlated `send_events` evidence -- the ONLY thing that can move a `reconciling` row to `resolve_sent` (D-01/D-05). */
  async function insertSendEventEvidence(workspaceId: string, sendId: string): Promise<void> {
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(
          `INSERT INTO send_events (id, workspace_id, sg_event_id, send_id, event_type, payload, occurred_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'processed', '{}'::jsonb, now())`,
          [workspaceId, `sg-evt-${sendId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, sendId]
        )
      )
    );
  }

  /** Tenant-scoped cleanup (RLS-legal, unlike a cross-tenant DELETE) -- removes every `sends` row this test's own workspace created. */
  async function deleteSendsForWorkspace(workspaceId: string): Promise<void> {
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) => client.query(`DELETE FROM sends WHERE workspace_id = $1`, [workspaceId]))
    );
  }

  it("test 1: after one runReconcilerTick(), send_reconciler_runs has last_run_at within seconds of now and the four counters equal to the tick's own returned counts", async () => {
    const workspaceId = await insertFixtureOrganization("health-basic-write");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await seedReconcilingSend(workspaceId, campaignId, contactId, 60_000);
    // Evidence present -- this row resolves to 'sent' during the tick below,
    // leaving zero 'reconciling' rows behind for the next test.
    await insertSendEventEvidence(workspaceId, sendId);

    const before = new Date();
    const tick = await runReconcilerTick();
    const row = await readLatestReconcilerRun(pool);

    expect(row).not.toBeNull();
    expect(row?.lastRunAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(row?.lastRunAt.getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
    expect(row?.candidatesScanned).toBe(tick.scanned);
    expect(row?.rowsResolved).toBe(tick.resolvedSent);
    expect(row?.rowsMarkedUnknown).toBe(tick.markedUnknown);
    expect(row?.staleDispatchingSwept).toBe(tick.swept);
    expect(tick.resolvedSent).toBeGreaterThanOrEqual(1);
  });

  it("test 2: a tick that resolves nothing still writes the health row", async () => {
    // Test 1 left zero 'reconciling' rows behind (its own row resolved to
    // 'sent') -- this tick genuinely finds nothing to do.
    const before = new Date();
    const tick = await runReconcilerTick();
    expect(tick.resolvedSent).toBe(0);
    expect(tick.markedUnknown).toBe(0);
    expect(tick.swept).toBe(0);

    const row = await readLatestReconcilerRun(pool);
    expect(row).not.toBeNull();
    expect(row?.lastRunAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it("test 3: oldest_reconciling_since matches the true cross-workspace minimum -- null when no reconciling rows remain", async () => {
    // A ground-truth aggregate computed the SAME way production does (the
    // scan role, cross-workspace), independent of `runReconcilerTick`'s own
    // internal query -- this is what makes the assertion below a genuine
    // check rather than tautological. Deliberately NOT asserting a literal
    // `null` outright: this suite shares its database with every OTHER file
    // in the same `vitest run` invocation when run as part of the full
    // apps/worker suite, so asserting against the live ground truth (which
    // legitimately resolves to `null` when this file runs standalone, per
    // its own `<verify>` command) is correct in both contexts.
    await runReconcilerTick();
    const row = await readLatestReconcilerRun(pool);

    const groundTruth = await tenantContext.withCrossWorkspaceScan(async (client) => {
      const { rows } = await client.query<{ oldest: Date | null }>(
        `SELECT MIN(reconciling_since) AS oldest FROM sends WHERE status = 'reconciling'`
      );
      return rows[0]?.oldest ?? null;
    });

    expect(row?.oldestReconcilingSince?.getTime() ?? null).toBe(groundTruth?.getTime() ?? null);
  });

  it("test 4: oldest_reconciling_since after a tick equals the earliest reconciling_since among rows still reconciling, across workspaces", async () => {
    const workspaceId = await insertFixtureOrganization("health-oldest-reconciling");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);
    const olderContactId = await createFixtureContact(workspaceId);
    const newerContactId = await createFixtureContact(workspaceId);

    // Both ages are comfortably inside the resolution window (24h), so
    // neither transitions to 'unknown' during this tick -- they stay
    // 'reconciling', making the "still reconciling" comparison unambiguous.
    const olderAgoMs = 3 * 60 * 60 * 1000;
    const newerAgoMs = 30 * 60 * 1000;
    await seedReconcilingSend(workspaceId, campaignId, olderContactId, olderAgoMs);
    await seedReconcilingSend(workspaceId, campaignId, newerContactId, newerAgoMs);

    const beforeTick = new Date();
    await runReconcilerTick();
    const row = await readLatestReconcilerRun(pool);

    expect(row?.oldestReconcilingSince).not.toBeNull();
    // The observed oldest reconciling_since must be older than the newer
    // row's own seeded age -- confirms the MIN picked the older row, not
    // merely some row.
    const observedAgeMs = beforeTick.getTime() - (row?.oldestReconcilingSince?.getTime() ?? 0);
    expect(observedAgeMs).toBeGreaterThan(newerAgoMs);

    // Both rows are still 'reconciling' (neither has evidence, neither is
    // past the resolution window) -- explicit tenant-scoped cleanup so
    // nothing leaks into the next test.
    await deleteSendsForWorkspace(workspaceId);
  });

  it("test 5: the health-row write does not clear a previously set last_alert_sent_at", async () => {
    const alertSentAt = new Date();
    await pool.query(`UPDATE send_reconciler_runs SET last_alert_sent_at = $1 WHERE id = 1`, [alertSentAt]);

    await runReconcilerTick();

    const row = await readLatestReconcilerRun(pool);
    expect(row?.lastAlertSentAt?.getTime()).toBe(alertSentAt.getTime());
  });

  it("test 6: a tick that throws does not write a health row -- last_run_at is unchanged", async () => {
    // Establish a known-good baseline row first.
    await runReconcilerTick();
    const baseline = await readLatestReconcilerRun(pool);
    expect(baseline).not.toBeNull();

    // Force the discovery step itself to throw. Cross-module spying (this
    // file and send-reconciler.worker.ts both import the SAME
    // `@mega-crm/tenant-context` module instance) is the reliable Vitest ESM
    // mocking pattern -- unlike spying on a function exported from the
    // SAME module that calls it internally via its own local binding.
    const spy = vi
      .spyOn(tenantContext, "withCrossWorkspaceScan")
      .mockRejectedValueOnce(new Error("test-injected discovery failure"));

    try {
      await expect(runReconcilerTick()).rejects.toThrow("test-injected discovery failure");
    } finally {
      spy.mockRestore();
    }

    const afterFailedTick = await readLatestReconcilerRun(pool);
    expect(afterFailedTick?.lastRunAt.getTime()).toBe(baseline?.lastRunAt.getTime());
  });

  it("test 7 (end-to-end, two-process proof): evaluateReconcilerHealth over the row a real tick writes reports healthy, and reports reconciling_backlog_aged after back-dating", async () => {
    await runReconcilerTick();
    const healthyRow = await readLatestReconcilerRun(pool);
    const healthyResult = evaluateReconcilerHealth(healthyRow, new Date(), {
      staleThresholdMinutes: 30,
      reconcilingAgeAlertHours: RECONCILING_AGE_ALERT_HOURS,
    });
    expect(healthyResult.healthy).toBe(true);

    // Back-date a reconciling row's reconciling_since past
    // RECONCILING_AGE_ALERT_HOURS. This row is ALSO past the 24h resolution
    // window (30h > 24h), so it will resolve to 'unknown' during THIS same
    // tick -- that is fine and expected, and leaves zero 'reconciling' rows
    // behind afterward: the health row's oldest_reconciling_since is
    // captured at DISCOVERY time (before this tick resolves anything), so
    // it still reflects the old age this test seeded, exactly per D-14's
    // own "oldest outstanding ... it observed" phrasing.
    const workspaceId = await insertFixtureOrganization("health-backlog-aged");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const agedMs = (RECONCILING_AGE_ALERT_HOURS + 1) * 60 * 60 * 1000;
    await seedReconcilingSend(workspaceId, campaignId, contactId, agedMs);

    const now = new Date();
    await runReconcilerTick();
    const agedRow = await readLatestReconcilerRun(pool);
    const agedResult = evaluateReconcilerHealth(agedRow, now, {
      staleThresholdMinutes: 30,
      reconcilingAgeAlertHours: RECONCILING_AGE_ALERT_HOURS,
    });

    expect(agedResult.healthy).toBe(false);
    expect(agedResult.reasons).toContain("reconciling_backlog_aged");
  });
});
