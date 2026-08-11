-- Row-Level Security for the three new tenant-scoped tables introduced in
-- Phase 2 Plan 1 (contacts, workspace_suppressions,
-- workspace_property_registry). Same pattern as 0001_rls_policies.sql --
-- ENABLE + FORCE (required: the app role owns its own tables, and Postgres
-- exempts the table owner from RLS by default) + workspace_isolation policy
-- gated on the `app.current_workspace_id` GUC set per-transaction by
-- withTenantTransaction (see apps/api/src/middleware/tenant-context.ts).

ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON contacts
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id', true)::uuid);

ALTER TABLE workspace_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_suppressions FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON workspace_suppressions
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id', true)::uuid);

ALTER TABLE workspace_property_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_property_registry FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON workspace_property_registry
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id', true)::uuid);
