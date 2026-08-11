import { pgTable, text, timestamp, uuid, integer, jsonb } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { contacts } from "./contacts.js";

/**
 * Phase 13 (CMP-04, D-01/D-04, plan 13-10): the auditable proof an erasure
 * ran. Written in the SAME transaction as `contacts.anonymized_at` being
 * set and the `workspace_suppressions` insert
 * (`apps/api/src/modules/contacts/contact.repository.ts`'s `deleteContact`)
 * -- never by the scrub job itself, so a crash cannot leave an anonymized
 * row with no record of why. `status` starts `pending` and is advanced to
 * `scrubbing`/`complete`/`failed` by plan 13-13's scrub worker.
 *
 * The physical table -- including the `status` CHECK constraint -- is
 * created by the hand-written migration
 * `packages/db/migrations/0059_contact_erasure.sql`. This file exists so
 * application code gets typed query results via Drizzle's schema
 * inference, matching `dead-letter-jobs.ts`'s own precedent: Drizzle's
 * `pgTable` API has no expression for a CHECK constraint on a column, so
 * the migration remains the single source of truth for that constraint.
 *
 * Unlike `dead_letter_jobs`/`reputation_alert_state` (platform-ops
 * metadata, no RLS), this table gets the SAME fail-closed, role-scoped
 * `workspace_isolation` policy every other tenant-scoped table carries --
 * this is tenant data describing a tenant's own compliance action.
 *
 * `status` is typed `text` here (not a Drizzle enum) for the same reason
 * `dead-letter-jobs.ts` leaves its CHECK-constrained columns as plain
 * `text`: Drizzle's `pgTable` API has no expression for a CHECK constraint
 * that matches the migration's enforcement exactly, so the migration stays
 * the single source of truth and this file adds no parallel, possibly-
 * drifting declaration. `ErasureRecordStatus` below is the TypeScript-side
 * mirror of migration 0059's `CHECK (status IN (...))`.
 *
 * `sends_scrub_cursor`/`events_scrub_cursor` are `jsonb`, not `uuid`: the
 * keyset over `sends`/`send_events` and `events` is composite (an
 * `occurred_at`/`created_at` timestamp plus an `id`), so a single uuid
 * column cannot express a resume position on a partitioned table. Written
 * by plan 13-13's scrub worker in the SAME transaction as that page's
 * UPDATE; null means the walk over that table has not started.
 */
export const erasureRecords = pgTable(
  "erasure_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    anonymizedAt: timestamp("anonymized_at", { withTimezone: true }).notNull(),
    scrubStartedAt: timestamp("scrub_started_at", { withTimezone: true }),
    scrubCompletedAt: timestamp("scrub_completed_at", { withTimezone: true }),
    status: text("status").notNull().default("pending"),
    scrubError: text("scrub_error"),
    sendsScrubbed: integer("sends_scrubbed").notNull().default(0),
    eventsScrubbed: integer("events_scrubbed").notNull().default(0),
    sendsScrubCursor: jsonb("sends_scrub_cursor"),
    eventsScrubCursor: jsonb("events_scrub_cursor"),
  }
);

export type ErasureRecordStatus = "pending" | "scrubbing" | "complete" | "failed";
