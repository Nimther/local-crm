import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";

/**
 * One tenant SendGrid key per workspace (KMS envelope-encrypted; see
 * apps/api/src/kms and 01-05's connect flow). This is the first
 * tenant-scoped domain table and therefore the table Row-Level Security is
 * proven against in this phase (TENANT-05) — see
 * ../../migrations/0001_rls_policies.sql. Every future tenant-scoped table
 * must get the same `workspace_isolation` policy shape.
 */
export const workspaceSendgridKeys = pgTable("workspace_sendgrid_keys", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  encryptedDek: text("encrypted_dek").notNull(),
  ciphertext: text("ciphertext").notNull(),
  iv: text("iv").notNull(),
  authTag: text("auth_tag").notNull(),
  keyMask: text("key_mask").notNull(),
  status: text("status").notNull().default("active"), // "active" | "error"
  lastCheckedAt: timestamp("last_checked_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
