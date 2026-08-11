import { pgTable, integer, timestamp } from "drizzle-orm/pg-core";

/**
 * Logical/type-inference shape ONLY (Phase 11, 11-02, D-14). The physical
 * table -- including its `id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1)`
 * singleton constraint -- is created by the hand-written migration
 * packages/db/migrations/0050_send_reconciler_runs.sql, matching
 * `partition-maintenance-runs.ts`'s own precedent verbatim: Drizzle's
 * `pgTable` API has no expression for a CHECK constraint on a column, so
 * this file declares the column shape only and the migration remains the
 * single source of truth for the constraint. This file exists purely so
 * application code (the reconciler worker, a future apps/api watchdog
 * extension) gets typed query results via Drizzle's schema inference.
 *
 * NO `workspace_id` column, and this is deliberate, not an oversight --
 * same reasoning as `partition_maintenance_runs`: it carries only
 * platform-level operational counters (candidates scanned/resolved this
 * tick, the oldest still-reconciling timestamp seen, alert dedup
 * bookkeeping), never tenant data, so it must never receive the
 * RLS ENABLE/FORCE + `workspace_isolation` treatment every tenant-scoped
 * table in this directory gets. A reviewer scanning for a table missing
 * RLS should find this comment rather than adding a policy -- see
 * migration 0050's own header and table comment for the full reasoning.
 */
export const sendReconcilerRuns = pgTable("send_reconciler_runs", {
  id: integer("id").primaryKey(),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }).notNull(),
  candidatesScanned: integer("candidates_scanned").notNull().default(0),
  rowsResolved: integer("rows_resolved").notNull().default(0),
  rowsMarkedUnknown: integer("rows_marked_unknown").notNull().default(0),
  staleDispatchingSwept: integer("stale_dispatching_swept").notNull().default(0),
  oldestReconcilingSince: timestamp("oldest_reconciling_since", { withTimezone: true }),
  lastAlertSentAt: timestamp("last_alert_sent_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
