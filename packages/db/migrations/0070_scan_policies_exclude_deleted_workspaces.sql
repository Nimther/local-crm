-- Phase 22 (PRG-06, SC1, D-01, plan 22-04) -- closes the discovery half of
-- D-01 in Postgres itself: three cross-workspace scan policies
-- (campaigns_scan, flows_scan, flow_runs_scan -- migrations 0041/0042) return
-- rows for a soft-deleted workspace today, so their consumers
-- (campaign-scheduler.worker.ts, flow-segment-sweep.worker.ts,
-- flow-reconciliation.worker.ts) keep finding work to enqueue for a tenant
-- that asked to be deleted.
--
-- All THREE policies move together in this one file, not just the two
-- surfaced during discovery -- flow_runs_scan is a third gap with the exact
-- same shape: left unpatched, a deleted workspace's flow_runs would keep
-- waking and advancing (current_node_id/exited_at mutating) for the entire
-- retention window, contradicting D-02's promise that a restored workspace
-- finds its flows exactly as the tenant left them. A partial patch here would
-- fix two symptoms and silently leave the third.
--
-- Each policy is dropped and re-created with its EXISTING predicate
-- preserved verbatim (copied from 0041/0042, not paraphrased), conjoined
-- with a NOT EXISTS subquery against organization that excludes any
-- workspace whose deletion timestamp is set. The deletion column is
-- organization's quoted camelCase better-auth additionalField ("deletedAt")
-- -- a snake_case deleted_at reference does not exist and fails at apply
-- time.
--
-- No privilege-granting statement of any kind is added here. mega_crm_scan
-- already holds table-level read access on organization from migration 0042
-- (its own header records "grant plainly whatever mega_crm_scan structurally
-- needs, nothing more" -- organization was already on that list), and
-- organization carries no row-level security of its own, so the NOT EXISTS
-- subquery below resolves for that role exactly as-is. The plan-time
-- assumption that a narrower, column-level privilege grant would be needed
-- here was checked against 0042 and found unnecessary -- this migration
-- ships zero privilege changes, only a predicate change.

-- destructive: superseded below by the same policy name with the added
-- soft-delete exclusion -- the existing status/timing predicate is preserved
-- verbatim, nothing that currently narrows visibility is relaxed.
DROP POLICY campaigns_scan ON campaigns;

-- campaign-scheduler.worker.ts's findDueCampaignCandidates: unchanged SQL,
-- unchanged predicate shape -- a soft-deleted workspace's own due campaign
-- simply stops being visible to the scan role, so nothing is ever enqueued
-- for it (PRG-06/SC1).
CREATE POLICY campaigns_scan ON campaigns
  FOR SELECT TO mega_crm_scan
  USING (
    status = 'scheduled' AND scheduled_at <= now()
    AND NOT EXISTS (
      SELECT 1 FROM organization o
      WHERE o.id = campaigns.workspace_id AND o."deletedAt" IS NOT NULL
    )
  );

-- destructive: superseded below by the same policy name with the added
-- soft-delete exclusion -- the existing live/segment-triggered/published
-- predicate is preserved verbatim.
DROP POLICY flows_scan ON flows;

-- flow-segment-sweep.worker.ts's findLiveSegmentTriggeredFlows: unchanged
-- SQL -- a soft-deleted workspace's live segment-triggered flow stops being
-- visible, so the segment sweep enqueues no per-flow walk for it.
CREATE POLICY flows_scan ON flows
  FOR SELECT TO mega_crm_scan
  USING (
    status = 'live' AND trigger_type = 'segment'
    AND trigger_segment_id IS NOT NULL AND live_version_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM organization o
      WHERE o.id = flows.workspace_id AND o."deletedAt" IS NOT NULL
    )
  );

-- destructive: superseded below by the same policy name with the added
-- soft-delete exclusion -- the existing waiting/due predicate is preserved
-- verbatim. This is the third gap CONTEXT.md's own discovery pass did not
-- name: flow-reconciliation.worker.ts's findDueFlowRunCandidates reads
-- through this SAME policy, and a deleted workspace's waiting run would
-- otherwise keep waking and mutating current_node_id/exited_at for the
-- entire retention window even though the 22-02 dispatch gate already blocks
-- any mail that path could produce.
DROP POLICY flow_runs_scan ON flow_runs;

-- flow-reconciliation.worker.ts's findDueFlowRunCandidates: unchanged SQL --
-- a soft-deleted workspace's due, waiting flow_run stops being visible, so
-- reconciliation neither wakes nor advances it. Proven directly by this
-- plan's own "deleted workspace's flow run does not advance" test: unchanged
-- current_node_id, exited_at and next_wake_at across a full reconciliation
-- tick, which is the D-02 freeze guarantee this predicate closes.
CREATE POLICY flow_runs_scan ON flow_runs
  FOR SELECT TO mega_crm_scan
  USING (
    status = 'waiting' AND next_wake_at <= now()
    AND NOT EXISTS (
      SELECT 1 FROM organization o
      WHERE o.id = flow_runs.workspace_id AND o."deletedAt" IS NOT NULL
    )
  );
