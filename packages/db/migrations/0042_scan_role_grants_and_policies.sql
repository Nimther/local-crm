-- Phase 10 (SEC-01/SEC-02, D-01/D-02/D-03) — extends the scan role from the
-- tracer's single table (0041: campaigns only) to every table the phase's
-- three remaining worker-level scan consumers actually read: flow_runs,
-- flows, contacts, sends, organization.
--
-- Grants (SELECT only -- the scan role never writes, mirroring 0041's
-- `campaigns` grant exactly): no INSERT/UPDATE/DELETE, no sequence usage, no
-- other table than the five listed below.
GRANT SELECT ON flow_runs, flows, contacts, sends, organization TO mega_crm_scan;

-- Role-scoped, GUC-free scan policies (D-03), each carrying the narrowing
-- predicate its consumer's own WHERE clause implies -- RESEARCH.md Pitfall 3:
-- role-scoping and predicate-narrowing are complementary, not substitutes for
-- each other. Two of the four legacy scan policies this migration's
-- consumers previously relied on (0027's `flow_runs_due_scan`, 0032's
-- `flows_segment_sweep_scan`) carry NO predicate beyond the marker GUC check
-- -- simply re-scoping them by role, unchanged, would hand mega_crm_scan
-- every row in flow_runs/flows unconditionally. These two policies restore
-- (for the first time) the row-limiting intent 0027/0032 never implemented.

-- flow-reconciliation.worker.ts's findDueFlowRunCandidates: only a `waiting`
-- flow_run whose wake time has passed is visible to the scan role. A
-- `completed` run, or a `waiting` run whose wake time is still in the
-- future, is NOT visible -- even though flow-reconciliation's per-tenant
-- re-verification step (transitionAndNudge) would also exclude a paused
-- flow's run, the discovery scan itself must not hand the scan role rows it
-- has no legitimate reason to read.
CREATE POLICY flow_runs_scan ON flow_runs
  FOR SELECT TO mega_crm_scan
  USING (status = 'waiting' AND next_wake_at <= now());

-- flow-segment-sweep.worker.ts's findLiveSegmentTriggeredFlows: only a
-- `live`, segment-triggered flow with both a trigger segment and a
-- published live version set is visible. A `paused` flow, an event-triggered
-- flow, or a live segment-triggered flow with no live_version_id yet is NOT
-- visible.
CREATE POLICY flows_scan ON flows
  FOR SELECT TO mega_crm_scan
  USING (
    status = 'live' AND trigger_type = 'segment'
    AND trigger_segment_id IS NOT NULL AND live_version_id IS NOT NULL
  );

-- contacts_scan / sends_scan: deliberately UNRESTRICTED-ROW SELECT policies
-- -- unlike flow_runs_scan/flows_scan above, there is no narrowing predicate
-- available here, and that is a considered choice (RESEARCH.md Assumption
-- A3), not an oversight:
--
--   - contacts: the partition-relocation path (0039's
--     partition_relocation_admin_scan, plan 10-06's subject) cannot predict
--     in advance which contact rows a given DEFAULT-partition backlog will
--     reference before it reads them -- there is no WHERE clause to mirror.
--   - sends: plan 10-08's sibling-workspace webhook resolution cannot
--     predict in advance which send_id a delivery event will name -- same
--     reasoning.
--
-- Both readers select id/workspace_id columns only; that column restriction
-- is enforced in APPLICATION code (the two readers' own SQL) and asserted by
-- plan 10-08's payload-free test, not by this policy -- Postgres RLS has no
-- column-level granularity, only row-level. This is accepted, bounded risk:
-- SELECT-only grants, exactly two known readers, medium severity, tracked as
-- threat T-10-03-02 (disposition: accept).
CREATE POLICY contacts_scan ON contacts
  FOR SELECT TO mega_crm_scan
  USING (true);

CREATE POLICY sends_scan ON sends
  FOR SELECT TO mega_crm_scan
  USING (true);

-- `organization` carries no RLS at all (never had ENABLE ROW LEVEL SECURITY
-- run against it -- it is the top-level tenant identity table, not a
-- tenant-scoped one), so it needs only the GRANT SELECT above and no policy
-- of any kind. analytics-reconciliation.worker.ts's workspace enumeration
-- (`SELECT id FROM organization`) is the sole scan-role reader.

-- Role-scope the corresponding app policies so they are excluded from the
-- scan role's query plans (RESEARCH.md Pitfall 2, same reasoning as 0041's
-- `campaigns` precedent): an unscoped (PUBLIC) `workspace_isolation` policy
-- is combined via OR with EVERY other permissive policy applicable to a
-- query's role -- including a scan-role policy above, once mega_crm_scan
-- exists. Without this explicit TO clause, a mega_crm_scan query against one
-- of these four tables would ALSO have to satisfy (or error on)
-- workspace_isolation's own predicate, reintroducing the exact
-- OR-combined-permissive-policy bug migration 0019 already fixed once, one
-- layer up.
--
-- These are role-scope-ONLY statements: no predicate is restated or altered.
-- Predicate unification for all 22 tenant tables (the fail-closed bare-cast
-- rewrite, SEC-03) is plan 10-07's own isolated, reviewed migration and does
-- not belong in this scan-role slice.
ALTER POLICY workspace_isolation ON flow_runs TO mega_crm_app;
ALTER POLICY workspace_isolation ON flows TO mega_crm_app;
ALTER POLICY workspace_isolation ON contacts TO mega_crm_app;
ALTER POLICY workspace_isolation ON sends TO mega_crm_app;

-- The four legacy marker-GUC policies this migration's consumers are moving
-- off of (0027's flow_runs_due_scan, 0032's flows_segment_sweep_scan, and
-- 0039's two partition_relocation_admin_scan policies on contacts/sends) are
-- deliberately NOT dropped here. They stay unscoped (PUBLIC) and inert for
-- mega_crm_scan's queries -- their own predicates read
-- `current_setting('app.admin_scan', true) = 'true'`, which is NULL (not an
-- error, the missing_ok form) on the scan pool's connection, which never
-- sets that GUC, so they simply never match and add no visibility. Plan
-- 10-06 owns dropping the app.admin_scan GUC pattern across all its call
-- sites, after its own checkpoint resolves the partition path -- not a side
-- effect of this slice.
