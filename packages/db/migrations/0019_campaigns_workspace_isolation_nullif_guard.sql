-- Fix (found while implementing 04-06's campaign-scheduler admin scan,
-- migration 0018): campaigns' `workspace_isolation` policy used a bare
-- `::uuid` cast (no NULLIF guard) -- safe as long as EVERY query against
-- this table goes through `withTenantTransaction`, which always sets a
-- fresh, valid `app.current_workspace_id` at the start of its own
-- transaction. Migration 0018 added a second permissive SELECT policy
-- (`campaign_scheduler_due_scan`) for the scheduler's cross-tenant admin
-- scan, which deliberately never sets `app.current_workspace_id`. Postgres
-- evaluates ALL permissive policies for a command together as one OR'd
-- expression, so a bare-cast error in EITHER policy aborts the whole query
-- with "invalid input syntax for type uuid" whenever this custom GUC has
-- previously reverted to '' (not NULL) on a reused pooled connection --
-- the exact same underlying Postgres behavior `workspace_api_keys`'
-- `api_key_runtime_lookup` policy already guards against (see
-- 0006_api_keys_rls_policies.sql's comment). NULLIF converts that leftover
-- '' into a true NULL first, so the comparison evaluates to NULL (excluded)
-- instead of erroring.
ALTER POLICY workspace_isolation ON campaigns
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
