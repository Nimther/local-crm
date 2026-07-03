import { getWorkspaceId, withTenantTransaction } from "../../middleware/tenant-context.js";

export interface SendgridKeyRow {
  workspaceId: string;
  ciphertext: string;
  encryptedDek: string;
  iv: string;
  authTag: string;
  keyMask: string;
  status: "active" | "error";
  lastCheckedAt: Date | null;
}

export interface UpsertSendgridKeyInput {
  ciphertext: string;
  encryptedDek: string;
  iv: string;
  authTag: string;
  keyMask: string;
  status: "active" | "error";
}

/**
 * Tenant-scoped CRUD for `workspace_sendgrid_keys`, always inside
 * `withTenantTransaction` so the RLS `workspace_isolation` policy is the
 * live enforcement mechanism, not just an app-level `WHERE`. Used by
 * 01-05's connect flow and by rls-pooling-chaos.test.ts (TENANT-05).
 *
 * `last_checked_at` is set to `now()` here too (not just on recheck) --
 * connecting a key always means it was just live-validated (D-21).
 */
export async function upsertKey(row: UpsertSendgridKeyInput): Promise<void> {
  await withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    await client.query(
      `INSERT INTO workspace_sendgrid_keys
         (workspace_id, ciphertext, encrypted_dek, iv, auth_tag, key_mask, status, last_checked_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())
       ON CONFLICT (workspace_id) DO UPDATE SET
         ciphertext = EXCLUDED.ciphertext,
         encrypted_dek = EXCLUDED.encrypted_dek,
         iv = EXCLUDED.iv,
         auth_tag = EXCLUDED.auth_tag,
         key_mask = EXCLUDED.key_mask,
         status = EXCLUDED.status,
         last_checked_at = now(),
         updated_at = now()`,
      [workspaceId, row.ciphertext, row.encryptedDek, row.iv, row.authTag, row.keyMask, row.status]
    );
  });
}

/** Recheck (D-22 "Проверить сейчас"): updates only status + last_checked_at, leaving the stored ciphertext untouched. */
export async function updateKeyStatus(status: "active" | "error"): Promise<void> {
  await withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    await client.query(
      `UPDATE workspace_sendgrid_keys
       SET status = $2, last_checked_at = now(), updated_at = now()
       WHERE workspace_id = $1`,
      [workspaceId, status]
    );
  });
}

export async function getKey(): Promise<SendgridKeyRow | null> {
  return withTenantTransaction(async (client) => {
    const { rows } = await client.query<{
      workspaceId: string;
      ciphertext: string;
      encryptedDek: string;
      iv: string;
      authTag: string;
      keyMask: string;
      status: "active" | "error";
      lastCheckedAt: Date | null;
    }>(
      `SELECT
         workspace_id as "workspaceId",
         ciphertext,
         encrypted_dek as "encryptedDek",
         iv,
         auth_tag as "authTag",
         key_mask as "keyMask",
         status,
         last_checked_at as "lastCheckedAt"
       FROM workspace_sendgrid_keys
       WHERE workspace_id = current_setting('app.current_workspace_id', true)::uuid`
    );
    return rows[0] ?? null;
  });
}
