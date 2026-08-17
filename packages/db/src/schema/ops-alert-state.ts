import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Phase 15 (OPS-13). The physical table is created by the hand-written
 * migration packages/db/migrations/0064_ops_alert_state_and_rollup_watermark.sql.
 * This file exists purely so application code (the four new OPS-13 watchdogs
 * under `apps/api/src/modules/ops/`, wired up in plans 15-13/15-14) gets
 * typed query results via Drizzle's schema inference, matching
 * `reputation-alert-state.ts`'s/`ingestion-alert-state.ts`'s own precedent.
 *
 * KEYED by `alertName`, never a singleton -- see the migration's own header/
 * table comment for the full reasoning: four alerts (queue depth, oldest job
 * age, webhook lag, failed-send share) share this ONE table, and a singleton
 * `id = 1` shape would make claiming one alert's slot suppress the other
 * three's dedup windows.
 *
 * NO Row-Level Security on this table -- deliberate, not an oversight, the
 * same "role identity is the boundary" precedent as `dead_letter_alert_state`/
 * `ingestion_alert_state`/`partition_maintenance_runs`/`send_reconciler_runs`.
 * See the migration's own comment for the full reasoning.
 *
 * The claim/release helpers live in `packages/db/src/ops/alert-state.ts`
 * (plan 15-12 Task 2) -- this file declares ONLY the table shape, no query
 * logic.
 */
export const opsAlertState = pgTable("ops_alert_state", {
  alertName: text("alert_name").primaryKey(),
  lastAlertSentAt: timestamp("last_alert_sent_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
