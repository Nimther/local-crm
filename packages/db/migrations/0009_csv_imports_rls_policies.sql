-- Row-Level Security for the two CSV-import tables introduced in Phase 2
-- Plan 7 (csv_imports, csv_import_rows). Same ENABLE + FORCE +
-- workspace_isolation shape as every other tenant-scoped table (see
-- 0001_rls_policies.sql's comment on why FORCE is required -- the app role
-- owns its own tables and Postgres exempts owners from RLS by default).

ALTER TABLE csv_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE csv_imports FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON csv_imports
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id', true)::uuid);

ALTER TABLE csv_import_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE csv_import_rows FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON csv_import_rows
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id', true)::uuid);
