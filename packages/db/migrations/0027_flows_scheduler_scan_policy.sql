-- 06-01 (T-06-01-03): the flow-reconciliation and flow-segment-sweep workers
-- must discover due flow_runs ACROSS every tenant (they don't know which
-- workspace a run belongs to until they read it), which the
-- workspace_isolation policy alone can never permit. This second,
-- SELECT-only permissive policy mirrors campaigns' 0018
-- campaign_scheduler_due_scan precedent exactly: it grants visibility
-- ONLY when the scanning worker's own scan sets app.admin_scan='true'
-- first (Postgres OR's all permissive policies for a command together, so
-- ordinary tenant-scoped queries -- which never touch app.admin_scan --
-- are entirely unaffected). Every subsequent write (the status transition
-- to 'advancing', the wake enqueue) re-enters withTenant(workspace_id) and
-- is fully RLS-scoped as normal -- this policy grants READ visibility
-- only, never a write path.
CREATE POLICY flow_runs_due_scan ON flow_runs
  FOR SELECT
  USING (
    current_setting('app.admin_scan', true) = 'true'
  );
