import { cn } from "@/lib/utils";

export interface DataAsOfLabelProps {
  /**
   * The newest `workspace_daily_rollup.updated_at` watermark for the current
   * view's window, as an ISO-8601 UTC string, or `null` when the workspace
   * has no rollup rows at all (a brand-new workspace, not an error) --
   * `@mega-crm/shared-schemas`'s `WorkspaceDashboardFreshness.dataAsOf`.
   */
  dataAsOf: string | null;
  className?: string;
}

/**
 * OPS-18 / D-12 (plan 15-15): the always-visible "data as of" label. Never
 * fabricates a timestamp and never renders an empty label -- an absent
 * watermark (`dataAsOf === null`) is information (this workspace has no
 * rollup data yet), not a blank. Purely presentational: no fetching, no
 * router access, no staleness computation of its own.
 *
 * The timestamp is rendered with `toLocaleString("ru-RU")`, the same
 * viewer-local-time formatting convention already used throughout the app
 * (e.g. `CampaignsListPage.tsx`, `SendGridKeySettings.tsx`) -- there is no
 * dedicated date-formatting helper in `@/lib` to reuse instead.
 */
export function DataAsOfLabel({ dataAsOf, className }: DataAsOfLabelProps) {
  const text = dataAsOf === null ? "Данных пока нет" : `Данные на: ${new Date(dataAsOf).toLocaleString("ru-RU")}`;

  return <p className={cn("text-xs text-muted-foreground", className)}>{text}</p>;
}

export default DataAsOfLabel;
