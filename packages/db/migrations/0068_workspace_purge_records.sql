-- Phase 22 (PRG-01/PRG-02/PRG-03/PRG-05, D-05/D-07/D-10, plan 22-01): the
-- workspace-purge checkpoint-plus-evidence table, and the tombstone marker
-- migration 0068 also adds to `organization`.
--
-- purge_records is the platform-level state machine driving the whole
-- report-then-destroy design: `pending` (eligible, unreported) ->
-- `reported` (census written, nothing destroyed) -> `purging` (first
-- destructive batch has started) -> `complete` (tombstone applied), with
-- `failed` reachable from a restore-refusal or any unrecoverable error.
-- `table_counts` carries the pre-destruction per-table row census -- written
-- once at report time and never overwritten afterward, so it remains D-10
-- evidence of what existed before destruction began, not a live running
-- counter.
--
-- NO ROW-LEVEL SECURITY on this table -- a deliberate choice, not an
-- oversight, on the same "role identity is the boundary" precedent as
-- `ops_alert_state`/`dead_letter_jobs`/`partition_maintenance_runs`
-- (migration 0064's own header comment). Every read and write of this table
-- comes exclusively from the platform-side purge worker running as the
-- owning application role; there is no tenant-facing surface that ever
-- queries it, so a per-row access-control policy keyed on a session GUC
-- would add a mechanism with nothing to protect against. The table carries
-- no PII -- only ids, timestamps, status, per-table row counts and an error
-- string (D-10) -- so the exposure of skipping that mechanism here is a
-- workspace id and a row count, the same exposure this codebase already
-- accepts for its other platform-ops tables.
--
-- NO FOREIGN KEY to organization(id) -- also deliberate. This row's entire
-- reason to exist is to survive the destruction of the tenant tables the
-- purge walks, and it must remain independently readable even after
-- `organization` itself is retired to an anonymized tombstone (this same
-- migration's second half, below). A foreign key here would make this
-- checkpoint a cascade target of the very table it exists to outlive.
CREATE TABLE purge_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  soft_deleted_at timestamptz NOT NULL,
  eligible_at timestamptz NOT NULL,
  reported_at timestamptz,
  first_destructive_batch_at timestamptz,
  purged_at timestamptz,
  last_progress_at timestamptz,
  status text NOT NULL DEFAULT 'pending',
  table_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  completed_tables text[] NOT NULL DEFAULT '{}',
  purge_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX purge_records_workspace_id_unique ON purge_records (workspace_id);
CREATE INDEX purge_records_status_idx ON purge_records (status);

COMMENT ON TABLE purge_records IS
  'Phase 22 (PRG-01/PRG-02/PRG-03/PRG-05, D-05/D-07/D-10): the workspace physical-purge checkpoint and durable evidence record. Five status values: pending -> reported -> purging -> complete, with failed reachable from a restore refusal or any unrecoverable error; the sole exit from failed is an operator explicitly returning the record to purging (see apps/worker/src/queues/workspace-purge.worker.ts). No per-row access-control policy on this table and no foreign key to organization -- see this migration''s own header comment for the full reasoning. table_counts is the immutable pre-destruction census, written once at report time.';

-- Phase 22 (D-09): the tombstone marker the physical purge sets on the
-- `organization` row it retires. Additive, nullable column -- no backfill,
-- every existing row simply has no value yet (never purged). The purge
-- itself is an UPDATE (name/slug scrubbed to non-identifying values, this
-- column stamped) -- the workspace row is retired this way, on purpose,
-- never by a hard delete of `organization`, because 27 tenant tables
-- cascade from it and a single delete statement would fire an unbounded,
-- uncheckpointed cascade across all of them.
ALTER TABLE organization ADD COLUMN "purgedAt" timestamptz;

COMMENT ON COLUMN organization."purgedAt" IS
  'Phase 22 (D-09): stamped by tombstoneOrganization (apps/worker/src/queues/workspace-purge.worker.ts) in the SAME UPDATE that scrubs name/slug to non-identifying values. Non-null means this workspace''s tenant data has been physically destroyed; deletedAt is left unchanged by that UPDATE (it still records when the soft-delete happened) -- this column is the separate, later fact that the physical purge completed.';
