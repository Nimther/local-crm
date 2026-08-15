import { z } from "zod";

/**
 * Phase 15 (OPS-18, D-12, plan 15-12): the "data freshness" signal every
 * analytics response carries so the frontend can render an honest
 * "Data as of HH:MM" timestamp and a conditional staleness banner, without
 * itself computing staleness (15-RESEARCH.md's Architectural Responsibility
 * Map: "the API computes the watermark -- no new backend contract needed").
 * The frontend's job (plan 15-15) is only to render these two fields.
 *
 * - `dataAsOf`: the newest `workspace_daily_rollup.updated_at` watermark
 *   (migration 0064) among the workspace's rows in the requested period
 *   window, as an ISO-8601 UTC string -- or `null` when the workspace has
 *   no rollup rows at all in that window (a brand-new workspace, not an
 *   error state).
 * - `lagMinutes`: the age, in minutes, of the OLDEST outstanding
 *   `workspace_daily_rollup.dirtied_at` mark for this workspace -- NOT
 *   bounded by the requested window, since a stuck reconciliation backlog
 *   older than the visible window must still surface -- or `null` when no
 *   dirty day is currently outstanding. Deliberately NEVER derived from
 *   `dataAsOf`'s own age: a workspace with no recent sending activity has
 *   an old watermark and zero dirty marks, and reporting that as lag would
 *   be a false "stale" alarm on every quiet tenant (T-15-40).
 */
export const workspaceDashboardFreshnessSchema = z.object({
  dataAsOf: z.string().datetime().nullable(),
  lagMinutes: z.number().nonnegative().nullable(),
});
export type WorkspaceDashboardFreshness = z.infer<typeof workspaceDashboardFreshnessSchema>;
