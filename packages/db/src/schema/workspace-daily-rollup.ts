import { pgTable, uuid, date, integer, timestamp, unique } from "drizzle-orm/pg-core";
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
 *
 * CMP-02 day-semantics contract (Phase 13, D-13) -- the single documented
 * answer to "what does this number mean":
 *
 * 1. `day` is ALWAYS a UTC calendar day, never a local or session-timezone
 *    day. `analytics-reconciliation.worker.ts` forces this with
 *    `AT TIME ZONE 'UTC'` on every day-bucketing cast (a bare `::date` cast
 *    on a `timestamptz` converts to the session's `TimeZone` GUC first,
 *    which would otherwise make the daily number depend on which pooled
 *    connection served the query).
 * 2. `sent_count` is bucketed by `sends.sent_at` (`SEND_DAY_FIELD` in
 *    `analytics-reconciliation.worker.ts`) -- the SendGrid-acceptance
 *    timestamp. The reconciliation worker is its SOLE writer; the
 *    incremental webhook-driven path never sets `sent_count` (a dispatched
 *    send produces no webhook event of its own).
 * 3. Every event-derived counter (`delivered_count`, `opened_count`,
 *    `clicked_count`, `bounced_count`, `unsubscribed_count`) is bucketed by
 *    the provider event's own `occurred_at` UTC day on the incremental path
 *    (`incrementWorkspaceDailyRollup` in
 *    `packages/db/src/analytics/daily-rollup.ts`, shared by `apps/worker`
 *    and `apps/api`), and by the corresponding `sends` fact column's UTC
 *    day on the reconciliation path
 *    -- the two MUST agree, since the reconciliation path overwrites
 *    whatever the incremental path already wrote for that (workspace, day).
 * 4. Sends in the `unknown` status are EXCLUDED from `sent_count` and from
 *    failure-derived counts -- Phase 11 D-13 stands. The phase-13 change is
 *    that `unknown` gets its OWN visible count in campaign and send-log
 *    stats instead (plan 13-03), not that it enters this rollup.
 * 5. `dirtied_at` (Phase 13, CMP-03, D-14, migration 0056) -- the incremental
 *    path (`incrementWorkspaceDailyRollup`) is the SOLE writer, marking a
 *    (workspace, day) row whenever the event's derived day is not today
 *    (UTC). The reconciliation path (`clearDirtyRollupDays`) is its SOLE
 *    clearer, and the clear is CONDITIONAL on the mark predating the
 *    sweep's own start time -- an unconditional clear would drop a mark
 *    that arrived mid-sweep, losing that late event's verification forever.
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
    dirtiedAt: timestamp("dirtied_at", { withTimezone: true }),
  },
  (t) => [unique("workspace_daily_rollup_workspace_day_unique").on(t.workspaceId, t.day)]
);
