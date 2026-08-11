import type { PoolClient } from "pg";

/**
 * Same-transaction idempotent increment of `workspace_daily_rollup` (07-06,
 * ANLT-04). SHARED BY BOTH APPLICATIONS: `apps/worker`'s webhook worker calls
 * it inside its existing genuinely-new-event gates (the `justSet` first-write
 * gate for delivered/opened/clicked/unsubscribed, or `isFirstNonDeliveryTerminal`
 * for bounced -- never independently gated, Pitfall 1: an increment placed
 * outside the caller's own dedup gate would double-count on webhook replay),
 * and `apps/api`'s unsubscribe route (plan 13-08) calls the SAME function so
 * the platform's two unsubscribe paths keep one identical counter, rather
 * than drifting behind two copies.
 *
 * Relocated here from `apps/worker/src/queues/analytics-rollup.ts` (Phase 13,
 * plan 13-05) specifically because of that second caller: `apps/worker`
 * declares `@mega-crm/api` as a devDependency only, and `apps/api` declares
 * no dependency on `apps/worker` at all -- a relative cross-app import is a
 * hard `tsc` TS6059 error under `apps/api/tsconfig.json`'s `rootDir: "src"`
 * (proven in plan 12-10's `dead-letter-writer.ts` relocation for the same
 * reason). `packages/db/src/<domain>/<module>.ts`, imported as
 * `@mega-crm/db/src/<domain>/<module>.js`, is this codebase's convention for
 * a `PoolClient`-first query helper shared across both apps -- see
 * `packages/db/src/reconciler/reconciler-run.ts` for the identical shape.
 * There is NO re-export shim left behind at the old path: every call site
 * imports from here directly.
 *
 * Uses the caller's `PoolClient` (same transaction as the caller's own
 * dedup insert), so RLS + atomicity hold together with that insert.
 *
 * Derives `day` from `occurredAt` (a UTC ISO-8601 string, e.g.
 * `2026-07-14T12:34:56.000Z`) via a plain string slice -- a UTC calendar-day
 * bucket, matching the rest of this codebase's UTC-first timestamp
 * convention.
 *
 * CMP-02 (D-13): `occurredAt.slice(0, 10)` is UTC-correct PRECISELY because
 * every caller passes an ISO-8601 `Z`-suffixed string produced from the
 * provider timestamp -- `.slice(0, 10)` on a non-`Z`-suffixed (e.g. an
 * offset-suffixed or local, timezone-naive) string would silently bucket
 * into the wrong day with no error. The input contract for `occurredAt` is
 * therefore "a UTC ISO-8601 string", not merely "a date-ish string" -- a
 * caller must not pass any other timestamp shape.
 *
 * `ON CONFLICT (workspace_id, day) DO UPDATE SET <col> = workspace_daily_rollup.<col> + 1`
 * is the ADDITIVE upsert appropriate for an incremental per-event
 * increment -- this is intentionally the OPPOSITE of the reconciliation
 * worker's overwrite semantics (Pitfall 2); the two write paths must never
 * be confused.
 *
 * CMP-03 (D-14): a late event -- one whose derived UTC day is not today --
 * also marks that (workspace, day) row's `dirtied_at`. `isNotToday` decides
 * "not today" against the UTC calendar ALONE, never against the
 * reconciler's standing window (`RECONCILE_WINDOW_DAYS` in
 * `analytics-reconciliation.worker.ts`): an event for day D arriving in the
 * last few minutes before D+1 UTC midnight is still inside that standing
 * window at increment time, but D leaves the window before the next tick
 * runs -- a window-edge predicate would let that increment go permanently
 * unverified. `day != today` closes that sliver completely. The cost is
 * that this deliberately OVER-marks yesterday: every yesterday event marks
 * a row the standing window's next tick would have reconciled anyway. That
 * redundant mark is cheap; the missed one is silent -- this plan's whole
 * point is that a daily number means exactly one thing, and "verified
 * except for a three-minute window each midnight" does not clear that bar.
 * A second benefit: the marking predicate now depends only on the UTC
 * calendar, not on `RECONCILE_WINDOW_DAYS` -- a future change to that
 * window's width can no longer silently open a gap at the new edge.
 *
 * `dirtied_at = COALESCE(workspace_daily_rollup.dirtied_at, now())` is what
 * stops a burst of late events on the same day from repeatedly pushing the
 * mark forward and starving the sweep -- the FIRST mark wins, and the
 * conditional clear in `clearDirtyRollupDays`
 * (`apps/worker/src/queues/analytics-reconciliation.worker.ts`) later
 * measures against the sweep's own start time. The `dirtied_at` is set in
 * the INSERT branch too, for the case where the late event is the first
 * write for that (workspace, day) at all.
 */
export type RollupMetric = "sent" | "delivered" | "opened" | "clicked" | "bounced" | "unsubscribed";

// T-07-06-03: a fixed allow-list maps the metric literal to its column
// name -- caller input is never string-interpolated into the SQL, since the
// `metric` TypeScript union already constrains callers to these six keys.
const METRIC_COLUMN: Record<RollupMetric, string> = {
  sent: "sent_count",
  delivered: "delivered_count",
  opened: "opened_count",
  clicked: "clicked_count",
  bounced: "bounced_count",
  unsubscribed: "unsubscribed_count",
};

/**
 * CMP-03 (D-14): whether `day` (a `YYYY-MM-DD` UTC calendar-day string) is
 * NOT `now`'s own UTC calendar day. A pure helper, computed against an
 * INJECTED `now` rather than the wall clock, using the exact same UTC
 * arithmetic `recentDays` (`analytics-reconciliation.worker.ts`) uses, so
 * the two can never disagree about what "today" is.
 */
export function isNotToday(day: string, now: Date): boolean {
  const today = now.toISOString().slice(0, 10);
  return day !== today;
}

export async function incrementWorkspaceDailyRollup(
  client: PoolClient,
  workspaceId: string,
  occurredAt: string,
  metric: RollupMetric,
  now: Date = new Date()
): Promise<void> {
  const column = METRIC_COLUMN[metric];
  const day = occurredAt.slice(0, 10);

  if (isNotToday(day, now)) {
    await client.query(
      `INSERT INTO workspace_daily_rollup (workspace_id, day, ${column}, dirtied_at)
       VALUES ($1, $2, 1, now())
       ON CONFLICT (workspace_id, day) DO UPDATE SET
         ${column} = workspace_daily_rollup.${column} + 1,
         dirtied_at = COALESCE(workspace_daily_rollup.dirtied_at, now())`,
      [workspaceId, day]
    );
    return;
  }

  await client.query(
    `INSERT INTO workspace_daily_rollup (workspace_id, day, ${column})
     VALUES ($1, $2, 1)
     ON CONFLICT (workspace_id, day) DO UPDATE SET ${column} = workspace_daily_rollup.${column} + 1`,
    [workspaceId, day]
  );
}
