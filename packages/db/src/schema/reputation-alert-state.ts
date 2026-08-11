import { pgTable, uuid, text, integer, numeric, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";

/**
 * Phase 13 (CMP-09, D-09 through D-12). The physical table -- including its
 * `PRIMARY KEY (workspace_id, metric)` composite key and the
 * `ON DELETE CASCADE` foreign key -- is created by the hand-written
 * migration packages/db/migrations/0058_reputation_and_ingestion_alert_state.sql.
 * This file exists purely so application code (the reputation tick worker,
 * a future apps/api watchdog in plan 13-11) gets typed query results via
 * Drizzle's schema inference, matching `dead-letter-jobs.ts`'s own
 * precedent.
 *
 * KEYED by (workspace_id, metric), never a singleton -- see the migration's
 * own header/table comment for the full reasoning. `observed_*` columns are
 * written only by the reputation tick worker; `alertedTier` and
 * `lastAlertSentAt` are written only by plan 13-11's watchdog claim.
 *
 * NO Row-Level Security on this table -- deliberate, not an oversight, same
 * "role identity is the boundary" precedent as `organization`/
 * `dead_letter_jobs`. See the migration's own comment for the full
 * reasoning and the correct remedy if tenant-scoped visibility is ever
 * wanted.
 */
export const reputationAlertState = pgTable(
  "reputation_alert_state",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    metric: text("metric").notNull(),
    observedTier: text("observed_tier"),
    observedRate: numeric("observed_rate"),
    observedNumerator: integer("observed_numerator"),
    observedDenominator: integer("observed_denominator"),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    alertedTier: text("alerted_tier"),
    lastAlertSentAt: timestamp("last_alert_sent_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.metric] })],
);
