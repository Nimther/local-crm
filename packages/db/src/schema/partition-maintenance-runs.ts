import { pgTable, integer, bigint, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Logical/type-inference shape ONLY (09-01 D-02/D-10, 09-03 task 1). The
 * physical table -- including its `id integer PRIMARY KEY DEFAULT 1 CHECK
 * (id = 1)` singleton constraint -- is created by the hand-written migration
 * packages/db/migrations/0038_partition_catchup_and_maintenance_runs.sql,
 * matching schema/events.ts's own precedent: Drizzle's `pgTable` API has no
 * expression for a CHECK constraint on a column, so this file declares the
 * column shape only and the migration remains the single source of truth for
 * the constraint. This file exists purely so application code (the daily
 * maintenance worker, the apps/api watchdog) gets typed query results via
 * Drizzle's schema inference.
 *
 * NO `workspace_id` column, and this is the one table in this directory
 * without one -- deliberately, not an oversight. It carries only
 * platform-level operational metadata (partition names, month counts, row
 * counts, timestamps), never tenant data, so it must never receive the
 * RLS ENABLE/FORCE + `workspace_isolation` treatment every tenant-scoped
 * table in this directory gets. A reviewer scanning for a table missing RLS
 * should find this comment rather than adding a policy -- see migration
 * 0038's own header and table comment for the full reasoning.
 */
export const partitionMaintenanceRuns = pgTable("partition_maintenance_runs", {
  id: integer("id").primaryKey(),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }).notNull(),
  lookaheadMonths: integer("lookahead_months").notNull(),
  bufferAlertThresholdMonths: integer("buffer_alert_threshold_months").notNull(),
  eventsBufferMonths: integer("events_buffer_months").notNull(),
  sendEventsBufferMonths: integer("send_events_buffer_months").notNull(),
  bufferMonthsRemaining: integer("buffer_months_remaining").notNull(),
  eventsDefaultCount: bigint("events_default_count", { mode: "number" }).notNull(),
  sendEventsDefaultCount: bigint("send_events_default_count", { mode: "number" }).notNull(),
  partitionsCreated: text("partitions_created").array().notNull().default([]),
  lastAlertSentAt: timestamp("last_alert_sent_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // Phase 14 plan 12 (DB-11, D-08, migration 0063): the "run record
  // distinguishes disabled from failed" half of T-14-79's mitigation.
  // "disabled" is the value every run writes while the retention enable
  // flag is unset (the only state any committed deploy of this codebase can
  // reach); "ok" means retention ran (with or without anything eligible);
  // "failed" means the retention step itself threw -- see
  // apps/worker/src/queues/partition-maintenance.worker.ts's own retention
  // step for why a retention failure must never also fail the
  // partition-creation work's own recording. `retentionError` is populated
  // only alongside "failed", and is the same message a human reading logs
  // would see -- never row contents, workspace ids or any secret.
  retentionStatus: text("retention_status").notNull().default("disabled"),
  retentionError: text("retention_error"),
  // Names only (mirrors `partitionsCreated` above) -- the full per-drop
  // record (parent table, range, horizon) lives in the append-only
  // `partition_retention_drops` ledger this same migration creates; this
  // column is the fast "what did the MOST RECENT run drop" answer without a
  // join, exactly as `partitionsCreated` already is for creation.
  partitionsDropped: text("partitions_dropped").array().notNull().default([]),
});
