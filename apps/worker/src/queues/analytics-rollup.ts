import type { PoolClient } from "pg";

/** Fixed allow-list metric literal -- never a caller-provided string. */
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
 * Same-transaction idempotent increment of `workspace_daily_rollup` (07-06,
 * ANLT-04). Called from inside the webhook worker's existing
 * genuinely-new-event gates (the `justSet` first-write gate for
 * delivered/bounced/unsubscribed, or the per-event open/click increment) --
 * never independently gated (Pitfall 1: an increment placed outside the
 * caller's own dedup gate would double-count on webhook replay). Uses the
 * caller's `PoolClient` (same transaction as the `send_events` dedup
 * insert), so RLS + atomicity hold together with that insert.
 *
 * Derives `day` from `occurredAt` (a UTC ISO-8601 string, e.g.
 * `2026-07-14T12:34:56.000Z`) via a plain string slice -- a UTC calendar-day
 * bucket, matching the rest of this codebase's UTC-first timestamp
 * convention.
 *
 * `ON CONFLICT (workspace_id, day) DO UPDATE SET <col> = workspace_daily_rollup.<col> + 1`
 * is the ADDITIVE upsert appropriate for an incremental per-event
 * increment -- this is intentionally the OPPOSITE of the reconciliation
 * worker's overwrite semantics (Pitfall 2); the two write paths must never
 * be confused.
 */
export async function incrementWorkspaceDailyRollup(
  client: PoolClient,
  workspaceId: string,
  occurredAt: string,
  metric: RollupMetric
): Promise<void> {
  const column = METRIC_COLUMN[metric];
  const day = occurredAt.slice(0, 10);
  await client.query(
    `INSERT INTO workspace_daily_rollup (workspace_id, day, ${column})
     VALUES ($1, $2, 1)
     ON CONFLICT (workspace_id, day) DO UPDATE SET ${column} = workspace_daily_rollup.${column} + 1`,
    [workspaceId, day]
  );
}
