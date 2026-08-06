-- 09-REVIEW CR-01: seed the partition_maintenance_runs singleton so the
-- dead-man's-switch can fire even when the maintenance worker has never
-- successfully run.
--
-- `claimAlertSlot` (apps/api/src/modules/ops/partition-watchdog.ts) is a
-- single conditional `UPDATE partition_maintenance_runs ... WHERE id = 1
-- ... RETURNING`. Before this migration, `id = 1` never existed until the
-- worker's own `recordMaintenanceRun` first UPSERTed it -- so on a genuinely
-- fresh deploy (or a worker that fails on every boot before it can write
-- anything), that UPDATE matched zero rows, `claimAlertSlot` returned
-- `false`, and `checkPartitionHealthAndAlert` took its `if (!claimed)
-- return;` branch WITHOUT EVER sending. That is exactly the
-- `missing_health_row` condition `evaluatePartitionHealth` is written to
-- treat as unhealthy ("a dead-man's switch that defaults to healthy on
-- missing data is worse than no switch at all") -- the claim step defeated
-- that intent for precisely this row.
--
-- This INSERT makes `id = 1` exist unconditionally from the moment this
-- migration applies, for the life of the database -- nothing ever deletes
-- this row, and `recordMaintenanceRun`'s own UPSERT (`ON CONFLICT (id) DO
-- UPDATE`) only ever overwrites it, never removes it. `last_run_at` is
-- seeded as `epoch` (1970-01-01), which is always more than
-- STALE_THRESHOLD_HOURS (26h) in the past relative to any real "now" --
-- `evaluatePartitionHealth` reports `stale_last_run` (not
-- `missing_health_row`) for this seeded row, but the outcome the
-- dead-man's-switch actually cares about -- unhealthy, and `claimAlertSlot`
-- able to claim and send -- is unaffected by which reason fires.
-- `buffer_months_remaining` is seeded at 0 (below
-- BUFFER_ALERT_THRESHOLD_MONTHS = 2) for the same reason: belt-and-braces,
-- not load-bearing on its own.
--
-- `ON CONFLICT (id) DO NOTHING`: this migration may run against a database
-- where the worker has already recorded a real run (e.g. re-applying the
-- migration chain against a database that was provisioned, then had the
-- worker boot, before this migration itself landed) -- in that case the
-- real row must never be clobbered by the seed.
--
-- Recorded in SPECIFICATION.md §4.2/§4.4 in the same change.
INSERT INTO partition_maintenance_runs (
  id, last_run_at, lookahead_months, buffer_alert_threshold_months,
  events_buffer_months, send_events_buffer_months, buffer_months_remaining,
  events_default_count, send_events_default_count, partitions_created
) VALUES (
  1, TIMESTAMPTZ 'epoch', 0, 0, 0, 0, 0, 0, 0, '{}'
)
ON CONFLICT (id) DO NOTHING;
