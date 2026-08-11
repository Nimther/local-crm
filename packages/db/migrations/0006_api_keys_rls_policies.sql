-- Row-Level Security for workspace_api_keys (Phase 2 Plan 3, T-02-03-05).
-- Same ENABLE + FORCE + workspace_isolation shape as every other
-- tenant-scoped table (see 0001_rls_policies.sql's comment on why FORCE is
-- required -- the app role owns its own tables and Postgres exempts owners
-- from RLS by default).

ALTER TABLE workspace_api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_api_keys FORCE ROW LEVEL SECURITY;

-- NULLIF guard (not present in 0001/0004's identical-looking policies,
-- which is safe there because those tables are ONLY ever queried inside
-- withTenantTransaction, which always sets a real, non-empty
-- app.current_workspace_id before every query): workspace_api_keys is also
-- read by lookupApiKeyById below on a pooled connection that never sets
-- app.current_workspace_id at all. Once a custom GUC name has been touched
-- anywhere in a session (even via a since-committed SET LOCAL on a reused
-- pooled connection), current_setting(name, true) reverts to '' rather than
-- NULL for the rest of that session -- casting '' straight to ::uuid throws
-- `invalid input syntax for type uuid`, not a graceful non-match. NULLIF
-- converts that leftover '' into a true NULL first, so the comparison
-- evaluates to NULL (excluded) instead of erroring.
CREATE POLICY workspace_isolation ON workspace_api_keys
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

-- The runtime `apiKeyAuth` hook (api-key-auth.ts) resolves workspace_id FROM
-- the presented key itself -- there is no :slug/session to derive a tenant
-- context from yet, so `lookupApiKeyById` cannot go through the normal
-- withTenantTransaction path the `workspace_isolation` policy above
-- protects. This second, SELECT-only permissive policy grants exactly one
-- row: the one whose primary key `id` matches the caller-supplied
-- `app.api_key_lookup_id` GUC. Postgres combines multiple PERMISSIVE
-- policies for the same command with OR, so:
--   * ordinary tenant-scoped queries (list/create/revoke, which set
--     app.current_workspace_id and never touch app.api_key_lookup_id) are
--     unaffected -- this policy's condition is NULL (false) for every row
--     when the lookup GUC isn't set;
--   * the runtime lookup (which sets ONLY app.api_key_lookup_id, never
--     app.current_workspace_id) can read the single row it already knows
--     the non-secret id of, and nothing else -- it grants no ability to
--     enumerate or scan other tenants' rows.
-- INSERT/UPDATE/DELETE are untouched by this policy (FOR SELECT only) and
-- remain governed solely by workspace_isolation above.
CREATE POLICY api_key_runtime_lookup ON workspace_api_keys
  FOR SELECT
  USING (id = current_setting('app.api_key_lookup_id', true));
