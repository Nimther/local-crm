-- Phase 11 (DLV-03/D-14) — send_reconciler_runs: the reconciler's own
-- cross-process health signal, mirroring partition_maintenance_runs
-- (0038/0040) column-for-column in spirit: a singleton row a worker-side
-- process writes every tick, and a SEPARATE apps/api watchdog process reads
-- on its own interval -- Postgres is the ONLY state shared between the two.
-- The reconciler itself (the worker that writes this row every ~5min tick)
-- lands in a later plan of this phase (11-03 onward); this migration only
-- creates the table and seeds the dead-man's-switch row.
--
-- NO ROW LEVEL SECURITY on this table, and this is deliberate, not an
-- oversight -- same reasoning as partition_maintenance_runs (0038's own
-- header comment): it carries no `workspace_id` and no tenant data
-- whatsoever, only platform-level operational counters (how many candidate
-- rows this tick scanned/resolved, the oldest still-reconciling timestamp
-- seen, alert dedup bookkeeping). Do NOT "fix" this by adding ENABLE/FORCE
-- ROW LEVEL SECURITY + a workspace_isolation policy the way every
-- tenant-scoped table in this codebase gets -- there is no workspace_id
-- column for such a policy to key on. `mega_crm_scan` is granted NOTHING on
-- this table (T-11-02-04): the reconciler's own per-tenant work already goes
-- through withTenant/withTenantTransaction against `sends`, and this health
-- row is written/read by the reconciler/watchdog processes' ordinary
-- app-role connections, not through the cross-workspace scan role.
CREATE TABLE send_reconciler_runs (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_run_at timestamptz NOT NULL,
  candidates_scanned integer NOT NULL DEFAULT 0,
  rows_resolved integer NOT NULL DEFAULT 0,
  rows_marked_unknown integer NOT NULL DEFAULT 0,
  stale_dispatching_swept integer NOT NULL DEFAULT 0,
  oldest_reconciling_since timestamptz,
  last_alert_sent_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE send_reconciler_runs IS
  'Platform-level operational metadata -- NOT tenant data, deliberately has NO workspace_id and NO Row-Level Security. See this migration''s header comment before adding RLS here. Mirrors partition_maintenance_runs (0038).';

-- Dead-man's-switch seed (mirrors 0040's partition_maintenance_runs seed and
-- its exact rationale): without this row existing unconditionally from the
-- moment this migration applies, the reconciler's own future watchdog claim
-- step (an `UPDATE ... WHERE id = 1 ... RETURNING`) would match zero rows on
-- a fresh deploy or a reconciler that fails on every boot before it can
-- write anything -- exactly the "dead-man's switch that defaults to healthy
-- on missing data" failure 0040's own comment names. `last_run_at` seeded at
-- epoch (1970-01-01) is always staler than any real alert threshold, so the
-- watchdog reports unhealthy (not "missing_health_row") from the first check
-- onward. `ON CONFLICT (id) DO NOTHING`: this migration may run against a
-- database where the reconciler has already recorded a real run (e.g.
-- re-applying the chain after the worker booted before this migration
-- landed) -- the real row must never be clobbered by the seed.
INSERT INTO send_reconciler_runs (id, last_run_at)
VALUES (1, TIMESTAMPTZ 'epoch')
ON CONFLICT (id) DO NOTHING;
