import { pgTable, text, timestamp, uuid, uniqueIndex } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";

/**
 * Compliance suppression list (D-08): an unsubscribed/suppressed contact's
 * address is written here on delete so a re-import/re-create of that address
 * cannot silently resurrect it as `subscribed` -- see
 * contact.repository.ts's createContact (checked before insert) and
 * deleteContact (written here).
 *
 * CMP-04 (D-02, plan 13-12): this table proves that an address was
 * suppressed WITHOUT recording what the address was. `emailHash` is an
 * HMAC-SHA256 of the normalized address under the workspace's own key
 * (`workspace_suppression_keys`, `packages/contacts-core/src/suppression-hash.ts`)
 * -- a hash is workspace-scoped by key, so it is meaningless outside its
 * workspace and cannot be cross-referenced between tenants.
 *
 * This is the post-migration-0061 (contract) shape: the plaintext `email`
 * column that this table held through migration 0059 is gone entirely, and
 * `emailHash` is the sole, NOT NULL identity column, unique per workspace.
 * Migration 0060 (expand) added `emailHash` alongside a still-nullable
 * `email` and left both unique constraints in place; `npm run
 * db:rehash-suppressions` backfilled every pre-existing plaintext row; and
 * migration 0061 (contract) is what reached this final shape -- it fails
 * closed if any row still has a null `emailHash` when it runs.
 */
export const workspaceSuppressions = pgTable(
  "workspace_suppressions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    emailHash: text("email_hash").notNull(),
    reason: text("reason").notNull().default("manual"),
    suppressedAt: timestamp("suppressed_at", { withTimezone: true }).notNull().defaultNow(),
    source: text("source"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("workspace_suppressions_workspace_email_hash_unique").on(t.workspaceId, t.emailHash)]
);
