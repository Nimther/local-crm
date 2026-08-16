import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * FLAGGED ASSUMPTION (15-15-PLAN.md's own note): a first estimate, not
 * validated against real production behaviour -- tune once this system has
 * one. Chosen in explicit relationship to the reconciliation sweep's own
 * cadence: `RECONCILE_INTERVAL_MS` in
 * `apps/worker/src/queues/analytics-reconciliation.worker.ts` ticks every 3
 * minutes. This threshold sits at 5x that interval so a healthy pipeline
 * that misses one or two ticks (a slow query, a brief Redis blip) never
 * trips a false "delayed" alarm, while a pipeline that is genuinely stuck
 * still surfaces well before an operator would notice unprompted.
 *
 * The single constant every analytics surface imports and compares against
 * -- no second staleness threshold may be introduced per view (plan
 * prohibition).
 */
export const STALE_DATA_LAG_THRESHOLD_MINUTES = 15;

export interface StaleDataBannerProps {
  /**
   * The age, in minutes, of the oldest outstanding
   * `workspace_daily_rollup.dirtied_at` mark, or `null` when no dirty day is
   * currently outstanding -- `@mega-crm/shared-schemas`'s
   * `WorkspaceDashboardFreshness.lagMinutes`. Deliberately never derived
   * from `dataAsOf`'s own age (T-15-53): a quiet workspace with old data and
   * zero outstanding lag reports `null` here, not a stale alarm.
   */
  lagMinutes: number | null;
  className?: string;
}

/**
 * OPS-18 / D-12 (plan 15-15): the amber, non-dismissible delay banner.
 * Renders only when the API-reported lag strictly exceeds
 * `STALE_DATA_LAG_THRESHOLD_MINUTES` -- exactly at the threshold does not
 * render (T-15-51). Sits above the numbers and never replaces them: the
 * figures stay rendered and labelled underneath, because hiding them would
 * be less honest than labelling them. Purely presentational -- no fetching,
 * no router access, no staleness computation beyond this one comparison.
 */
export function StaleDataBanner({ lagMinutes, className }: StaleDataBannerProps) {
  if (lagMinutes === null || lagMinutes <= STALE_DATA_LAG_THRESHOLD_MINUTES) {
    return null;
  }

  return (
    <Card className={cn("border-amber-200 bg-amber-50", className)}>
      <CardContent className="p-4 text-sm text-amber-700">
        Аналитика обновляется с задержкой — данные ниже могут не включать последнюю активность.
      </CardContent>
    </Card>
  );
}

export default StaleDataBanner;
