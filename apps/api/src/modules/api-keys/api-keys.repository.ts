import { pool } from "../../db.js";
import { getWorkspaceId, withTenantTransaction } from "../../middleware/tenant-context.js";

export interface ApiKeyListItemRow {
  id: string;
  name: string;
  keyMask: string;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface ApiKeyLookupRow {
  id: string;
  workspaceId: string;
  secretHash: string;
  revokedAt: Date | null;
}

const LIST_COLUMNS = `
  id,
  name,
  key_mask as "keyMask",
  created_at as "createdAt",
  revoked_at as "revokedAt"
`;

/**
 * D-21/D-22: persists only what `generateApiKey()` computed (hash + mask) --
 * the plaintext secret never reaches this function; the route returns the
 * full key to the caller directly from the generator's return value.
 */
export async function createApiKey(input: {
  id: string;
  name: string;
  secretHash: string;
  keyMask: string;
}): Promise<ApiKeyListItemRow> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows } = await client.query<ApiKeyListItemRow>(
      `INSERT INTO workspace_api_keys (id, workspace_id, name, secret_hash, key_mask)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${LIST_COLUMNS}`,
      [input.id, workspaceId, input.name, input.secretHash, input.keyMask]
    );
    return rows[0];
  });
}

/** D-21: every named key in the caller's workspace, newest first -- never includes the secret or its hash. */
export async function listApiKeys(): Promise<ApiKeyListItemRow[]> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows } = await client.query<ApiKeyListItemRow>(
      `SELECT ${LIST_COLUMNS} FROM workspace_api_keys WHERE workspace_id = $1 ORDER BY created_at DESC`,
      [workspaceId]
    );
    return rows;
  });
}

/** Returns false (not a throw) when the id doesn't exist/isn't in this workspace -- the route maps that to 404 (non-enumeration). */
export async function revokeApiKey(id: string): Promise<boolean> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows } = await client.query(
      `UPDATE workspace_api_keys SET revoked_at = now()
       WHERE workspace_id = $1 AND id = $2 AND revoked_at IS NULL
       RETURNING id`,
      [workspaceId, id]
    );
    return rows.length > 0;
  });
}

/**
 * Runtime auth lookup (Pattern 3): by definition runs BEFORE the caller's
 * workspace is known, so it cannot go through `withTenantTransaction` (which
 * requires an already-established tenant context) -- there is no `:slug` or
 * session to derive one from. `workspace_api_keys` still carries
 * ENABLE + FORCE ROW LEVEL SECURITY + the standard `workspace_isolation`
 * policy for every workspace-scoped read/write above (T-02-03-05); this
 * function additionally relies on a second, SELECT-only permissive policy
 * (`api_key_runtime_lookup`, see migrations/0005_api_keys.sql) that permits
 * a read matched EXACTLY by primary key `id` when the session-local GUC
 * `app.api_key_lookup_id` is set to that same id. A caller can only reach a
 * row here by already possessing the specific non-secret id embedded in the
 * presented key -- this grants no ability to enumerate or scan other
 * tenants' rows, and mirrors how better-auth's own tables are read outside
 * the tenant-scoped RLS path (see 0001_rls_policies.sql's comment on
 * better-auth tables).
 */
export async function lookupApiKeyById(id: string): Promise<ApiKeyLookupRow | null> {
  const client = await pool.connect();
  let releaseWithError: Error | undefined;
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.api_key_lookup_id', $1, true)", [id]);
    const { rows } = await client.query<ApiKeyLookupRow>(
      `SELECT id, workspace_id as "workspaceId", secret_hash as "secretHash", revoked_at as "revokedAt"
       FROM workspace_api_keys WHERE id = $1`,
      [id]
    );
    await client.query("COMMIT");
    return rows[0] ?? null;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      // The ROLLBACK itself failed -- the connection is dead. Passing the
      // error to `client.release()` below tells node-postgres to DESTROY
      // this client instead of returning it to the pool, so the next
      // checkout on this hot auth-lookup path never inherits a broken
      // connection (WR-09).
      releaseWithError = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
    }
    throw err;
  } finally {
    client.release(releaseWithError);
  }
}
