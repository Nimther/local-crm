-- Phase 13 (CMP-09, D-09 through D-12) -- reputation_alert_state: the
-- per-workspace-per-metric home for each tenant's spam-complaint-rate and
-- hard-bounce-rate observations, computed on a rolling window by the
-- reputation tick worker (apps/worker/src/queues/reputation-tick.worker.ts,
-- this same plan). Also creates ingestion_alert_state, the singleton
-- dead-man's-switch row plan 13-11's ingestion-health watchdog needs --
-- created here rather than in that plan because this wave owns the phase's
-- single migration slot and 13-11 consumes it one wave later.
--
-- reputation_alert_state is KEYED, not singleton -- this is the one thing
-- this migration must not get wrong. `dead_letter_alert_state` (0054),
-- `partition_maintenance_runs` (0038/0040) and `send_reconciler_runs` (0050)
-- are all singletons because their concerns are platform-wide (one dead-man's
-- switch for the whole platform). A tenant's spam-complaint rate is
-- inherently per-tenant: a singleton row here would make every tenant's
-- observation and every tenant's alert collide on the same row, silently
-- reporting one workspace's reputation as every workspace's. 13-RESEARCH.md
-- Pitfall 5 names this exact mistake -- copying an existing watchdog's
-- singleton shape verbatim -- as the one to avoid.
--
-- Observed and alerted state are split into disjoint column sets, and this
-- is the second thing this migration must not get wrong. This plan's
-- reputation tick writes ONLY the `observed_*` columns, once per workspace
-- per metric per tick. Plan 13-11's watchdog claim writes ONLY `alerted_tier`
-- and `last_alert_sent_at`. Two writers, disjoint columns: recording a fresh
-- observation can never look like an alert having been sent, and claiming an
-- alert can never overwrite the measurement it was based on.
--
-- RLS: neither table gets a tenant `workspace_isolation` policy, and neither
-- gets ENABLE/FORCE ROW LEVEL SECURITY at all. Both are read and written
-- exclusively by platform-side jobs (the reputation tick worker, running
-- inside each workspace's own `withTenant` scope purely to compute the
-- per-workspace counts it needs -- not to gate access to these two tables;
-- and plan 13-11's watchdog, running on the platform pool) -- never by a
-- tenant-facing surface. This is the same "role identity is the boundary"
-- precedent `organization` (no RLS at all) and `dead_letter_jobs` (platform-
-- operations metadata, no RLS) already set. If a future phase adds a
-- tenant-facing read of `reputation_alert_state` (the tenant-facing
-- reputation dashboard is deferred to Phase 15), THAT phase must add an
-- ordinary `workspace_isolation` policy scoped to the reader's own
-- `workspace_id` at that time -- this migration deliberately does not
-- pre-emptively add one for a reader that does not yet exist.
--
-- Scan-role grants: migration 0042's `mega_crm_scan` grant list covers only
-- the tables its known cross-tenant readers actually query
-- (flow_runs/flows/contacts/sends/organization). The reputation tick's own
-- cross-workspace step (`withCrossWorkspaceScan`) only enumerates
-- `organization` -- already granted -- and never reads or writes either
-- table created here directly; the per-workspace observation write happens
-- inside that workspace's own `withTenant` transaction, on the ordinary
-- `mega_crm_app` role, which owns both new tables by virtue of creating them
-- (migrations apply as `mega_crm_app`, same as every other table in this
-- file). No new grant to `mega_crm_scan` is required.
CREATE TABLE reputation_alert_state (
  workspace_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  metric text NOT NULL,
  -- Written ONLY by the reputation tick (this plan). A rate at or above a
  -- metric's warn/critical threshold constant in
  -- packages/delivery-core/src/reputation-rates.ts tiers into that column's
  -- comparison inclusivity ("a rate at or above this value is warn/critical" --
  -- see that module's own constant comments), never a strict ">".
  observed_tier text,
  observed_rate numeric,
  observed_numerator integer,
  observed_denominator integer,
  observed_at timestamptz,
  -- Written ONLY by plan 13-11's watchdog claim. Untouched by this plan's
  -- tick -- see header comment on the observed/alerted column split.
  alerted_tier text,
  last_alert_sent_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, metric)
);

COMMENT ON TABLE reputation_alert_state IS
  'Per-workspace, per-metric reputation observation and alert state (CMP-09). KEYED by (workspace_id, metric), never a singleton -- a tenant''s complaint/bounce rate is inherently per-tenant, and a singleton row here would collide every tenant''s alerts onto one row (13-RESEARCH.md Pitfall 5). observed_* columns are written only by the reputation tick worker; alerted_tier and last_alert_sent_at are written only by the plan 13-11 watchdog claim -- disjoint column sets so neither writer can clobber the other''s signal. No Row-Level Security: read/written exclusively by platform-side jobs, never a tenant-facing surface, matching the organization/dead_letter_jobs "role identity is the boundary" precedent. A future tenant-facing read (the reputation dashboard, deferred to Phase 15) must add a workspace-scoped workspace_isolation policy at that time.';

-- ingestion_alert_state -- copies dead_letter_alert_state's (0054) singleton
-- shape column-for-column, because the ingestion-health check is a
-- dead-man's switch: an empty table would make "no alert has ever been
-- claimed" indistinguishable from "the checker never ran".
CREATE TABLE ingestion_alert_state (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_alert_sent_at timestamptz,
  last_seen_stuck_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE ingestion_alert_state IS
  'Platform-operations metadata -- NOT tenant data, deliberately has NO workspace_id and NO Row-Level Security. Singleton alert-dedup row (id=1 only) for plan 13-11''s ingestion-health watchdog, mirroring dead_letter_alert_state (0054), partition_maintenance_runs (0038/0040) and send_reconciler_runs (0050). Created in this migration (this wave''s single migration slot) rather than in 13-11''s own migration, one wave later.';

-- Dead-man's-switch seed (mirrors 0054's dead_letter_alert_state seed, same
-- exact rationale): without this row existing unconditionally from the
-- moment this migration applies, plan 13-11's future atomic claim step (an
-- `UPDATE ... WHERE id = 1 ... RETURNING`) would match zero rows on a fresh
-- deploy, and "a dead-man's switch that defaults to healthy on missing data"
-- is worse than no switch at all. `ON CONFLICT (id) DO NOTHING`: this
-- migration may run against a database where the watchdog has already
-- recorded real alert-state -- that real row must never be clobbered by the
-- seed.
INSERT INTO ingestion_alert_state (id, last_alert_sent_at, last_seen_stuck_at)
VALUES (1, NULL, NULL)
ON CONFLICT (id) DO NOTHING;
