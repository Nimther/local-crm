import { apiGet } from "@/lib/api";

/** D-08: closed set of period presets -- mirrors dashboard.routes.ts's dashboardQuerySchema. */
export type DashboardPeriod = 7 | 30 | 90;

export interface DashboardTrendPoint {
  day: string; // YYYY-MM-DD (UTC)
  sent: number;
  delivered: number;
  opened: number;
}

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

export interface WorkspaceDashboardResponse {
  trend: DashboardTrendPoint[];
  growth: DashboardGrowthPoint[];
  kpis: DashboardKpis;
  recentCampaigns: DashboardRecentCampaign[];
  activeFlows: DashboardActiveFlow[];
  /**
   * OPS-18 / D-12 (plan 15-12/15-15): the newest `workspace_daily_rollup`
   * watermark among this response's rows, or `null` for a brand-new
   * workspace with no rollup rows yet. Mirrors
   * `@mega-crm/shared-schemas`'s `WorkspaceDashboardFreshness.dataAsOf` --
   * this frontend-only interface isn't imported from the shared package
   * directly since the rest of this file's shape predates it.
   */
  dataAsOf: string | null;
  /**
   * The age, in minutes, of the oldest outstanding dirty rollup day, or
   * `null` when none is outstanding. Mirrors
   * `WorkspaceDashboardFreshness.lagMinutes`.
   */
  lagMinutes: number | null;
}

/** GET /api/workspaces/:slug/dashboard?period=7|30|90 -- ANLT-04/D-08. */
export function getWorkspaceDashboard(slug: string, period: DashboardPeriod): Promise<WorkspaceDashboardResponse> {
  return apiGet<WorkspaceDashboardResponse>(`/api/workspaces/${slug}/dashboard?period=${period}`);
}
