-- Phase 12 (WRK-09/WRK-10, D-07) -- dead_letter_jobs: the durable Postgres
-- home for a job that has exhausted every configured BullMQ attempt, plus
-- dead_letter_alert_state, the watchdog's own dead-man's-switch dedup row.
--
-- D-07's full reasoning (12-CONTEXT.md): for send jobs `sends` already IS the
-- terminal truth (Phase 11) -- this table's chief value is the lanes that
-- have no ledger at all (ingest, webhooks, CSV import, flow ticks), where a
-- job that silently ages out of BullMQ's Redis failed set today is lost data
-- with no record anywhere. Once every worker attaches the shared listener
-- (WRK-08, packages/queue-core/src/error-listeners.ts, this same plan) and
-- that listener writes here on terminal failure, Redis failed-set retention
-- (WRK-09/WRK-11) can be shortened freely per queue without losing history --
-- this table is what makes shortening retention safe, so it must exist and be
-- wired everywhere BEFORE any queue's `removeOnFail` is shortened (Pitfall 7's
-- causal ordering; the queue-core retention change lands in a later plan of
-- this same phase, 12-09, which depends on this one).
--
-- dead_letter_jobs is PLATFORM-OPERATIONS scoped, not tenant scoped -- same
-- reasoning as partition_maintenance_runs (0038/0040) and send_reconciler_runs
-- (0050), NOT the same reasoning as flow_segment_sweep_checkpoint (0053, which
-- IS tenant data and gets ordinary RLS): a dead-letter row is an operator's
-- own diagnostic record of a job that failed to complete, not a tenant's
-- business data -- there is deliberately no `workspace_id` column here for a
-- workspace_isolation policy to key on, and this table gets neither ENABLE
-- nor FORCE ROW LEVEL SECURITY. If tenant-scoped visibility into dead-letter
-- rows is ever wanted (e.g. a per-tenant "your ingest events that failed"
-- view), the correct fix is an ADDITIVE `workspace_id` column plus an
-- ordinary `workspace_isolation` policy scoped `TO mega_crm_app` -- never a
-- policy keyed on nothing, and never retrofitting RLS onto this platform-wide
-- shape. `mega_crm_scan` (the cross-workspace discovery role) is granted
-- NOTHING on either table below -- there is no cross-tenant discovery query
-- against either of them, only ordinary `mega_crm_app`-role reads/writes from
-- the worker's dead-letter writer and the apps/api watchdog (D-08).
CREATE TABLE dead_letter_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_name text NOT NULL,
  job_id text NOT NULL,
  job_name text NOT NULL,
  attempts_made integer NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  error_message text NOT NULL,
  error_stack text,
  failed_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  CONSTRAINT dead_letter_jobs_queue_job_unique UNIQUE (queue_name, job_id)
);

COMMENT ON TABLE dead_letter_jobs IS
  'Platform-operations metadata -- NOT tenant data, deliberately has NO workspace_id and NO Row-Level Security. See this migration''s header comment before adding RLS here; the correct remedy for tenant-scoped visibility is an additive workspace_id column plus an ordinary workspace_isolation policy, never a policy keyed on nothing.';

-- Backs the watchdog's own oldest-unacknowledged read (D-08, apps/api's
-- future dead-letter-watchdog.ts, mirroring partition-watchdog.ts's and
-- send-reconciler-watchdog.ts's own "how stale is the oldest outstanding
-- thing" query shape).
CREATE INDEX dead_letter_jobs_failed_at_idx ON dead_letter_jobs (failed_at);

-- dead_letter_alert_state -- the singleton alert-dedup row, modelled
-- column-for-column on send_reconciler_runs' (0050) own alert bookkeeping
-- half. Kept as its OWN table rather than folded into dead_letter_jobs: the
-- alert-dedup state is a single platform-wide row about the watchdog's own
-- behaviour (when did it last alert, what was the newest failure it had seen
-- at that time), not a per-job row, and a singleton alert row living inside a
-- per-job table would need its own sentinel id anyway -- a dedicated table
-- makes that sentinel explicit rather than incidental.
CREATE TABLE dead_letter_alert_state (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_alert_sent_at timestamptz,
  last_seen_failed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE dead_letter_alert_state IS
  'Platform-operations metadata -- NOT tenant data, deliberately has NO workspace_id and NO Row-Level Security. Singleton alert-dedup row for the dead-letter watchdog (D-08), mirroring partition_maintenance_runs (0038/0040) and send_reconciler_runs (0050).';

-- Dead-man's-switch seed (mirrors 0040's partition_maintenance_runs seed and
-- send_reconciler_runs' own 0050 seed, same exact rationale): without this
-- row existing unconditionally from the moment this migration applies, the
-- watchdog's future atomic claim step (an `UPDATE ... WHERE id = 1 ...
-- RETURNING`) would match zero rows on a fresh deploy, and
-- "a dead-man's switch that defaults to healthy on missing data" is worse
-- than no switch at all. `ON CONFLICT (id) DO NOTHING`: this migration may
-- run against a database where the watchdog has already recorded real
-- alert-state -- that real row must never be clobbered by the seed.
INSERT INTO dead_letter_alert_state (id, last_alert_sent_at, last_seen_failed_at)
VALUES (1, NULL, NULL)
ON CONFLICT (id) DO NOTHING;
