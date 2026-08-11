import { pgTable, text, timestamp, uuid, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";

/**
 * Compliance suppression list (D-08): an unsubscribed/suppressed contact's
 * address is written here on delete so a re-import/re-create of that address
 * cannot silently resurrect it as `subscribed` -- see
 * contact.repository.ts's createContact (checked before insert) and
 * deleteContact (written here).
 *
 * CMP-04 (D-02, plan 13-12): this table is mid-migration to proving that an
 * address was suppressed WITHOUT recording what the address was. `emailHash`
 * is an HMAC-SHA256 of the normalized address under the workspace's own key
 * (`workspace_suppression_keys`, `packages/contacts-core/src/suppression-hash.ts`)
 * -- a hash is workspace-scoped by key, so it is meaningless outside its
 * workspace and cannot be cross-referenced between tenants.
 *
 * This file reflects the EXPAND state (post-migration-0060, pre-0061): both
 * `email` (now nullable) and `emailHash` (nullable until every row is
 * backfilled) coexist, and both unique constraints exist side by side. Every
 * write site as of this plan writes ONLY `emailHash`, never `email` --
 * `email` survives only on rows written before this conversion, until
 * `npm run db:rehash-suppressions` backfills them and migration 0061 drops
 * the column. Migration 0061's own Task updates this file again to drop
 * `email` and make `emailHash` NOT NULL.
 */
export const workspaceSuppressions = pgTable(
  "workspace_suppressions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text("email"),
    emailHash: text("email_hash"),
    reason: text("reason").notNull().default("manual"),
    suppressedAt: timestamp("suppressed_at", { withTimezone: true }).notNull().defaultNow(),
    source: text("source"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("workspace_suppressions_workspace_email_unique").on(t.workspaceId, t.email),
    uniqueIndex("workspace_suppressions_workspace_email_hash_unique").on(t.workspaceId, t.emailHash),
  ]
);
