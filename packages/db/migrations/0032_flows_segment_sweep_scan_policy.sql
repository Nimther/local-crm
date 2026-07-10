-- 06-08 (T-06-08-02): flow-segment-sweep.worker.ts's discovery scan must find
-- every LIVE segment-triggered flow ACROSS every tenant -- it doesn't know
-- which workspace a flow belongs to until it reads it, which the ordinary
-- workspace_isolation policy alone can never permit. Mirrors 0018/0027's
-- admin-scan precedent exactly: a second, SELECT-only permissive policy,
-- gated on app.admin_scan='true' (Postgres ORs all permissive policies for a
-- command together, so ordinary tenant-scoped queries -- which never touch
-- app.admin_scan -- are entirely unaffected). Every subsequent read/write
-- (segment lookup, bulk contacts query, flow_runs insert, membership-
-- snapshot upsert) re-enters withTenant(workspaceId) and is fully
-- RLS-scoped as normal -- this policy grants READ visibility only, never a
-- write path.
CREATE POLICY flows_segment_sweep_scan ON flows
  FOR SELECT
  USING (
    current_setting('app.admin_scan', true) = 'true'
  );
