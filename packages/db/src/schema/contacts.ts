import { pgTable, text, timestamp, uuid, jsonb, pgEnum, unique } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";

/**
 * 3-state subscription status (SUBS-01). `suppressed` is set only by the
 * repository's suppression-list check on create (D-08/D-11) or by a future
 * bounce/spam webhook (Phase 5) -- never directly settable by an ordinary
 * update, see contact.repository.ts's updateContact (D-12).
 */
export const subscriptionStatusEnum = pgEnum("subscription_status", [
  "subscribed",
  "unsubscribed",
  "suppressed",
]);

/**
 * The spine of the phase: standard fields (D-09) + freeform JSONB
 * `properties` (D-09/D-10) + 3-state subscription status (SUBS-01). Two
 * composite UNIQUE constraints enforce D-01/D-02's identity model --
 * Postgres treats multiple NULLs as distinct by default, so many
 * external_id-only or email-only contacts can coexist within a workspace
 * without a partial-index workaround.
 */
export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    externalId: text("external_id"), // D-06: settable once, immutable after
    email: text("email"), // D-07: editable with uniqueness check
    firstName: text("first_name"),
    lastName: text("last_name"),
    phone: text("phone"),
    city: text("city"),
    country: text("country"),
    tags: text("tags").array().notNull().default([]),
    properties: jsonb("properties").notNull().default({}), // D-09/D-10 custom properties
    subscriptionStatus: subscriptionStatusEnum("subscription_status").notNull().default("subscribed"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [unique("contacts_workspace_external_id_unique").on(t.workspaceId, t.externalId), unique("contacts_workspace_email_unique").on(t.workspaceId, t.email)]
);
