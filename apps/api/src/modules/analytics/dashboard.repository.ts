import type { WorkspaceDashboardFreshness } from "@mega-crm/shared-schemas";
import { getWorkspaceId, withTenantTransaction } from "../../middleware/tenant-context.js";

const RECENT_CAMPAIGNS_LIMIT = 5;
const ACTIVE_FLOWS_LIMIT = 5;

export type DashboardPeriod = 7 | 30 | 90;

export interface DashboardTrendPoint {
  day: string; // YYYY-MM-DD (UTC)
  sent: number;
  delivered: number;
  opened: number;
}

/** RESEARCH.md Open Question 1 default: `newContacts` is the day's raw signups, `cumulativeContacts` is a running total of ALL contacts ever created (not net of unsubscribes). */
export interface DashboardGrowthPoint {
  day: string; // YYYY-MM-DD (UTC)
  newContacts: number;
  cumulativeContacts: number;
}

export interface DashboardKpis {
  sent: number;
  deliveredRate: number | null;
  openedRate: number | null;
  newContacts: number;
  unsubscribes: number;
}

export interface DashboardRecentCampaign {
  id: string;
  name: string;
  status: string;
  sentCount: number;
  deliveredRate: number | null;
  openedRate: number | null;
  clickedRate: number | null;
}

export interface DashboardActiveFlow {
  id: string;
  name: string;
  activeRuns: number;
  emailsSent: number;
}

/**
 * WR-06 / D-01 (Phase 17 plan 02): `contacts.created_at` is a naive
 * `timestamp without time zone` column (packages/db/src/schema/contacts.ts).
 * A SINGLE `AT TIME ZONE 'UTC'` hop on a naive column produces a
 * `timestamptz`, and casting THAT to `::date` converts to the READING
 * session's own `TimeZone` GUC before truncating -- session-dependent, and
 * WRONG for this column type (empirically proven in RESEARCH.md Pitfall 1;
 * also the literal expression 13-REVIEW.md's WR-06 write-up and
 * CONTEXT.md's D-01 both name). The DOUBLE-hop form below converts back to
 * a naive UTC wall-clock value first, so the final `::date` cast is a pure
 * truncation with no timezone involved at all -- this is the SAME idiom
 * already established in this repo at
 * `packages/db/src/partitions/relocate-default.ts:112` for a different
 * naive-column use case (partition month bucketing).
 *
 * WR-02 follow-up (17-REVIEW.md): the expression this double-hop form
 * REPLACED was the plain `created_at::date` cast, not the single-hop form
 * named above -- and the plain cast was ALREADY session-independent
 * (casting a naive `timestamp` to `date` never consults the session
 * `TimeZone` GUC; verified empirically against Postgres 17, see Test 5 in
 * `dashboard-timezone.test.ts`). So this change is NOT a behavior fix for
 * an actually-shipped read-path bug -- it is a regression GUARD against a
 * future simplification toward the single-hop form (the one genuinely
 * session-dependent, WRONG expression), byte-identical in every session
 * timezone to the plain cast it replaced.
 *
 * `sends.*_at` and siblings (apps/worker/src/queues/analytics-reconciliation.worker.ts)
 * are genuinely `timestamptz` columns and correctly use the OPPOSITE
 * (single-hop) form -- the two column types need opposite-direction
 * handling; do not "harmonize" them.
 *
 * `dashboard-timezone.test.ts` is the executable guard: Test 1-3 assert
 * this exact double-hop form survives a deliberately non-UTC reading
 * session and that the single-hop form named above fails under the same
 * session; Test 5 asserts the double-hop form is byte-identical to the
 * ORIGINAL plain-cast form it replaced, under a non-UTC session -- proving
 * "no functional change" rather than merely asserting it. Together these
 * mean a future "simplification" back to the single-hop form fails loudly
 * rather than silently reintroducing the hazard.
 *
 * Exported (not inlined in `getWorkspaceDashboard`) so the regression test
 * imports and executes this EXACT string -- there is no second copy of this
 * SQL anywhere for the test to drift against.
 */
export const GROWTH_BY_DAY_SQL = `SELECT ((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::date::text as day, count(*)::text as "newContacts"
   FROM contacts
   WHERE workspace_id = $1 AND created_at >= $2::date AND anonymized_at IS NULL
   GROUP BY ((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::date
   ORDER BY day`;

/**
 * D-03 sweep audit (Phase 17 plan 02): left semantically UNCHANGED. This is
 * a `<` comparison of the naive `created_at` column against a `date`
 * literal ($2::date) -- the date literal is implicitly promoted to naive
 * midnight and compared naive-to-naive. No `timestamptz` conversion occurs
 * at any point, so no timezone anchor is needed here; adding one would be
 * noise, not safety. `dashboard-timezone.test.ts` Test 4 makes this an
 * executable assertion (identical count under a UTC and a non-UTC reading
 * session) rather than leaving it as an unverified claim.
 */
