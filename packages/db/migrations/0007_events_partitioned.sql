-- events table (EVNT-01/02/03): partitioned by RANGE(occurred_at).
--
-- HAND-WRITTEN (not drizzle-kit generate output): Postgres declarative
-- partitioning -- `PARTITION BY RANGE`, plus a composite primary key that
-- includes the partition key column -- has no expression in Drizzle's
-- pgTable API (02-RESEARCH.md "No partitioned table precedent" / Code
-- Examples). packages/db/src/schema/events.ts declares the logical column
-- shape for type inference only; this migration owns the actual DDL, same
-- hand-written-migration pattern as 0004/0006's RLS-only migrations (no
-- drizzle-kit meta snapshot accompanies this file).
--
-- PRIMARY KEY (id, occurred_at): a partitioned table's primary key (and
-- every unique constraint) MUST include the partition key column -- `id`
-- alone is not sufficient. The events:ingest worker (apps/worker) uses this
-- exact composite key with `ON CONFLICT (id, occurred_at) DO NOTHING` for
-- idempotent redelivery (Pitfall 1) -- occurred_at is resolved ONCE at
-- ingestion time (apps/api's /v1/events route, before enqueue) and carried
-- unchanged through job.data, so it is deterministic across redeliveries.
CREATE TABLE events (
  id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  name text NOT NULL,
  properties jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

-- Current + next month partitions (Assumption A5). Subsequent months must
-- be created by a scheduled maintenance job before they're needed (Don't
-- Hand-Roll: pg_partman's run_maintenance_proc is the standard automation
-- layer on top of native declarative partitioning, if the extension is
-- available in the hosting environment) -- not yet built, tracked as an
-- operational follow-up, same as 02-RESEARCH.md flags.
CREATE TABLE events_2026_07 PARTITION OF events
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE events_2026_08 PARTITION OF events
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

CREATE INDEX idx_events_workspace_contact_time ON events (workspace_id, contact_id, occurred_at);
CREATE INDEX idx_events_workspace_name_time ON events (workspace_id, name, occurred_at);

-- RLS on the PARENT table only -- Postgres automatically propagates a
-- parent's RLS policies to every partition, so applying this once here
-- covers events_2026_07/events_2026_08 and every future monthly partition
-- too. Same ENABLE + FORCE shape as every other tenant-scoped table (see
-- 0001_rls_policies.sql's comment on why FORCE is required -- the app role
-- owns its own tables and Postgres exempts owners from RLS by default).
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE events FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON events
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id', true)::uuid);
