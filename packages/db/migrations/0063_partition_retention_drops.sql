-- Phase 14 (DB-11, D-08, plan 14-12): closes DB-11's "retention data is
-- DEFINED and APPLIED" requirement's own recording half -- T-14-79
-- (Repudiation) requires "what did retention remove and when" to be
-- answerable from the database, not from logs that have rotated.
--
-- HAND-WRITTEN (not drizzle-kit generate output), following migration
-- 0038/0054's own precedent for platform-operations tables: this migration
-- both ADDs COLUMNs to an existing table and CREATEs a new one in one file,
-- same shape those two migrations already established for this exact class
-- of change (a partition-maintenance-adjacent operational table, no
-- workspace_id, no RLS).
--
-- DEVIATION FROM THE PLAN'S OWN FILE LIST (recorded here and in
-- 14-12-SUMMARY.md): 14-12-PLAN.md's `files_modified` names no migration --
-- an authoring gap, not an instruction to skip persistence. The plan's own
-- threat register (T-14-79) and Task 2's acceptance criteria ("a drop
-- record exists naming the partition, its range and the horizon") both
-- require durable, queryable state; a log line alone cannot satisfy
-- "answerable from the database". Rule 2 (auto-add missing critical
-- functionality) applies, with the exact precedent 14-05's own deviation
-- log already set (creating check-empty-diff.ts under the same rule for
-- the same reason: "the threat model's own mitigation required it but the
-- file list omitted it").
--
-- TWO HALVES, ONE MIGRATION, because the requirement itself has two halves:
--
--   1. partition_maintenance_runs gains `retention_status` (disabled | ok |
--      failed) and `retention_error` (populated only alongside "failed").
--      This is the RUN record -- "did the most recent tick's retention step
--      succeed" (Task 2's own acceptance criterion: "the run record
--      distinguishes disabled from failed"). The singleton row this table
--      already is (`id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1)`,
--      migration 0038) is upserted every tick, so it can only ever describe
--      the MOST RECENT run -- it cannot answer "what did retention remove
--      LAST MONTH" once a later tick has overwritten it.
--   2. partition_retention_drops is the append-only HISTORY that singleton
--      row cannot hold -- one row per partition ever dropped, written by
--      `dropExpiredPartitions` (packages/db/src/partitions/retention.ts).
--      This is the durable answer to "what did retention remove and when".
--
--   Also mirrors `partitions_created` (already on partition_maintenance_runs)
--   with a same-shaped `partitions_dropped text[]` column -- the fast
--   "what did the MOST RECENT run drop" answer without a join, exactly as
--   `partitions_created` already is for creation.
--
-- NO ROW LEVEL SECURITY on partition_retention_drops, and this is
-- deliberate, not an oversight -- same reasoning as
-- partition_maintenance_runs (0038)/dead_letter_jobs (0054): it carries no
-- `workspace_id` and no tenant data whatsoever, only platform-level
-- operational metadata (partition names, ranges, the horizon that made a
-- given drop eligible). Do NOT "fix" this by adding ENABLE/FORCE ROW LEVEL
-- SECURITY + a workspace_isolation policy -- there is no workspace_id
-- column for such a policy to key on.

ALTER TABLE partition_maintenance_runs
  ADD COLUMN retention_status text NOT NULL DEFAULT 'disabled',
  ADD COLUMN retention_error text,
  ADD COLUMN partitions_dropped text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN partition_maintenance_runs.retention_status IS
  'DB-11 (Phase 14, D-08): disabled | ok | failed for the MOST RECENT tick''s retention step. "disabled" is what every run writes while the retention enable flag is unset -- the only value any committed deploy of this codebase can reach.';

CREATE TABLE partition_retention_drops (
  id bigserial PRIMARY KEY,
  parent_table text NOT NULL,
  partition_name text NOT NULL,
  range_start timestamptz NOT NULL,
  range_end timestamptz NOT NULL,
  horizon_months integer NOT NULL,
  dropped_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE partition_retention_drops IS
  'Platform-level operational metadata -- NOT tenant data, deliberately has NO workspace_id and NO Row-Level Security. Append-only history of every partition the DB-11 retention tick has ever dropped (packages/db/src/partitions/retention.ts''s dropExpiredPartitions). See this migration''s own header comment before adding RLS here.';

-- Backs "what did retention drop, ordered by when" -- the operator-facing
-- read this table exists to answer (docs/runbooks/data-retention.md).
CREATE INDEX partition_retention_drops_dropped_at_idx ON partition_retention_drops (dropped_at);
