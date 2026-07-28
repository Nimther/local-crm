import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";

/**
 * 07-07/ANLT-04: the workspace dashboard endpoint. Verifies the trend series
 * is dense (zero-filled) and reads ONLY from `workspace_daily_rollup` (never
 * a live scan of `sends`/`send_events`), the growth series is a dense
 * cumulative-all-contacts line derived from `contacts.created_at`, period
 * KPIs are correctly summed/rated, and the `period` query param is
 * validated to the closed set 7|30|90.
 */
describe("Workspace dashboard (07-07, ANLT-04)", () => {
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

  /** Directly inserts/increments a workspace_daily_rollup row (mirrors the worker's own upsert shape) -- this endpoint never writes rollups itself, only reads them. */
  async function insertRollupRow(
    workspaceId: string,
    day: Date,
    counts: { sent?: number; delivered?: number; opened?: number; unsubscribed?: number }
  ) {
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(
          `INSERT INTO workspace_daily_rollup (workspace_id, day, sent_count, delivered_count, opened_count, unsubscribed_count)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            workspaceId,
            toDayString(day),
            counts.sent ?? 0,
            counts.delivered ?? 0,
            counts.opened ?? 0,
            counts.unsubscribed ?? 0,
          ]
        )
      )
    );
  }

  /** Directly inserts a contact with an explicit created_at (the CRUD API always uses now(), so growth-series tests need direct control over the day bucket). */
  async function insertContactAt(workspaceId: string, email: string, createdAt: Date) {
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(
          `INSERT INTO contacts (workspace_id, email, created_at, updated_at)
           VALUES ($1, $2, $3, $3)`,
          [workspaceId, email, createdAt]
        )
      )
    );
  }

  function dashboardUrl(slug: string, period?: number) {
    return `/api/workspaces/${slug}/dashboard${period !== undefined ? `?period=${period}` : ""}`;
  }

  it("returns a dense rollup-backed trend, cumulative growth, and period KPIs for period=7", async () => {
    const { cookie, workspace } = await owner("dashboard-basic");

    // Rollup rows only on day-0 (today) and day-3 -- days 1,2,4,5,6 must
    // still appear in the dense trend series with zero counts.
    await insertRollupRow(workspace.id, daysAgo(0), { sent: 10, delivered: 8, opened: 4, unsubscribed: 1 });
    await insertRollupRow(workspace.id, daysAgo(3), { sent: 5, delivered: 5, opened: 2, unsubscribed: 0 });

    // A contact baseline created well before the 7-day window (must fold
    // into the growth series' starting cumulative total, not be counted as
    // a "new" contact in the window).
    await insertContactAt(workspace.id, `baseline-${Date.now()}@example.com`, daysAgo(30));
    // Two new contacts inside the window: one today, one 3 days ago.
    await insertContactAt(workspace.id, `new-today-${Date.now()}@example.com`, daysAgo(0));
    await insertContactAt(workspace.id, `new-3d-${Date.now()}@example.com`, daysAgo(3));

    const res = await app.inject({
      method: "GET",
      url: dashboardUrl(workspace.slug, 7),
      headers: { cookie },
    });
    expect(res.statusCode, `dashboard failed: ${res.body}`).toBe(200);
    const body = res.json<{
      trend: Array<{ day: string; sent: number; delivered: number; opened: number }>;
      growth: Array<{ day: string; newContacts: number; cumulativeContacts: number }>;
      kpis: { sent: number; deliveredRate: number | null; openedRate: number | null; newContacts: number; unsubscribes: number };
      recentCampaigns: unknown[];
      activeFlows: unknown[];
    }>();

    // Dense series: 7 days, no gaps.
    expect(body.trend).toHaveLength(7);
    expect(body.growth).toHaveLength(7);

    const todayStr = toDayString(daysAgo(0));
    const day3Str = toDayString(daysAgo(3));
    const day1Str = toDayString(daysAgo(1));

    const todayTrend = body.trend.find((t) => t.day === todayStr)!;
    expect(todayTrend.sent).toBe(10);
    expect(todayTrend.delivered).toBe(8);
    expect(todayTrend.opened).toBe(4);

    const day3Trend = body.trend.find((t) => t.day === day3Str)!;
    expect(day3Trend.sent).toBe(5);

    // A day with no rollup row at all is zero-filled, not missing.
    const day1Trend = body.trend.find((t) => t.day === day1Str)!;
    expect(day1Trend.sent).toBe(0);
    expect(day1Trend.delivered).toBe(0);
    expect(day1Trend.opened).toBe(0);

    // Growth: baseline (1 contact from 30 days ago) plus 2 in-window new
    // contacts -- cumulative walks 1 -> 2 (today's new contact, oldest-first
    // ordering means day -6 first) ... final day (today) must be baseline+2.
    const todayGrowth = body.growth.find((g) => g.day === todayStr)!;
    expect(todayGrowth.newContacts).toBe(1);
    expect(todayGrowth.cumulativeContacts).toBe(3); // 1 baseline + 2 in-window

    const day3Growth = body.growth.find((g) => g.day === day3Str)!;
    expect(day3Growth.newContacts).toBe(1);

    const day1Growth = body.growth.find((g) => g.day === day1Str)!;
    expect(day1Growth.newContacts).toBe(0);

    // KPIs.
    expect(body.kpis.sent).toBe(15); // 10 + 5
    expect(body.kpis.deliveredRate).toBe(computeRate(13, 15));
    expect(body.kpis.openedRate).toBe(computeRate(6, 13));
    expect(body.kpis.newContacts).toBe(2);
    expect(body.kpis.unsubscribes).toBe(1);

    expect(Array.isArray(body.recentCampaigns)).toBe(true);
    expect(Array.isArray(body.activeFlows)).toBe(true);
  });

  it("defaults period to 30 and rejects an out-of-set period with 400", async () => {
    const { cookie, workspace } = await owner("dashboard-period-validation");

    const defaultRes = await app.inject({
      method: "GET",
      url: dashboardUrl(workspace.slug),
      headers: { cookie },
    });
    expect(defaultRes.statusCode, `default period failed: ${defaultRes.body}`).toBe(200);
    const defaultBody = defaultRes.json<{ trend: unknown[]; growth: unknown[] }>();
    expect(defaultBody.trend).toHaveLength(30);
    expect(defaultBody.growth).toHaveLength(30);

    const invalidRes = await app.inject({
      method: "GET",
      url: dashboardUrl(workspace.slug, 15),
      headers: { cookie },
    });
    expect(invalidRes.statusCode).toBe(400);
  });

  it("returns an all-zero series for a workspace with zero sends and zero contacts beyond the owner's own signup", async () => {
    const { cookie, workspace } = await owner("dashboard-empty");

    const res = await app.inject({
      method: "GET",
      url: dashboardUrl(workspace.slug, 7),
      headers: { cookie },
    });
    expect(res.statusCode, `dashboard failed: ${res.body}`).toBe(200);
    const body = res.json<{
      trend: Array<{ sent: number; delivered: number; opened: number }>;
      kpis: { sent: number; unsubscribes: number };
      recentCampaigns: unknown[];
      activeFlows: unknown[];
    }>();

    expect(body.trend.every((t) => t.sent === 0 && t.delivered === 0 && t.opened === 0)).toBe(true);
    expect(body.kpis.sent).toBe(0);
    expect(body.kpis.unsubscribes).toBe(0);
    expect(body.recentCampaigns).toHaveLength(0);
    expect(body.activeFlows).toHaveLength(0);
  });
});

function computeRate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 100);
}
