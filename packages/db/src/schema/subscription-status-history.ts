import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { contacts } from "./contacts.js";

/**
 * Append-only log of every `contacts.subscription_status` transition (D-09,
 * ANLT-03) -- mirrors `flow_run_steps`' append-only audit-log shape. One row
 * per change -- never updated, never deleted -- written from every one of
 * the four mutation call sites (webhook suppression/unsubscribe, the
 * unsubscribe route, manual UI edits, and the shared CSV/API upsert) via the
 * single `recordSubscriptionStatusChange` helper in
 * `@mega-crm/contacts-core`. `oldStatus` is nullable only in the theoretical
 * case of a first-ever record with no prior value; every real caller in this
 * codebase always has a known prior status. `source` records which call
 * site produced the change (webhook_suppression | webhook_unsubscribe |
 * unsubscribe_route | manual_ui | csv_or_api_upsert).
 */
export const subscriptionStatusHistory = pgTable("subscription_status_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id")
    .notNull()
    .references(() => contacts.id, { onDelete: "cascade" }),
  oldStatus: text("old_status"),
  newStatus: text("new_status").notNull(),
  source: text("source").notNull(),
  reason: text("reason"),
  changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
});
