-- Phase 13 (CMP-03, D-14, plan 13-05) -- dirtied_at: the incremental path's
-- late-event marker for a (workspace, day) rollup row. A TIMESTAMP, not a
-- BOOLEAN, because a boolean flag has a mark/clear race: the reconciliation
-- tick would read `true`, do its work, then unconditionally write `false`,
-- clobbering any mark that arrived in between. Storing the mark's own
-- timestamp lets the clearing statement compare against the sweep's OWN
-- start time (`dirtied_at <= sweepStartedAt`), so a mark written mid-sweep
-- survives the clear -- see analytics-reconciliation.worker.ts's
-- clearDirtyRollupDays for the consuming half of this contract.
--
-- Nullable, no backfill: a null `dirtied_at` on an existing row correctly
-- means "no late event has been observed for this day" -- inventing dirty
-- marks for historical rows would trigger a full re-reconciliation of every
-- day the table has ever held, which is not what this migration is for.
ALTER TABLE workspace_daily_rollup ADD COLUMN dirtied_at timestamptz;

COMMENT ON COLUMN workspace_daily_rollup.dirtied_at IS
  'CMP-03 (D-14): non-null means a late (non-today, UTC) event incremented this row''s count and it has not yet been re-verified by a fresh reconciliation scan. Written ONLY by incrementWorkspaceDailyRollup (packages/db/src/analytics/daily-rollup.ts); cleared ONLY by clearDirtyRollupDays (apps/worker/src/queues/analytics-reconciliation.worker.ts), and only when the mark predates the sweep''s own start time -- a mark that arrives mid-sweep must survive the clear.';

-- Partial index: the sweep's discovery query (findDirtyRollupDays) selects
-- only rows with a non-null dirtied_at, expected to be a tiny fraction of
-- the table -- indexing the whole column would waste space maintaining
-- entries for the overwhelming majority of always-null rows.
CREATE INDEX workspace_daily_rollup_dirtied_at_idx ON workspace_daily_rollup (dirtied_at)
  WHERE dirtied_at IS NOT NULL;
