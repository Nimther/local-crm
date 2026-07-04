import { pgTable, text, timestamp, uuid, unique } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";

/**
 * Compliance suppression list (D-08): an unsubscribed/suppressed contact's
 * email is written here on delete so a re-import/re-create of that email
 * cannot silently resurrect it as `subscribed` -- see
 * contact.repository.ts's createContact (checked before insert) and
 * deleteContact (written here).
 */
export const workspaceSuppressions = pgTable(
  "workspace_suppressions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    reason: text("reason").notNull().default("manual"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [unique("workspace_suppressions_workspace_email_unique").on(t.workspaceId, t.email)]
);
