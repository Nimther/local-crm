-- 04-06 (T-04-06-01): the campaign-scheduler worker must discover due
-- campaigns ACROSS every tenant (it doesn't know which workspace a
-- campaign belongs to until it reads it), which the existing
-- `workspace_isolation` policy alone can never permit -- that policy
-- requires `app.current_workspace_id` to already be set to the SPECIFIC
-- tenant being queried.
--
-- This second, SELECT-only permissive policy grants visibility into
-- EXACTLY the due-campaign predicate the scheduler scans for
-- (status='scheduled' AND scheduled_at<=now()), and ONLY when the
-- scheduler's own scan sets `app.admin_scan='true'` first -- Postgres
-- combines multiple PERMISSIVE policies for the same command with OR, so:
--   * ordinary tenant-scoped queries (which set app.current_workspace_id
--     and never touch app.admin_scan) are unaffected -- this policy's
--     condition is false for every row when the admin-scan GUC isn't set;
--   * the scheduler's scan (which sets ONLY app.admin_scan, never
--     app.current_workspace_id) can read exactly the due-campaign rows it
--     needs to kick off, and nothing else -- no other campaign, at any
--     other status, in any workspace, is ever visible through this policy.
-- Mirrors workspace_api_keys' `api_key_runtime_lookup` scoped-GUC-gated
-- SELECT policy precedent (0006_api_keys_rls_policies.sql). Every
-- subsequent write (the status transition to 'sending', the kickoff
-- enqueue) re-enters withTenant(workspace_id) and is fully RLS-scoped as
-- normal -- this policy grants READ visibility only, never a write path.
CREATE POLICY campaign_scheduler_due_scan ON campaigns
  FOR SELECT
  USING (
    current_setting('app.admin_scan', true) = 'true'
    AND status = 'scheduled'
    AND scheduled_at <= now()
  );
