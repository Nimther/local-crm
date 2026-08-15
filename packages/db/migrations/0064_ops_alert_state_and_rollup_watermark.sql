-- Phase 15 (OPS-13, OPS-18, plan 15-12): this wave's single migration slot,
-- carrying two unrelated-but-both-schema-provisioning halves for two LATER
-- plans in this same phase (15-13, 15-14) -- the same "this wave owns the
-- phase's one migration slot" convention 0038/0054/0058 already established.
--
-- HALF 1 -- ops_alert_state (OPS-13): the shared alert-dedup primitive the
-- four new OPS-13 watchdogs (queue depth, oldest job age, webhook lag,
-- failed-send share) will all claim against, one table instead of four new
-- singleton tables.
--
-- KEYED by alert name, NOT a singleton -- this is the one thing this table
-- must not get wrong. `dead_letter_alert_state` (0054), `ingestion_alert_state`
-- (0058), `partition_maintenance_runs` (0038/0040) and `send_reconciler_runs`
-- (0050) are all singletons because each is ONE platform-wide dead-man's
-- switch. Here there are FOUR independent alerts sharing this table -- a
-- singleton `id = 1 CHECK` shape would make claiming one alert's slot also
-- claim (and therefore suppress) the other three's dedup windows, exactly
-- the mistake this migration's own review guards against (15-RESEARCH.md
-- Open Question 2, resolved: a single `ops_alert_state(alert_name text
-- primary key, last_alert_sent_at timestamptz)` table, lower migration
-- overhead than four dedicated tables, same atomic-claim SQL shape as every
-- prior watchdog). Seeds NO rows -- `claimOpsAlertSlot` (packages/db/src/ops/
-- alert-state.ts, plan 15-12 Task 2) upserts a row on first claim for a
-- name, so an unseeded table is not a dead-man's-switch gap here the way an
-- unseeded SINGLETON table would be (there is no "the alert has never
-- fired" state this table needs to distinguish from "never provisioned" --
-- an absent row for a given name means exactly "never claimed", which the
-- upsert handles correctly on its own).
--
-- NO Row-Level Security -- deliberate, matching `dead_letter_alert_state`/
-- `ingestion_alert_state`/`partition_maintenance_runs`/`send_reconciler_runs`:
-- this is platform-operations metadata, never tenant data, read and written
-- exclusively by platform-side watchdog ticks running in `apps/api`, never
-- by any tenant-facing surface. No `workspace_id` column exists for a
-- `workspace_isolation` policy to key on, and none of the four OPS-13 alerts
-- this table backs are per-tenant concerns (unlike `reputation_alert_state`,
-- 0058, which IS per-tenant and therefore IS keyed by `workspace_id`).
CREATE TABLE ops_alert_state (
  alert_name text PRIMARY KEY,
  last_alert_sent_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE ops_alert_state IS
  'Phase 15 (OPS-13): shared alert-dedup primitive for the four new in-app watchdogs (queue depth, oldest job age, webhook lag, failed-send share). KEYED by alert_name, never a singleton -- four alerts sharing one row would make each alert''s dedup window suppress the other three (see this migration''s own header comment). No Row-Level Security: platform-operations metadata, never tenant data, read/written only by platform-side watchdog ticks in apps/api, matching dead_letter_alert_state/ingestion_alert_state/partition_maintenance_runs/send_reconciler_runs. packages/db/src/ops/alert-state.ts (plan 15-12 Task 2) is the sole read/write path -- claimOpsAlertSlot upserts on first claim for a name, so this table is deliberately never seeded by this migration.';

-- HALF 2 -- workspace_daily_rollup watermark (OPS-18, D-12): D-12 assumes
-- analytics views can show "Data as of HH:MM" from "the rollup watermark
-- the API already knows" -- it does not exist. `workspace_daily_rollup`
-- (0037, dirtied_at added 0056) has no column recording when a row was last
-- written, so there is nothing today for an honest freshness timestamp to
-- read. This column is that watermark.
--
-- Additive, NOT NULL with a `now()` DEFAULT -- every existing row gets a
-- value with no separate backfill UPDATE statement and no rewrite of
-- existing rows' history (this migration's own prohibition: no backfill of
-- `workspace_daily_rollup`). An existing row's watermark defaulting to "the
-- moment this migration ran" is the correct, honest value for a row this
-- migration has no other information about -- it is not a claim that the
-- row was freshly written at that moment, only that nothing older is known.
--
-- Every write path that touches a `workspace_daily_rollup` row MUST set
-- this column going forward (plan 15-12 Task 3): the incremental upsert
-- (`incrementWorkspaceDailyRollup`, packages/db/src/analytics/daily-rollup.ts)
-- and the reconciliation overwrite (`reconcileWorkspaceDay`,
-- apps/worker/src/queues/analytics-reconciliation.worker.ts). Missing
-- either write path would make the watermark lie in exactly the case that
-- matters most -- a day the reconciler just re-verified would keep a stale
-- watermark, understating how fresh the number actually is.
ALTER TABLE workspace_daily_rollup
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

COMMENT ON COLUMN workspace_daily_rollup.updated_at IS
  'Phase 15 (OPS-18, D-12): the freshness watermark every write path (incrementWorkspaceDailyRollup, reconcileWorkspaceDay) must set to now() on every write. Backs the dashboard''s "data as of" timestamp (apps/api/src/modules/analytics/dashboard.repository.ts) -- the newest value of this column among a workspace''s rows in the requested window. Additive column, NOT NULL DEFAULT now() -- no backfill UPDATE, no rewrite of existing rows.';
