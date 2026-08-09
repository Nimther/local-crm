-- Phase 11 (DLV-09/DLV-03, D-17) — additive `sends` columns for send
-- duration and reconciliation age, plus the two indexes the reconciler's
-- discovery scan and the watchdog's oldest-reconciling read depend on.
--
-- All three columns are NULLABLE with no DEFAULT and no backfill -- every
-- existing `sends` row keeps these NULL; nothing here reclassifies a
-- historical row's `status` (Pitfall 2, locked). Deliberately does NOT
-- reference the enum literals added in 0047/0048: both index definitions
-- below key on `status`/`reconciling_since` generically, not on
-- `status IN ('reconciling', 'unknown')`, so this file has no dependency on
-- whether 0047/0048 committed in the same session (0038 D-30's own
-- discipline: don't couple an unrelated file to the enum-add migrations'
-- deploy ordering any more than physically necessary).
ALTER TABLE sends ADD COLUMN reconciling_since timestamptz;
ALTER TABLE sends ADD COLUMN dispatched_at timestamptz;
ALTER TABLE sends ADD COLUMN dispatch_duration_ms integer;

COMMENT ON COLUMN sends.reconciling_since IS
  'When this send entered the ambiguous "reconciling" state (Phase 11 D-17). Deliberately a SEPARATE column from queued_at -- Phase 15''s webhook-lag alert queries this column directly, and overloading queued_at would conflate "when the job was enqueued" with "when it became ambiguous". NULL for every send that has never been ambiguous.';

COMMENT ON COLUMN sends.dispatched_at IS
  'The moment the outbound SendGrid mail/send call started (Phase 11 D-17/DLV-09) -- unit 2 of the three-unit dispatch discipline. NULL until the worker actually places the call (never set for excluded/skipped sends).';

COMMENT ON COLUMN sends.dispatch_duration_ms IS
  'Wall-clock milliseconds the SendGrid mail/send call took, measured worker-side around the same call dispatched_at timestamps (Phase 11 D-17/DLV-09). SQL-queryable send-duration metric, available before any metrics infrastructure exists. NULL until the call completes (or times out) and the terminal/ambiguous write happens.';

-- Serves the reconciler's cross-workspace discovery scan (11-03 onward): one
-- index covers both the `status IN ('reconciling', 'unknown')` predicate and
-- the stale-`dispatching` age predicate (`status = 'dispatching' AND
-- queued_at < now() - interval '...'`), since both filter on `status` first
-- and order/range on a timestamp second.
CREATE INDEX sends_status_queued_at_idx ON sends (status, queued_at);

-- Serves Phase 15's planned webhook-lag query on `reconciling_since` and the
-- Phase 11 watchdog's oldest-reconciling read (D-14). Partial: only rows
-- that have ever been ambiguous carry a non-null value here, so the index
-- stays small relative to the full `sends` table.
CREATE INDEX sends_reconciling_since_idx ON sends (reconciling_since) WHERE reconciling_since IS NOT NULL;