export const BASELINE_CONTACT_COUNT_SQL = `SELECT count(*)::text as count FROM contacts WHERE workspace_id = $1 AND created_at < $2::date AND anonymized_at IS NULL`;

/**
 * OPS-18 (D-12, plan 15-12): `dataAsOf`/`lagMinutes` come from
 * `@mega-crm/shared-schemas`'s `WorkspaceDashboardFreshness` -- the ONE
 * shared definition of the freshness signal, so this repository's response
 * shape and the frontend's consumed type (plan 15-15) can never drift
 * against each other.
 */
export interface WorkspaceDashboard extends WorkspaceDashboardFreshness {
  trend: DashboardTrendPoint[];
  growth: DashboardGrowthPoint[];
  kpis: DashboardKpis;
  recentCampaigns: DashboardRecentCampaign[];
  activeFlows: DashboardActiveFlow[];
}

/** D-01-family rate helper -- returns null on a zero denominator (never NaN/Infinity), mirrors apps/web/src/lib/rates.ts's computeRate exactly. */
function computeRate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 100);
}

function toDayString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * A dense, ascending list of `period` UTC day strings ending today (inclusive)
 * -- the window both the trend and growth series get zero-filled against, so
 * a day with no rollup row / no new contacts still appears with a zero count
 * (no gaps in the chart, per the plan's `<behavior>`).
 */
function buildDenseDayWindow(period: DashboardPeriod): string[] {
  const now = new Date();
  const days: string[] = [];
  for (let i = period - 1; i >= 0; i--) {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    days.push(toDayString(day));
  }
  return days;
}

/**
 * ANLT-04/D-08/D-08b: assembles the workspace dashboard payload for a chosen
 * 7/30/90-day period. Trend/deliver/open series read from
 * `workspace_daily_rollup` ONLY (07-06) -- never a live GROUP BY over
 * `send_events`/`sends`. Growth reads `contacts.created_at` directly (RESEARCH
 * A2 -- a trivial GROUP BY over an existing indexed-by-nature column, no
 * separate snapshot table). Mini-lists read the existing low-cardinality
 * `campaigns`/`flows` tables directly (no rollup needed at that scale).
 *
 * The window boundary is computed once in JS (`buildDenseDayWindow`) and
 * passed down as a bound `$2::date` parameter to every query, rather than
 * relying on Postgres's own `now()`/`current_date` (which resolve against the
 * session's timezone setting, not necessarily UTC) -- keeps the "today" the
 * dense series zero-fills against identical to the "today" every SQL query
 * filters on.
 */
export async function getWorkspaceDashboard(period: DashboardPeriod): Promise<WorkspaceDashboard> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const denseDays = buildDenseDayWindow(period);
    const startDay = denseDays[0];

    // Trend: workspace_daily_rollup only (D-08b) -- never send_events/sends.
    // `updatedAt` (migration 0064's watermark column) rides along on this
    // SAME query -- no separate round trip needed to compute the OPS-18
    // "data as of" signal below, since it needs exactly the rows this query
    // already fetches (the workspace's rows in the requested window).
    const { rows: rollupRows } = await client.query<{
      day: string;
      sentCount: string;
      deliveredCount: string;
      openedCount: string;
      unsubscribedCount: string;
      updatedAt: Date;
    }>(
      `SELECT day::text as day,
              sent_count::text as "sentCount",
              delivered_count::text as "deliveredCount",
              opened_count::text as "openedCount",
              unsubscribed_count::text as "unsubscribedCount",
              updated_at as "updatedAt"
       FROM workspace_daily_rollup
       WHERE workspace_id = $1 AND day >= $2::date
       ORDER BY day`,
      [workspaceId, startDay]
    );
    const rollupByDay = new Map(rollupRows.map((row) => [row.day, row]));

    // OPS-18 (D-12): the newest watermark among the workspace's rows in the
    // requested window -- `null` when the workspace has no rollup rows at
    // all in that window (a brand-new workspace, not an error). Derived from
    // the SAME rows already fetched above, never a live scan.
    const dataAsOf = rollupRows.reduce<Date | null>((latest, row) => {
      return !latest || row.updatedAt > latest ? row.updatedAt : latest;
    }, null);

    // OPS-18 (D-12, T-15-40): the lag signal comes from the oldest
    // OUTSTANDING dirty mark, deliberately unbounded by the requested
    // window -- a stuck reconciliation backlog older than the visible
    // window must still surface. Deliberately NEVER derived from
    // `dataAsOf`'s own age: a workspace with no recent sending activity has
    // an old watermark and zero dirty marks, and reporting that as lag
    // would be a false "stale" alarm on every quiet tenant.
    const { rows: dirtyRows } = await client.query<{ oldestDirty: Date | null; now: Date }>(
      `SELECT min(dirtied_at) as "oldestDirty", now() as "now"
       FROM workspace_daily_rollup
       WHERE workspace_id = $1 AND dirtied_at IS NOT NULL`,
      [workspaceId]
    );
    const oldestDirtiedAt = dirtyRows[0]?.oldestDirty ?? null;
    const dbNow = dirtyRows[0]?.now ?? new Date();
    const lagMinutes = oldestDirtiedAt ? (dbNow.getTime() - oldestDirtiedAt.getTime()) / (60 * 1000) : null;

    const trend: DashboardTrendPoint[] = denseDays.map((day) => {
      const row = rollupByDay.get(day);
      return {
        day,
        sent: row ? Number(row.sentCount) : 0,
        delivered: row ? Number(row.deliveredCount) : 0,
        opened: row ? Number(row.openedCount) : 0,
      };
    });

    const periodSent = trend.reduce((acc, point) => acc + point.sent, 0);
    const periodDelivered = trend.reduce((acc, point) => acc + point.delivered, 0);
    const periodOpened = trend.reduce((acc, point) => acc + point.opened, 0);
    const periodUnsubscribes = rollupRows.reduce((acc, row) => acc + Number(row.unsubscribedCount), 0);

    // Growth: contacts.created_at grouped by day (RESEARCH A2), plus a
    // cumulative-all-contacts running total (Open Question 1 default).
    // `anonymized_at IS NULL` (CMP-04, plan 13-10, Task 3 audit find --
    // NOT in that plan's files_modified list): without it, an erased
    // contact would count toward this workspace's growth/total forever,
    // permanently over-reporting the tenant-visible contact count for a
    // person who exercised their right to erasure.
    const { rows: growthRows } = await client.query<{ day: string; newContacts: string }>(
      GROWTH_BY_DAY_SQL,
      [workspaceId, startDay]
    );
    const newContactsByDay = new Map(growthRows.map((row) => [row.day, Number(row.newContacts)]));

    const { rows: baselineRows } = await client.query<{ count: string }>(
      BASELINE_CONTACT_COUNT_SQL,
      [workspaceId, startDay]
    );
    let cumulativeContacts = Number(baselineRows[0]?.count ?? 0);

    const growth: DashboardGrowthPoint[] = denseDays.map((day) => {
      const newContacts = newContactsByDay.get(day) ?? 0;
      cumulativeContacts += newContacts;
      return { day, newContacts, cumulativeContacts };
    });

    const periodNewContacts = growth.reduce((acc, point) => acc + point.newContacts, 0);

    const kpis: DashboardKpis = {
      sent: periodSent,
      deliveredRate: computeRate(periodDelivered, periodSent),
      openedRate: computeRate(periodOpened, periodDelivered),
      newContacts: periodNewContacts,
      unsubscribes: periodUnsubscribes,
    };

    // Mini-lists: recent campaigns + active flows -- low cardinality, read
    // directly from campaigns/flows (no rollup involved), per the plan.
    const { rows: campaignRows } = await client.query<{
      id: string;
      name: string;
      status: string;
      sentCount: string;
      deliveredCount: string;
      openedCount: string;
      clickedCount: string;
    }>(
      `SELECT id, name, status,
              sent_count::text as "sentCount",
              delivered_count::text as "deliveredCount",
              opened_count::text as "openedCount",
              clicked_count::text as "clickedCount"
       FROM campaigns
       WHERE workspace_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [workspaceId, RECENT_CAMPAIGNS_LIMIT]
    );
    const recentCampaigns: DashboardRecentCampaign[] = campaignRows.map((row) => {
      const sentCount = Number(row.sentCount);
      const deliveredCount = Number(row.deliveredCount);
      return {
        id: row.id,
        name: row.name,
        status: row.status,
        sentCount,
        deliveredRate: computeRate(deliveredCount, sentCount),
        openedRate: computeRate(Number(row.openedCount), deliveredCount),
        clickedRate: computeRate(Number(row.clickedCount), deliveredCount),
      };
    });

    const { rows: flowRows } = await client.query<{
      id: string;
      name: string;
      activeRuns: string;
      emailsSent: string;
    }>(
      `SELECT f.id, f.name,
              count(DISTINCT fr.id) FILTER (WHERE fr.status IN ('waiting', 'advancing'))::text as "activeRuns",
              count(s.id)::text as "emailsSent"
       FROM flows f
       LEFT JOIN flow_runs fr ON fr.flow_id = f.id AND fr.workspace_id = f.workspace_id
       LEFT JOIN sends s ON s.flow_run_id = fr.id AND s.workspace_id = f.workspace_id
       WHERE f.workspace_id = $1 AND f.status = 'live'
       GROUP BY f.id, f.name, f.created_at
       ORDER BY f.created_at DESC
       LIMIT $2`,
      [workspaceId, ACTIVE_FLOWS_LIMIT]
    );
    const activeFlows: DashboardActiveFlow[] = flowRows.map((row) => ({
      id: row.id,
      name: row.name,
      activeRuns: Number(row.activeRuns),
      emailsSent: Number(row.emailsSent),
    }));

    return {
      trend,
      growth,
      kpis,
      recentCampaigns,
      activeFlows,
      dataAsOf: dataAsOf ? dataAsOf.toISOString() : null,
      lagMinutes,
    };
  });
}
