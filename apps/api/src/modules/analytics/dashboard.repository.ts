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

export interface WorkspaceDashboard {
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
    const { rows: rollupRows } = await client.query<{
      day: string;
      sentCount: string;
      deliveredCount: string;
      openedCount: string;
      unsubscribedCount: string;
    }>(
      `SELECT day::text as day,
              sent_count::text as "sentCount",
              delivered_count::text as "deliveredCount",
              opened_count::text as "openedCount",
              unsubscribed_count::text as "unsubscribedCount"
       FROM workspace_daily_rollup
       WHERE workspace_id = $1 AND day >= $2::date
       ORDER BY day`,
      [workspaceId, startDay]
    );
    const rollupByDay = new Map(rollupRows.map((row) => [row.day, row]));

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
      `SELECT created_at::date::text as day, count(*)::text as "newContacts"
       FROM contacts
       WHERE workspace_id = $1 AND created_at >= $2::date AND anonymized_at IS NULL
       GROUP BY created_at::date
       ORDER BY day`,
      [workspaceId, startDay]
    );
    const newContactsByDay = new Map(growthRows.map((row) => [row.day, Number(row.newContacts)]));

    const { rows: baselineRows } = await client.query<{ count: string }>(
      `SELECT count(*)::text as count FROM contacts WHERE workspace_id = $1 AND created_at < $2::date AND anonymized_at IS NULL`,
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

    return { trend, growth, kpis, recentCampaigns, activeFlows };
  });
}
