-- Phase 11 code review (WR-01) -- `sends_reconciling_since_idx` (0049) is a
-- PARTIAL index keyed on `reconciling_since IS NOT NULL`, but that migration's
-- own comment also claims it backs the reconciler watchdog's oldest-
-- reconciling read (D-14):
--
--   SELECT MIN(reconciling_since) AS "oldestReconcilingSince" FROM sends
--   WHERE status = 'reconciling'
--
-- That query filters on `status`, a DIFFERENT column than the index's own
-- predicate, and the planner cannot statically prove `status = 'reconciling'`
-- implies `reconciling_since IS NOT NULL` -- there is no CHECK constraint
-- tying the two columns together. Postgres cannot use `sends_reconciling_since_idx`
-- for this query; it falls back to a scan filtered by `status` (e.g. via
-- `sends_status_queued_at_idx`), reading `reconciling_since` from the heap for
-- every matching row.
--
-- This does NOT edit or drop 0049's index -- it may already be applied in
-- real environments, and its own predicate is deliberately reused by Phase
-- 15's not-yet-built webhook-lag query (grep confirms no OTHER current query
-- in this repo filters or orders on `reconciling_since` alone today). Instead
-- this adds a NEW partial index whose predicate matches the watchdog read's
-- actual `WHERE` clause exactly.
CREATE INDEX sends_reconciling_status_idx ON sends (reconciling_since) WHERE status = 'reconciling';

COMMENT ON INDEX sends_reconciling_status_idx IS
  'Backs send-reconciler.worker.ts''s oldest-reconciling MIN(reconciling_since) read (Phase 11 D-14) -- WHERE status = ''reconciling'' matches this index''s own predicate exactly, unlike 0049''s sends_reconciling_since_idx (WHERE reconciling_since IS NOT NULL), which the planner cannot use for this query (Phase 11 code review WR-01).';
