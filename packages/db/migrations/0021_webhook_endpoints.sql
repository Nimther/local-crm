-- workspace_webhook_endpoints table (WBHK-01, D-01/D-02/D-05): per-workspace
-- SendGrid Event Webhook registration -- pathToken (unguessable per-tenant
-- URL segment), the SendGrid-issued webhook id, and the verification public
-- key (plain text, NOT KMS-encrypted -- Assumption A1: a public key is not
-- a secret).
CREATE TABLE workspace_webhook_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  path_token text NOT NULL,
  sendgrid_webhook_id text,
  public_key text,
  provision_status text NOT NULL DEFAULT 'pending',
  last_event_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_webhook_endpoints_path_token_unique UNIQUE (path_token)
);

CREATE INDEX idx_workspace_webhook_endpoints_workspace ON workspace_webhook_endpoints (workspace_id);

-- Same ENABLE + FORCE shape as every other tenant-scoped table (see
-- 0001_rls_policies.sql's comment on why FORCE is required).
ALTER TABLE workspace_webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_webhook_endpoints FORCE ROW LEVEL SECURITY;

-- NULLIF guard applied from day one (02-03 STATE lesson / 0006's
-- workspace_api_keys precedent, and 0019's later fix for campaigns):
-- workspace_webhook_endpoints carries a SECOND permissive policy below
-- (webhook_endpoint_runtime_lookup) that is evaluated together with this
-- one (Postgres OR's all permissive policies for a command) and does NOT
-- set app.current_workspace_id -- on a reused pooled connection where that
-- GUC has previously been touched, current_setting(name, true) reverts to
-- '' (not NULL), and a bare `::uuid` cast on '' throws
-- "invalid input syntax for type uuid" instead of gracefully excluding the
-- row. NULLIF converts that leftover '' into a true NULL first, so the
-- comparison evaluates to NULL (excluded) instead of erroring.
CREATE POLICY workspace_isolation ON workspace_webhook_endpoints
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

-- The webhook route (apps/api/src/modules/webhooks/webhooks.routes.ts)
-- resolves workspace_id + public_key FROM the presented pathToken itself --
-- there is no :slug/session to derive a tenant context from yet (the
-- pathToken IS the pre-verification trust anchor), so
-- `findWebhookEndpointByToken` cannot go through the normal
-- withTenantTransaction path the `workspace_isolation` policy above
-- protects. This second, SELECT-only permissive policy grants exactly one
-- row: the one whose `path_token` matches the caller-supplied
-- `app.webhook_path_token` GUC. Mirrors `workspace_api_keys`'
-- `api_key_runtime_lookup` policy (0006_api_keys_rls_policies.sql) exactly,
-- swapping the id-keyed lookup for a path_token-keyed one (path_token is
-- unique, same single-row guarantee). INSERT/UPDATE/DELETE are untouched by
-- this policy (FOR SELECT only) and remain governed solely by
-- workspace_isolation above.
CREATE POLICY webhook_endpoint_runtime_lookup ON workspace_webhook_endpoints
  FOR SELECT
  USING (path_token = current_setting('app.webhook_path_token', true));
