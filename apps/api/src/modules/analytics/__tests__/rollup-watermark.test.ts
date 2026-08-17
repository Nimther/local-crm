import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { incrementWorkspaceDailyRollup } from "@mega-crm/db/src/analytics/daily-rollup.js";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";

/**
 * Phase 15 (OPS-18, D-12, plan 15-12 Task 3) -- the rollup watermark
 * (migration 0064's `workspace_daily_rollup.updated_at`) and the two
 * dashboard response fields it backs: `dataAsOf` (the newest watermark
 * among the workspace's rows in the requested window) and `lagMinutes`
 * (the age of the oldest outstanding `dirtied_at` mark, never derived from
 * data age).
 *
 * The reconciliation overwrite path's OWN watermark assertion lives in
 * `apps/worker/src/queues/__tests__/analytics-reconciliation.test.ts`
 * (extended by this same plan, Rule 2 deviation -- `reconcileWorkspaceDay`
 * lives in `apps/worker`, which `apps/api` cannot import: `apps/worker`
 * declares `@mega-crm/api` as a devDependency, never the reverse, so a test
 * exercising that function must live in `apps/worker`'s own test tree). This
 * file covers the incremental path (`incrementWorkspaceDailyRollup`, which
 * `apps/api` DOES depend on directly via `@mega-crm/db`) plus every
 * dashboard-response behavior.
 */
describe("workspace_daily_rollup watermark and dashboard freshness signal (OPS-18, D-12)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function signUp(email: string, password: string, name: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email, password, name },
    });
    expect(res.statusCode, `sign-up failed: ${res.body}`).toBe(200);
    const sessionCookie = res.cookies.find((c) => c.name.toLowerCase().includes("session"));
    if (!sessionCookie) {
      throw new Error("sign-up response did not set a session cookie");
    }
    return { cookie: `${sessionCookie.name}=${sessionCookie.value}` };
  }

  async function createWorkspace(cookie: string, name: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { cookie },
      payload: { name },
    });
    expect(res.statusCode, `create workspace failed: ${res.body}`).toBe(200);
    return res.json<{ id: string; slug: string; name: string }>();
  }

  async function owner(nameSeed: string) {
    const email = `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const account = await signUp(email, "correct horse battery staple 42", nameSeed);
    const workspace = await createWorkspace(account.cookie, `${nameSeed} Co`);
    return { ...account, workspace };
  }

  function toDayString(date: Date): string {
    return date.toISOString().slice(0, 10);
  }

  function daysAgo(n: number): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - n));
  }

  /** Direct raw INSERT giving the test full control over `updated_at`/`dirtied_at` -- the dashboard endpoint never writes rollup rows itself, only reads them. */
  async function insertRollupRowWithTimestamps(
    workspaceId: string,
    day: Date,
    opts: { sent?: number; updatedAt?: Date; dirtiedAt?: Date | null },
  ) {
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(
          `INSERT INTO workspace_daily_rollup (workspace_id, day, sent_count, updated_at, dirtied_at)
           VALUES ($1, $2, $3, COALESCE($4, now()), $5)`,
          [workspaceId, toDayString(day), opts.sent ?? 0, opts.updatedAt ?? null, opts.dirtiedAt ?? null],
        ),
      ),
    );
  }

  async function readRollupRow(workspaceId: string, day: Date) {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ updated_at: Date }>(
          `SELECT updated_at FROM workspace_daily_rollup WHERE workspace_id = $1 AND day = $2`,
          [workspaceId, toDayString(day)],
        );
        return rows[0] ?? null;
      }),
    );
  }

  function dashboardUrl(slug: string, period?: number) {
    return `/api/workspaces/${slug}/dashboard${period !== undefined ? `?period=${period}` : ""}`;
  }

  async function getDashboard(cookie: string, slug: string) {
    const res = await app.inject({ method: "GET", url: dashboardUrl(slug, 7), headers: { cookie } });
    expect(res.statusCode, `dashboard failed: ${res.body}`).toBe(200);
    return res.json<{ dataAsOf: string | null; lagMinutes: number | null }>();
  }

  it("an incremental rollup increment sets the row's watermark to the write time -- including on the ON CONFLICT (already-existing-row) branch, not just a fresh INSERT's own column default", async () => {
    const { workspace } = await owner("watermark-incremental");
    const day = daysAgo(0);
    const staleWatermark = new Date(Date.now() - 24 * 60 * 60 * 1000); // 1 day ago

    // Seed a row for TODAY with a deliberately stale watermark. A fresh
    // INSERT's own column DEFAULT would trivially satisfy "sets the
    // watermark" without proving the increment path does -- this forces
    // `incrementWorkspaceDailyRollup` down its ON CONFLICT DO UPDATE branch,
    // which is the one that must carry its own explicit `updated_at = now()`.
    await insertRollupRowWithTimestamps(workspace.id, day, { sent: 0, updatedAt: staleWatermark, dirtiedAt: null });

    const before = new Date();
    await withTenant(workspace.id, () =>
      withTenantTransaction((client) =>
        incrementWorkspaceDailyRollup(client, workspace.id, day.toISOString(), "delivered"),
      ),
    );

    const row = await readRollupRow(workspace.id, day);
    expect(row).not.toBeNull();
    expect(row.updated_at.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(row.updated_at.getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
  });

  it("the dashboard response's data-as-of value equals the newest watermark among the workspace's rows in the requested window", async () => {
    const { cookie, workspace } = await owner("watermark-dataasof");
    const older = new Date(Date.now() - 3 * 60 * 60 * 1000); // 3h ago
    const newer = new Date(Date.now() - 5 * 60 * 1000); // 5m ago

    await insertRollupRowWithTimestamps(workspace.id, daysAgo(1), { sent: 1, updatedAt: older });
    await insertRollupRowWithTimestamps(workspace.id, daysAgo(0), { sent: 2, updatedAt: newer });

    const body = await getDashboard(cookie, workspace.slug);
    expect(body.dataAsOf).not.toBeNull();
    expect(new Date(body.dataAsOf!).getTime()).toBe(newer.getTime());
  });

  it("with no dirty days outstanding, the response reports no lag regardless of how old the newest rollup row is", async () => {
    const { cookie, workspace } = await owner("watermark-no-lag");
    const veryOld = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago

    await insertRollupRowWithTimestamps(workspace.id, daysAgo(0), { sent: 5, updatedAt: veryOld, dirtiedAt: null });

    const body = await getDashboard(cookie, workspace.slug);
    expect(body.lagMinutes).toBeNull();
  });

  it("with a dirty day outstanding, the response reports the age of the oldest outstanding dirty mark", async () => {
    const { cookie, workspace } = await owner("watermark-lag");
    const dirtiedAt = new Date(Date.now() - 45 * 60 * 1000); // 45 minutes ago

    await insertRollupRowWithTimestamps(workspace.id, daysAgo(1), {
      sent: 1,
      updatedAt: new Date(),
      dirtiedAt,
    });

    const body = await getDashboard(cookie, workspace.slug);
    expect(body.lagMinutes).not.toBeNull();
    // Real-clock timing: assert within a generous tolerance band rather than
    // exact equality.
    expect(body.lagMinutes!).toBeGreaterThan(40);
    expect(body.lagMinutes!).toBeLessThan(50);
  });

  it("a workspace with no rollup rows at all returns a null data-as-of and no lag rather than an error", async () => {
    const { cookie, workspace } = await owner("watermark-empty");

    const body = await getDashboard(cookie, workspace.slug);
    expect(body.dataAsOf).toBeNull();
    expect(body.lagMinutes).toBeNull();
  });
});
