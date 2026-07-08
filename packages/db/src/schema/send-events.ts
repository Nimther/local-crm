import { pgTable, text, timestamp, uuid, jsonb, boolean } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { sends } from "./sends.js";

/**
 * Logical/type-inference shape ONLY (WBHK-01/02/03, D-14/D-16). Drizzle's
 * `pgTable` cannot express `PARTITION BY RANGE (occurred_at)` or a composite
 * primary key that includes the partition key column the way Postgres
 * declarative partitioning requires -- the physical partitioned table, its
 * monthly partitions, indexes, and RLS policy are created by HAND-WRITTEN
 * migrations (packages/db/migrations/0020_send_events_partitioned.sql), NOT
 * by `drizzle-kit generate` against this file (mirrors events.ts's own
 * "type-inference shape ONLY" precedent -- see that file's doc-comment).
 * This file exists purely so application code (webhook-events.worker.ts,
 * future contact-timeline reads) gets typed query results via Drizzle's
 * schema inference.
 *
 * `sendId` is NULLABLE (D-15): an event whose custom_args.send_id points at
 * a deleted/orphaned send -- or a test send with no `sends` row at all --
 * is still stored, just without a resolvable FK target.
 *
 * Physical UNIQUE dedup key (as of 0020): `(workspace_id, sg_event_id,
 * occurred_at)` -- this is WBHK-03's actual dedup mechanism. `occurred_at`
 * is included alongside the PK's partition-key requirement: Postgres
 * requires every unique constraint on a partitioned table to include all
 * partition key columns, so the constraint cannot be `(workspace_id,
 * sg_event_id)` alone. `occurred_at` is deterministically resolved from the
 * SendGrid event's own `timestamp` field, so it is identical across
 * redeliveries of the same event -- the `ON CONFLICT (workspace_id,
 * sg_event_id, occurred_at) DO NOTHING` insert in webhook-events.worker.ts
 * still dedupes correctly on the sole natural key that matters
 * (`sg_event_id`).
 */
export const sendEvents = pgTable("send_events", {
  id: uuid("id").notNull(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  sgEventId: text("sg_event_id").notNull(),
  sendId: uuid("send_id").references(() => sends.id, { onDelete: "set null" }),
  eventType: text("event_type").notNull(),
  reason: text("reason"),
  payload: jsonb("payload").notNull().default({}),
  isTest: boolean("is_test").notNull().default(false),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});
