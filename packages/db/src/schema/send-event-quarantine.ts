import { pgTable, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";

/**
 * Logical/type-inference shape ONLY (Phase 13, CMP-08, D-05, plan 13-01,
 * Task 2). The physical table -- including RLS, its index, and the table
 * comment -- is created by the hand-written migration
 * packages/db/migrations/0055_webhook_ingress_durability.sql (mirrors this
 * codebase's "type-inference shape ONLY" precedent, e.g. `send-events.ts`,
 * `dead-letter-jobs.ts`). This file exists purely so application code
 * (`packages/db/src/webhooks/quarantine.ts`) gets typed query results via
 * Drizzle's schema inference.
 *
 * `occurredAtCandidate` is `text`, not `timestamp`, deliberately -- the
 * value being quarantined is exactly the one the platform refuses to trust
 * as a timestamp; see the migration's own comment for the full reasoning.
 */
export const sendEventQuarantine = pgTable("send_event_quarantine", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  sgEventId: text("sg_event_id"),
  eventType: text("event_type"),
  rawEvent: jsonb("raw_event").notNull(),
  reason: text("reason").notNull(),
  occurredAtCandidate: text("occurred_at_candidate"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});
