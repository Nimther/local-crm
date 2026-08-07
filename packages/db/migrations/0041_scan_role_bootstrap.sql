-- Phase 10 (SEC-01/SEC-02, D-01/D-02/D-03) — first migration to depend on a
-- role it cannot create.
--
-- `mega_crm_scan` and `mega_crm_auth` are created in docker/init-app-role.sql
-- (fresh volumes) / scripts/ensure-db-roles.mjs (existing volumes), NOT here
-- -- migrations in this repo apply as `mega_crm_app`, which is NOCREATEROLE
-- (RESEARCH.md Pitfall 5). A `CREATE ROLE` statement in this file would fail
-- every single time it runs. GRANT statements, by contrast, CAN live here:
-- `mega_crm_app` owns every table in this database and table owners can
-- GRANT on objects they own without CREATEROLE.
--
-- This is a one-slice proof of the whole scan-role architecture (D-01's
-- separate-pool-and-credential shape, D-02's single withCrossWorkspaceScan
-- entry point) against exactly ONE cross-workspace consumer (campaign-
-- scheduler's due-campaign discovery) and exactly ONE table (campaigns).
-- The other four scan consumers (flow-segment-sweep, flow-reconciliation,
-- partition maintenance/relocation, analytics-reconciliation) and their
-- migrations land in later plans of this phase.

GRANT USAGE ON SCHEMA public TO mega_crm_scan;
GRANT SELECT ON campaigns TO mega_crm_scan;

-- Role-scoped, GUC-free scan policy (D-03): replaces 0018's GUC-gated
-- campaign_scheduler_due_scan for this consumer. The narrowing predicate
-- (status = 'scheduled' AND scheduled_at <= now()) is preserved VERBATIM
-- from 0018 -- RESEARCH.md Pitfall 3: role-scoping is the access control,
-- but it does not substitute for the row-narrowing predicate that was the
-- ORIGINAL requirement (T-04-06-01). Without this predicate the scan role
-- would see every campaign in every workspace, at any status, unconditionally.
CREATE POLICY campaigns_scan ON campaigns
  FOR SELECT TO mega_crm_scan
  USING (status = 'scheduled' AND scheduled_at <= now());

-- RESEARCH.md Pitfall 2: an unscoped (PUBLIC) `workspace_isolation` policy is
-- combined via OR with EVERY other permissive policy applicable to a query's
-- role -- including the scan role's own campaigns_scan policy above, once
-- mega_crm_scan exists. Without this explicit TO clause, a mega_crm_scan
-- query against campaigns would ALSO have to satisfy (or error on)
-- workspace_isolation's own predicate, reintroducing the exact
-- OR-combined-permissive-policy bug migration 0019 already fixed once, one
-- layer up. This TO clause is role-scoping ONLY -- campaigns' existing
-- NULLIF-guarded predicate (left by 0019) is untouched here; the fail-closed
-- bare-cast rewrite for all 22 tenant tables is plan 10-07's own isolated,
-- reviewed migration (SEC-03) and does not belong in this scan-role slice.
-- This TO clause cannot wait for that later plan, though: it is what keeps
-- mega_crm_scan's query plan from ever touching workspace_isolation's
-- predicate at all (verified live in RESEARCH.md Pattern 2).
ALTER POLICY workspace_isolation ON campaigns TO mega_crm_app;

-- 0018's campaign_scheduler_due_scan (GUC-gated) is deliberately NOT dropped
-- here. It stays unscoped (PUBLIC) and inert for mega_crm_scan's queries --
-- its own predicate reads `current_setting('app.admin_scan', true) = 'true'`,
-- which is NULL (not an error, `missing_ok` form) on a connection that never
-- sets that GUC, so it simply never matches and adds no visibility. Deleting
-- the app.admin_scan GUC pattern across all its call sites is plan 10-06's
-- coordinated cleanup, not a side effect of this slice.
