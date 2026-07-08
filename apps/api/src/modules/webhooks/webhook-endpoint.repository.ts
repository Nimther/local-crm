import { pool } from "../../db.js";

export interface WebhookEndpointLookupRow {
  workspaceId: string;
  publicKey: string | null;
}

/**
 * Runtime pathToken lookup (WBHK-01, mirrors `lookupApiKeyById`'s Pattern 3
 * exactly -- see api-keys.repository.ts's doc-comment): by definition runs
 * BEFORE the caller's workspace is known -- the pathToken in the URL IS the
 * pre-verification trust anchor (RESEARCH.md Architecture Pattern 1) -- so
 * it cannot go through `withTenantTransaction` (which requires an
 * already-established tenant context). `workspace_webhook_endpoints` still
 * carries ENABLE + FORCE ROW LEVEL SECURITY + the standard
 * `workspace_isolation` policy for every workspace-scoped read/write
 * (packages/db/migrations/0021_webhook_endpoints.sql); this function
 * additionally relies on a second, SELECT-only permissive policy
 * (`webhook_endpoint_runtime_lookup`) that permits a read matched EXACTLY
 * by `path_token` when the session-local GUC `app.webhook_path_token` is
 * set to that same token. A caller can only reach a row here by already
 * possessing the specific unguessable token embedded in the webhook URL --
 * this grants no ability to enumerate or scan other tenants' rows.
 *
 * `publicKey` is safe to return as-is (not a secret, RESEARCH.md Assumption
 * A1) -- the caller (webhooks.routes.ts) uses it directly for ECDSA
 * verification.
 */
export async function findWebhookEndpointByToken(
  pathToken: string
): Promise<WebhookEndpointLookupRow | null> {
  const client = await pool.connect();
  let releaseWithError: Error | undefined;
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.webhook_path_token', $1, true)", [pathToken]);
    const { rows } = await client.query<WebhookEndpointLookupRow>(
      `SELECT workspace_id as "workspaceId", public_key as "publicKey"
       FROM workspace_webhook_endpoints WHERE path_token = $1`,
      [pathToken]
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
      // checkout on this hot public-webhook-receiver path never inherits a
      // broken connection (WR-09 precedent).
      releaseWithError = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
    }
    throw err;
  } finally {
    client.release(releaseWithError);
  }
}
