-- Phase 12 (WRK-05/WRK-06, D-09) -- the segment sweep's per-flow resume
-- cursor. Today's sweep (`flow-segment-sweep.worker.ts`) loads every
-- matching contact for every live segment-triggered flow into memory in one
-- unbounded transaction, on a 15-minute repeat, with no cursor and no page
-- bound -- the largest known unbounded-memory path in the worker. This
-- table lets the rewritten sweep page on `contacts.id` and commit the
-- resume cursor in the SAME transaction as that page's enrollment work, so
-- a kill between pages is exactly resumable by construction.
--
-- Unlike `partition_maintenance_runs` (0038/0040) and `send_reconciler_runs`
-- (0050) -- both deliberately NOT tenant-scoped, since they carry only
-- platform-level operational counters with no `workspace_id` column to key
-- a policy on -- this table's cursor IS tenant data: it is a resume pointer
-- into ONE tenant's own `contacts` table, scoped to one of that tenant's own
-- flows. It gets the SAME fail-closed, role-scoped RLS every other
-- tenant-scoped table in this codebase carries, not the health-row
-- exception. The bare-cast predicate (no `NULLIF`, no `missing_ok`) is the
-- form migration 0044 standardised for the whole codebase (RESEARCH.md
-- Pitfall 1/milestone pitfall notes) -- the NULLIF-guarded variant would
-- make an unscoped query against this table silently return zero rows
-- instead of raising, which is exactly the failure mode that migration's own
-- header comment calls out.
--
-- `mega_crm_scan` (the cross-workspace discovery role) is granted NOTHING
-- on this table -- discovery only ever reads `flows` (migration 0042's
-- `flows_scan` policy); the checkpoint itself is read/written exclusively
-- through ordinary tenant-scoped `withTenant`/`withTenantTransaction` calls
-- inside the per-flow walk, never through the admin-scan connection.
CREATE TABLE flow_segment_sweep_checkpoint (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  flow_id uuid NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  cursor uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT flow_segment_sweep_checkpoint_workspace_flow_unique UNIQUE (workspace_id, flow_id)
);

COMMENT ON TABLE flow_segment_sweep_checkpoint IS
  'Per-flow resume cursor for the bounded segment sweep walk (Phase 12, WRK-05/WRK-06, D-09) -- committed in the SAME transaction as that page''s enrollment work. Tenant-scoped and RLS-protected, unlike partition_maintenance_runs/send_reconciler_runs (platform-level health rows with no workspace_id).';

ALTER TABLE flow_segment_sweep_checkpoint ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_segment_sweep_checkpoint FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON flow_segment_sweep_checkpoint TO mega_crm_app
  USING (workspace_id = current_setting('app.current_workspace_id')::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id')::uuid);
