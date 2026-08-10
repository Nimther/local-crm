import { pgTable, uuid, text, integer, jsonb, timestamp, unique } from "drizzle-orm/pg-core";

/**
 * Phase 12 (WRK-09/WRK-10, D-07). The physical tables -- including the
 * `dead_letter_jobs_queue_job_unique` unique constraint, the `failed_at`
 * index and `dead_letter_alert_state`'s `id integer PRIMARY KEY DEFAULT 1
 * CHECK (id = 1)` singleton constraint -- are created by the hand-written
 * migration packages/db/migrations/0054_dead_letter_jobs.sql. This file
 * exists purely so application code (the dead-letter writer, the shared
 * error-listener helper, a future apps/api watchdog) gets typed query
 * results via Drizzle's schema inference, matching
 * `partition-maintenance-runs.ts`/`send-reconciler-runs.ts`'s own precedent:
 * Drizzle's `pgTable` API has no expression for a CHECK constraint on a
 * column, so the migration remains the single source of truth for that
 * constraint.
 *
 * NO `workspace_id` column on either table, and this is deliberate, not an
 * oversight -- same reasoning as `partition_maintenance_runs`/
 * `send_reconciler_runs`: both tables carry only platform-operations
 * metadata (a terminal-failure record, and the watchdog's own alert-dedup
 * bookkeeping), never tenant data, so neither must ever receive the RLS
 * ENABLE/FORCE + `workspace_isolation` treatment every tenant-scoped table
 * in this directory gets. See migration 0054's own header and table
 * comments for the full reasoning and the correct remedy if tenant-scoped
 * visibility is ever wanted.
 */
export const deadLetterJobs = pgTable(
  "dead_letter_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    queueName: text("queue_name").notNull(),
    jobId: text("job_id").notNull(),
    jobName: text("job_name").notNull(),
    attemptsMade: integer("attempts_made").notNull(),
    payload: jsonb("payload").notNull().default({}),
    errorMessage: text("error_message").notNull(),
    errorStack: text("error_stack"),
    failedAt: timestamp("failed_at", { withTimezone: true }).notNull().defaultNow(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  },
  (table) => [unique("dead_letter_jobs_queue_job_unique").on(table.queueName, table.jobId)],
);

export const deadLetterAlertState = pgTable("dead_letter_alert_state", {
  id: integer("id").primaryKey(),
  lastAlertSentAt: timestamp("last_alert_sent_at", { withTimezone: true }),
  lastSeenFailedAt: timestamp("last_seen_failed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
