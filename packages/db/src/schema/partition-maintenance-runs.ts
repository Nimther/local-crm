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
});
