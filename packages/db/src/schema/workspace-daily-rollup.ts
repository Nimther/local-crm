import { pgTable, uuid, date, integer, unique } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";

/**
 * Per-workspace-per-day rollup of send/deliver/open/click/bounce/unsubscribe
 * counts (07-06, ANLT-04). Gives the workspace dashboard (07-07) a cheap,
 * freshness-bounded read path for trend charts without scanning the
 * fastest-growing partitioned tables (`sends`/`send_events`/`events`) on
 * every load (D-08b).
 *
 * Maintained two ways that must never conflict:
 * - Incrementally: the webhook worker's genuinely-new-event branches call
 *   `incrementWorkspaceDailyRollup` inside the SAME transaction as the
 *   `send_events` dedup insert (near-real-time for delivered/opened/
 *   clicked/bounced/unsubscribed).
 * - By reconciliation: `analytics-reconciliation.worker.ts` periodically
 *   OVERWRITES each recent day's row from a fresh `COUNT` over `sends`
 *   (correctness backstop; also the sole source of `sent_count`, which the
 *   incremental path never sets).
 *
 * The `(workspace_id, day)` unique constraint is the `ON CONFLICT` target
 * both write paths use.
 */
export const workspaceDailyRollup = pgTable(
  "workspace_daily_rollup",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    sentCount: integer("sent_count").notNull().default(0),
    deliveredCount: integer("delivered_count").notNull().default(0),
    openedCount: integer("opened_count").notNull().default(0),
    clickedCount: integer("clicked_count").notNull().default(0),
    bouncedCount: integer("bounced_count").notNull().default(0),
    unsubscribedCount: integer("unsubscribed_count").notNull().default(0),
  },
  (t) => [unique("workspace_daily_rollup_workspace_day_unique").on(t.workspaceId, t.day)]
);
