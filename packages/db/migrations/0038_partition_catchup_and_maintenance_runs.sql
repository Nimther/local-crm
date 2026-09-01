-- Partition catch-up + maintenance-run health table (DB-01/DB-02, D-05/D-06).
--
-- HAND-WRITTEN (not drizzle-kit generate output): Postgres declarative
-- partitioning -- `CREATE TABLE ... PARTITION OF ...` -- has no expression in
-- Drizzle's pgTable API (same precedent as 0007_events_partitioned.sql,
-- 0010_events_workspace_scoped_pk.sql, 0020_send_events_partitioned.sql). No
-- packages/db/src/schema/*.ts file accompanies the partition half of this
-- migration -- the partitions are physical children of the existing `events`
-- and `send_events` tables, whose logical column shape is already declared
-- for type inference in schema/events.ts and schema/send-events.ts. No
-- drizzle-kit meta snapshot accompanies this file either.
--
-- HALF 1 -- catch-up partitions (D-06): `events` and `send_events` have
-- monthly partitions only through 2026_08 (0007/0020); from 2026-09-01 every
-- new row would route into the DEFAULT partition, and PostgreSQL's own
-- documented behaviour then makes every subsequent ATTACH PARTITION pay a
-- full scan of DEFAULT under an ACCESS EXCLUSIVE lock (Pitfall 13) -- an
-- ingestion outage on the live events table. This migration creates
-- partitions for both tables from 2026-09 through 2027-06 INCLUSIVE (10
-- months per table, 20 CREATE TABLE statements total), deliberately
-- overshooting D-11's +3-month steady state so the deadline-closing artifact
-- carries slack independent of the exact date this migration is deployed and
-- of when `ensurePartitions`'s first tick actually runs (RESEARCH.md Open
-- Question 2). Bounds are written as explicit UTC-offset timestamps (e.g.
-- '2026-09-01 00:00:00+00') so the stored bound never depends on the
-- session TimeZone in effect when this file is applied -- the same discipline
-- `ensure-partitions.ts`'s own DDL-bound formatting follows at runtime (T-09-01).
-- No RLS statement is added for these partitions: 0007/0020 already put
-- ENABLE/FORCE ROW LEVEL SECURITY and the `workspace_isolation` policy on the
-- PARENT tables, and Postgres propagates a parent's RLS policies to every
-- child partition automatically -- adding it again here would be redundant,
-- not incremental.
--
-- 09-REVIEW WR-01: the 20 `CREATE TABLE ... PARTITION OF` statements below
-- are plain DDL, NOT the CHECK-constraint-first sequence
-- `attachPartitionCheckFirst` (packages/db/src/partitions/ensure-partitions.ts)
-- uses for every other attach in this codebase -- CONVENTIONS.md's
-- "Partition maintenance" section names this migration as the ONE
-- sanctioned exception to "that sequence exists in exactly one function",
-- precisely so it is not duplicated here. That makes this migration safe
-- ONLY while `events_default`/`send_events_default` are still genuinely
-- empty. Before 2026-09-01 that was guaranteed by the rollout schedule; on
-- or after the boundary a slipped deploy, a CI backlog, or a
-- rollback-and-retry means DEFAULT may already hold real rows, and
-- these 20 plain `CREATE TABLE ... PARTITION OF` statements would each pay
-- the exact "ACCESS EXCLUSIVE scan of DEFAULT" ingestion-outage cost this
-- phase exists to avoid -- silently, twenty times, in one migration run.
-- Rather than duplicate the CHECK-constraint-first sequence here (which
-- CONVENTIONS.md's rule above forbids), a post-deadline run first takes both
-- DEFAULT relations ACCESS EXCLUSIVE NOWAIT: concurrent ingestion makes the
-- migration fail closed rather than wait, and the locks keep the following
-- emptiness check stable for the rest of this file's implicit transaction.
-- A non-empty DEFAULT still raises loudly; a demonstrably empty fresh
-- database can continue, which keeps ephemeral CI/bootstrap chains usable
-- after the calendar boundary without weakening the production data guard.
DO $$
BEGIN
  IF now() >= TIMESTAMPTZ '2026-09-01 00:00:00+00' THEN
    LOCK TABLE events_default, send_events_default IN ACCESS EXCLUSIVE MODE NOWAIT;

    IF EXISTS (SELECT 1 FROM events_default LIMIT 1)
       OR EXISTS (SELECT 1 FROM send_events_default LIMIT 1) THEN
      RAISE EXCEPTION 'migration 0038 (partition catch-up) refuses to apply on/after 2026-09-01 while events_default or send_events_default contains rows: its 20 CREATE TABLE ... PARTITION OF statements are plain DDL (not CHECK-constraint-first). Relocate all DEFAULT rows first with npm run relocate:default-partition-rows, then apply this migration only after the operational risk has been reviewed -- do not simply retry it.';
    END IF;
  END IF;
END $$;

CREATE TABLE events_2026_09 PARTITION OF events
  FOR VALUES FROM ('2026-09-01 00:00:00+00') TO ('2026-10-01 00:00:00+00');
CREATE TABLE events_2026_10 PARTITION OF events
  FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');
CREATE TABLE events_2026_11 PARTITION OF events
  FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');
CREATE TABLE events_2026_12 PARTITION OF events
  FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');
CREATE TABLE events_2027_01 PARTITION OF events
  FOR VALUES FROM ('2027-01-01 00:00:00+00') TO ('2027-02-01 00:00:00+00');
CREATE TABLE events_2027_02 PARTITION OF events
  FOR VALUES FROM ('2027-02-01 00:00:00+00') TO ('2027-03-01 00:00:00+00');
CREATE TABLE events_2027_03 PARTITION OF events
  FOR VALUES FROM ('2027-03-01 00:00:00+00') TO ('2027-04-01 00:00:00+00');
CREATE TABLE events_2027_04 PARTITION OF events
  FOR VALUES FROM ('2027-04-01 00:00:00+00') TO ('2027-05-01 00:00:00+00');
CREATE TABLE events_2027_05 PARTITION OF events
  FOR VALUES FROM ('2027-05-01 00:00:00+00') TO ('2027-06-01 00:00:00+00');
CREATE TABLE events_2027_06 PARTITION OF events
  FOR VALUES FROM ('2027-06-01 00:00:00+00') TO ('2027-07-01 00:00:00+00');

CREATE TABLE send_events_2026_09 PARTITION OF send_events
  FOR VALUES FROM ('2026-09-01 00:00:00+00') TO ('2026-10-01 00:00:00+00');
CREATE TABLE send_events_2026_10 PARTITION OF send_events
  FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');
CREATE TABLE send_events_2026_11 PARTITION OF send_events
  FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');
CREATE TABLE send_events_2026_12 PARTITION OF send_events
  FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');
CREATE TABLE send_events_2027_01 PARTITION OF send_events
  FOR VALUES FROM ('2027-01-01 00:00:00+00') TO ('2027-02-01 00:00:00+00');
CREATE TABLE send_events_2027_02 PARTITION OF send_events
  FOR VALUES FROM ('2027-02-01 00:00:00+00') TO ('2027-03-01 00:00:00+00');
CREATE TABLE send_events_2027_03 PARTITION OF send_events
  FOR VALUES FROM ('2027-03-01 00:00:00+00') TO ('2027-04-01 00:00:00+00');
CREATE TABLE send_events_2027_04 PARTITION OF send_events
  FOR VALUES FROM ('2027-04-01 00:00:00+00') TO ('2027-05-01 00:00:00+00');
CREATE TABLE send_events_2027_05 PARTITION OF send_events
  FOR VALUES FROM ('2027-05-01 00:00:00+00') TO ('2027-06-01 00:00:00+00');
CREATE TABLE send_events_2027_06 PARTITION OF send_events
  FOR VALUES FROM ('2027-06-01 00:00:00+00') TO ('2027-07-01 00:00:00+00');

-- HALF 2 -- partition_maintenance_runs (D-02/D-10/D-12): the durable
-- cross-process health signal. The daily maintenance worker (09-02) writes
-- exactly one singleton row here every run (`id integer PRIMARY KEY DEFAULT 1
-- CHECK (id = 1)` enforces the singleton); a separate apps/api watchdog
-- process reads it on its own interval -- Postgres is the ONLY state shared
-- between the two processes (RESEARCH.md Pattern 2). `lookahead_months` and
-- `buffer_alert_threshold_months` are persisted alongside the computed
-- numbers (not just the numbers themselves) so a future drift between the two
-- -- D-12's "someone changed the lookahead without changing the threshold" --
-- is visible in the DATA, not only in a code diff. `last_alert_sent_at` is
-- owned exclusively by the watchdog (apps/api) -- the worker's own
-- `recordMaintenanceRun` UPSERT must never touch it, so a maintenance run
-- can never accidentally reset an in-flight alert-dedup window.
--
-- Retention/deletion of history is Phase 14 / DB-11 and explicitly out of
-- scope here -- an append-only history table would grow unbounded with no
-- owner yet, hence the singleton-row design rather than one row per run.
--
-- NO ROW LEVEL SECURITY on this table, and this is deliberate, not an
-- oversight: it carries no `workspace_id` and no tenant data whatsoever --
-- only platform-level operational metadata (table names implied by column
-- names, month counts, row counts, timestamps). Do NOT "fix" this by adding
-- ENABLE/FORCE ROW LEVEL SECURITY + a workspace_isolation policy the way
-- every tenant-scoped table in this codebase gets -- there is no
-- workspace_id column for such a policy to key on, and applying one would be
-- a no-op at best and a boot-breaking misconfiguration at worst.
CREATE TABLE partition_maintenance_runs (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_run_at timestamptz NOT NULL,
  lookahead_months integer NOT NULL,
  buffer_alert_threshold_months integer NOT NULL,
  events_buffer_months integer NOT NULL,
  send_events_buffer_months integer NOT NULL,
  buffer_months_remaining integer NOT NULL,
  events_default_count bigint NOT NULL,
  send_events_default_count bigint NOT NULL,
  partitions_created text[] NOT NULL DEFAULT '{}',
  last_alert_sent_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE partition_maintenance_runs IS
  'Platform-level operational metadata -- NOT tenant data, deliberately has NO workspace_id and NO Row-Level Security. See this migration''s header comment before adding RLS here.';
