import { pool } from "../../db.js";
import { getWorkspaceId, withTenantTransaction } from "../../middleware/tenant-context.js";

export interface WebhookEndpointLookupRow {
  workspaceId: string;
  publicKey: string | null;
}

export interface WebhookEndpointRow {
  pathToken: string;
  sendgridWebhookId: string | null;
  publicKey: string | null;
  provisionStatus: string;
  lastEventAt: Date | null;
}

export interface UpsertWebhookEndpointInput {
  pathToken: string;
  sendgridWebhookId: string | null;
  publicKey: string | null;
  provisionStatus: string;
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

/**
 * Tenant-scoped read of the single per-workspace endpoint row (D-01/D-02/D-03).
 * Unlike `findWebhookEndpointByToken` (pre-tenant-context runtime lookup via
 * the `webhook_endpoint_runtime_lookup` policy), this goes through the
 * normal `withTenantTransaction`/`workspace_isolation` RLS path like every
 * other tenant-scoped repository -- it is only ever called from an
 * authenticated route (webhook-health/reconnect, sendgrid-key connect/recheck).
 */
export async function getWebhookEndpointByWorkspace(): Promise<WebhookEndpointRow | null> {
  return withTenantTransaction(async (client) => {
    const { rows } = await client.query<WebhookEndpointRow>(
      `SELECT path_token as "pathToken", sendgrid_webhook_id as "sendgridWebhookId",
              public_key as "publicKey", provision_status as "provisionStatus",
              last_event_at as "lastEventAt"
       FROM workspace_webhook_endpoints
       WHERE workspace_id = current_setting('app.current_workspace_id', true)::uuid`
    );
    return rows[0] ?? null;
  });
}

/**
 * Inserts-or-updates the single per-workspace endpoint row (D-01/D-02/D-05).
 * There is no DB-level `UNIQUE(workspace_id)` constraint (only `path_token`
 * is unique) -- this SELECT-then-branch is safe because provisioning is
 * only ever triggered synchronously from a single connect/recheck HTTP
 * request for a given workspace, never concurrently.
 */
export async function upsertWebhookEndpoint(row: UpsertWebhookEndpointInput): Promise<void> {
  await withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM workspace_webhook_endpoints WHERE workspace_id = $1`,
      [workspaceId]
    );
    if (rows[0]) {
      await client.query(
        `UPDATE workspace_webhook_endpoints
         SET path_token = $2, sendgrid_webhook_id = $3, public_key = $4,
             provision_status = $5, updated_at = now()
         WHERE workspace_id = $1`,
        [workspaceId, row.pathToken, row.sendgridWebhookId, row.publicKey, row.provisionStatus]
      );
    } else {
      await client.query(
        `INSERT INTO workspace_webhook_endpoints
           (workspace_id, path_token, sendgrid_webhook_id, public_key, provision_status)
         VALUES ($1, $2, $3, $4, $5)`,
        [workspaceId, row.pathToken, row.sendgridWebhookId, row.publicKey, row.provisionStatus]
      );
    }
  });
}
