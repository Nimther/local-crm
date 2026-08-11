import { pgTable, integer, timestamp } from "drizzle-orm/pg-core";

/**
 * Phase 13 (CMP-09). The physical table -- including its
 * `id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1)` singleton constraint --
 * is created by the hand-written migration
 * packages/db/migrations/0058_reputation_and_ingestion_alert_state.sql,
 * matching `dead-letter-jobs.ts`'s own `deadLetterAlertState` precedent:
 * Drizzle's `pgTable` API has no expression for a CHECK constraint on a
 * column, so the migration remains the single source of truth for that
 * constraint. This file exists purely so plan 13-11's ingestion-health
 * watchdog gets typed query results via Drizzle's schema inference.
 *
 * NO `workspace_id` column, and this is deliberate -- same reasoning as
 * `dead_letter_alert_state`/`partition_maintenance_runs`/
 * `send_reconciler_runs`: platform-operations metadata, never tenant data,
 * so this table never gets the RLS ENABLE/FORCE + `workspace_isolation`
 * treatment every tenant-scoped table in this directory gets.
 */
export const ingestionAlertState = pgTable("ingestion_alert_state", {
  id: integer("id").primaryKey(),
  lastAlertSentAt: timestamp("last_alert_sent_at", { withTimezone: true }),
  lastSeenStuckAt: timestamp("last_seen_stuck_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
