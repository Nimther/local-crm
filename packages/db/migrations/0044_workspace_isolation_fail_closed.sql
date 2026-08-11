-- Phase 10 (SEC-03/SEC-04): the single isolated migration that rewrites
-- every one of the 22 `workspace_isolation` policies to ONE fail-closed,
-- explicitly role-scoped predicate. Twelve tables (workspace_sendgrid_keys,
-- contacts, workspace_suppressions, workspace_property_registry, events,
-- csv_imports, csv_import_rows, segments, campaign_recipients, sends,
-- workspace_send_settings, send_events) are today bare-cast with a
-- `missing_ok` second argument; ten (workspace_api_keys, campaigns,
-- workspace_webhook_endpoints, flows, flow_versions, flow_runs,
-- flow_run_steps, flow_segment_membership_snapshot,
-- subscription_status_history, workspace_daily_rollup) are today
-- NULLIF-guarded. Both variants are fail-OPEN on a connection that has
-- never touched `app.current_workspace_id` at all: `current_setting(key,
-- true)` returns NULL rather than raising, and `NULL::uuid = anything` is
-- NULL -- excluded, not an error. RESEARCH.md Pitfall 1 (verified live
-- against Postgres 17.10, this project's own GUC name and cast pattern):
-- dropping ONLY the NULLIF guard is not sufficient -- the `missing_ok`
-- second argument to `current_setting` must ALSO go, or a genuinely
-- untouched connection still returns zero rows instead of erroring, which
-- fails SEC-04's acceptance outright.
--
-- Direction is deliberate and one-way: the fail-closed bare form, no second
-- argument, no NULLIF. The OPPOSITE direction -- standardizing on NULLIF
-- because it "looks safer" -- is fail-OPEN and would silently convert the
-- twelve currently bare-cast tables (which already throw on a connection
-- recycled from a committed tenant-scoped transaction, since the GUC
-- reverts to '' rather than NULL) into the same zero-row-returning shape
-- the NULLIF-guarded ten use today. A missing tenant context must always be
-- a thrown error -- the only signal application code cannot mistake for "no
-- such record" -- never a silently empty result set.
--
-- Every statement below is an `ALTER POLICY`, never `DROP POLICY` /
-- `CREATE POLICY` -- so the migration linter's destructive-DDL rule does
-- not apply here and no marker comment is needed.
--
-- RLS policy changes are forward-only per DB-07's rollback model: reverting
-- this migration means writing a NEW migration that restores a prior
-- predicate, never rolling back this file in place.
--
-- Five of the 22 tables (campaigns, flow_runs, flows, contacts, sends)
-- already carry `TO mega_crm_app` from migrations 0041/0042 (the scan-role
-- rollout) -- the ALTER POLICY statements below re-assert that role scope
-- idempotently for those five while changing their predicate for the first
-- time, and add both the predicate rewrite AND the role scope together for
-- the remaining seventeen.

ALTER POLICY workspace_isolation ON workspace_sendgrid_keys TO mega_crm_app
  USING (workspace_id = current_setting('app.current_workspace_id')::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id')::uuid);

ALTER POLICY workspace_isolation ON contacts TO mega_crm_app
  USING (workspace_id = current_setting('app.current_workspace_id')::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id')::uuid);

ALTER POLICY workspace_isolation ON workspace_suppressions TO mega_crm_app
  USING (workspace_id = current_setting('app.current_workspace_id')::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id')::uuid);

ALTER POLICY workspace_isolation ON workspace_property_registry TO mega_crm_app
  USING (workspace_id = current_setting('app.current_workspace_id')::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id')::uuid);

ALTER POLICY workspace_isolation ON workspace_api_keys TO mega_crm_app
  USING (workspace_id = current_setting('app.current_workspace_id')::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id')::uuid);

ALTER POLICY workspace_isolation ON events TO mega_crm_app
  USING (workspace_id = current_setting('app.current_workspace_id')::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id')::uuid);

ALTER POLICY workspace_isolation ON csv_imports TO mega_crm_app
  USING (workspace_id = current_setting('app.current_workspace_id')::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id')::uuid);

ALTER POLICY workspace_isolation ON csv_import_rows TO mega_crm_app
  USING (workspace_id = current_setting('app.current_workspace_id')::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id')::uuid);

ALTER POLICY workspace_isolation ON segments TO mega_crm_app
  USING (workspace_id = current_setting('app.current_workspace_id')::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id')::uuid);

ALTER POLICY workspace_isolation ON campaigns TO mega_crm_app
  USING (workspace_id = current_setting('app.current_workspace_id')::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id')::uuid);

ALTER POLICY workspace_isolation ON campaign_recipients TO mega_crm_app
  USING (workspace_id = current_setting('app.current_workspace_id')::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id')::uuid);

ALTER POLICY workspace_isolation ON sends TO mega_crm_app
  USING (workspace_id = current_setting('app.current_workspace_id')::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id')::uuid);

ALTER POLICY workspace_isolation ON workspace_send_settings TO mega_crm_app
  USING (workspace_id = current_setting('app.current_workspace_id')::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id')::uuid);

ALTER POLICY workspace_isolation ON send_events TO mega_crm_app
  USING (workspace_id = current_setting('app.current_workspace_id')::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id')::uuid);

ALTER POLICY workspace_isolation ON workspace_webhook_endpoints TO mega_crm_app
  USING (workspace_id = current_setting('app.current_workspace_id')::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id')::uuid);

ALTER POLICY workspace_isolation ON flows TO mega_crm_app
  USING (workspace_id = current_setting('app.current_workspace_id')::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id')::uuid);

ALTER POLICY workspace_isolation ON flow_versions TO mega_crm_app
  USING (workspace_id = current_setting('app.current_workspace_id')::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id')::uuid);

ALTER POLICY workspace_isolation ON flow_runs TO mega_crm_app
  USING (workspace_id = current_setting('app.current_workspace_id')::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id')::uuid);

ALTER POLICY workspace_isolation ON flow_run_steps TO mega_crm_app
  USING (workspace_id = current_setting('app.current_workspace_id')::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id')::uuid);

ALTER POLICY workspace_isolation ON flow_segment_membership_snapshot TO mega_crm_app
  USING (workspace_id = current_setting('app.current_workspace_id')::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id')::uuid);

ALTER POLICY workspace_isolation ON subscription_status_history TO mega_crm_app
  USING (workspace_id = current_setting('app.current_workspace_id')::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id')::uuid);

ALTER POLICY workspace_isolation ON workspace_daily_rollup TO mega_crm_app
  USING (workspace_id = current_setting('app.current_workspace_id')::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id')::uuid);

-- Role-scope the two pre-tenant lookup policies too: both are permissive
-- SELECT-only policies on tenant tables and are therefore subject to the
-- exact same OR-combined-permissive-policies problem (RESEARCH.md Pitfall
-- 2) as workspace_isolation itself -- left unscoped, mega_crm_scan's and
-- mega_crm_auth's future queries against these two tables would also have
-- to satisfy (or error on) these lookup policies' predicates. Their own
-- predicates are UNCHANGED here -- they are not tenant-isolation policies,
-- they are single-row, id/token-keyed grants that plan 10-07's task 3
-- (`withPreTenantLookup`) depends on continuing to work exactly as before.
ALTER POLICY api_key_runtime_lookup ON workspace_api_keys TO mega_crm_app;
ALTER POLICY webhook_endpoint_runtime_lookup ON workspace_webhook_endpoints TO mega_crm_app;
