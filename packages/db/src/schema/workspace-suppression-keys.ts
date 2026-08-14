import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";

/**
 * Phase 13 (CMP-04, D-02, plan 13-12) -- one HMAC key per workspace, used to
 * hash addresses before they are written to `workspace_suppressions.email_hash`
 * (see `packages/contacts-core/src/suppression-hash.ts`). Envelope-encrypted
 * at rest via `@mega-crm/kms`'s `encryptTenantSecret`/`decryptTenantSecret`,
 * the SAME per-workspace-DEK-wrapped-by-a-KMS-KEK shape `sendgrid-keys.ts`
 * uses for tenant SendGrid API keys -- this is the second table in the
 * codebase to hold a KMS-wrapped secret, and it follows that table's column
 * shape verbatim (encrypted_dek/ciphertext/iv/auth_tag) rather than inventing
 * a new envelope shape.
 *
 * Per-workspace (not one platform-wide key) is a deliberate blast-radius
 * choice, not a strength argument: an email address is not a high-entropy
 * secret, so this hash is a PII-minimization measure, not a cryptographic
 * guarantee. A leaked platform-wide key would let an attacker build one
 * rainbow table against every tenant's suppression list at once; a
 * per-workspace key confines a leak to that one workspace.
 *
 * A missing row for a workspace means "this workspace has never suppressed
 * anything" -- `loadWorkspaceSuppressionKey` returns null rather than
 * creating one, and `isEmailSuppressed` short-circuits to false without ever
 * reaching this table or performing any KMS work, which is what keeps the
 * pre-send suppression check cheap for the common case.
 */
export const workspaceSuppressionKeys = pgTable("workspace_suppression_keys", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  encryptedDek: text("encrypted_dek").notNull(),
  ciphertext: text("ciphertext").notNull(),
  iv: text("iv").notNull(),
  authTag: text("auth_tag").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
