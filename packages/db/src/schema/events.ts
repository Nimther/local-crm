import { pgTable, text, timestamp, uuid, jsonb } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { contacts } from "./contacts.js";

/**
 * Logical/type-inference shape ONLY (EVNT-01/02/03). Drizzle's `pgTable`
 * cannot express `PARTITION BY RANGE (occurred_at)` or a composite primary
 * key that includes the partition key column the way Postgres declarative
 * partitioning requires -- the physical partitioned table, its monthly
 * partitions, indexes, and RLS policy are created by HAND-WRITTEN
 * migrations (packages/db/migrations/0007_events_partitioned.sql,
 * 0010_events_workspace_scoped_pk.sql), NOT by `drizzle-kit generate`
 * against this file (02-RESEARCH.md "No partitioned table precedent" / Code
 * Examples: events partitioned SQL). This file exists purely so application
 * code (the events:ingest worker, future contact-timeline reads) gets typed
 * query results via Drizzle's schema inference.
 *
 * Physical PK (as of 0010, CR-01/CR-03 gap closure): `(workspace_id, id,
 * occurred_at)` -- widened from the original `(id, occurred_at)` so a
 * client-supplied eventId can never collide across tenants. A DEFAULT
 * partition (`events_default`) also exists as a catch-all for any
 * occurredAt outside the pre-created monthly partitions, so a valid event
 * is never accepted (202) and then silently dropped on INSERT.
 */
export const events = pgTable("events", {
  id: uuid("id").notNull(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id")
    .notNull()
    .references(() => contacts.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  properties: jsonb("properties").notNull().default({}),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});
