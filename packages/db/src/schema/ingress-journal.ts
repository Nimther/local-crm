import { pgTable, integer, jsonb, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";

/**
 * Logical/type-inference shape ONLY (Phase 13, CMP-08, D-05, plan 13-01).
 * Drizzle's `pgTable` has no expression for a table-level CHECK constraint
 * (`ingress_journal_payload_purge_check`) the way this table needs -- the
 * physical table, its RLS policies (app + scan), its partial index, and the
 * CHECK are all created by the hand-written migration
 * packages/db/migrations/0055_webhook_ingress_durability.sql, NOT by
 * `drizzle-kit generate` against this file (mirrors `send-events.ts` and
 * `dead-letter-jobs.ts`'s own "type-inference shape ONLY" precedent). This
 * file exists purely so application code
 * (packages/db/src/webhooks/ingress-journal.ts, a future apps/api watchdog)
 * gets typed query results via Drizzle's schema inference.
 *
 * `rawBatch` is nullable and `payloadPurgedAt` exists precisely because a
 * payload-disposed row (a tombstone) is a valid, expected state -- see the
 * migration's own header comment and `payload_purged_at`'s COMMENT ON
 * COLUMN for the full reasoning.
 */
export const ingressJournal = pgTable("ingress_journal", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  rawBatch: jsonb("raw_batch"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  ingestionCompletedAt: timestamp("ingestion_completed_at", { withTimezone: true }),
  replayCount: integer("replay_count").notNull().default(0),
  payloadPurgedAt: timestamp("payload_purged_at", { withTimezone: true }),
});
