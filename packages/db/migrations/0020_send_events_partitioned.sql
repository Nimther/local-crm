-- send_events table (WBHK-01/02/03, D-14/D-16): partitioned by RANGE(occurred_at).
--
-- HAND-WRITTEN (not drizzle-kit generate output): Postgres declarative
-- partitioning -- `PARTITION BY RANGE`, plus a composite primary key that
-- includes the partition key column -- has no expression in Drizzle's
-- pgTable API (same precedent as 0007_events_partitioned.sql /
-- 0010_events_workspace_scoped_pk.sql). packages/db/src/schema/send-events.ts
-- declares the logical column shape for type inference only; this migration
-- owns the actual DDL.
--
-- Workspace-scoped PK + DEFAULT partition from day one (applying 0010's
-- lessons immediately instead of as a follow-up migration): PRIMARY KEY
-- (workspace_id, id, occurred_at) so a row can never collide across tenants
-- (CR-01 precedent), and send_events_default guarantees a valid occurred_at
-- outside the pre-created monthly partitions is never silently rejected
-- (CR-03 precedent).
--
-- UNIQUE (workspace_id, sg_event_id, occurred_at): this is WBHK-03's actual
-- dedup mechanism -- distinct from the PK above. `occurred_at` is included
-- because Postgres REQUIRES every unique constraint on a partitioned table
-- to include all partition key columns (a bare `UNIQUE (workspace_id,
-- sg_event_id)` is rejected outright by CREATE TABLE on a table `PARTITION
-- BY RANGE (occurred_at)`) -- confirmed against this migration during
-- implementation (05-01-PLAN.md's literal `UNIQUE (workspace_id,
-- sg_event_id)` wording is adjusted here per that hard Postgres constraint,
-- matching RESEARCH.md's own Pattern 3 / Code Examples, which already show
-- `ON CONFLICT (workspace_id, sg_event_id, occurred_at)`). `occurred_at` is
-- resolved deterministically from the SendGrid event's own `timestamp`
-- field (apps/worker's webhook-events.worker.ts), so it is identical across
-- redeliveries of the same event -- the dedup insert's `ON CONFLICT
-- (workspace_id, sg_event_id, occurred_at) DO NOTHING` still dedupes
-- correctly on the sole natural key that matters (`sg_event_id`).
CREATE TABLE send_events (
  id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  sg_event_id text NOT NULL,
  send_id uuid REFERENCES sends(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  reason text,
  payload jsonb NOT NULL DEFAULT '{}',
  is_test boolean NOT NULL DEFAULT false,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id, occurred_at),
  UNIQUE (workspace_id, sg_event_id, occurred_at)
) PARTITION BY RANGE (occurred_at);

-- Current + next month partitions (mirrors 0007's Assumption A5 -- monthly
-- partition pre-creation for query-performance purposes is a tracked
-- operational follow-up, not a correctness requirement now that the
-- DEFAULT partition below exists as a catch-all).
CREATE TABLE send_events_2026_07 PARTITION OF send_events
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE send_events_2026_08 PARTITION OF send_events
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

-- DEFAULT partition (CR-03 lesson applied immediately, not as a follow-up
-- migration): any occurred_at outside the two pre-created monthly
-- partitions above still lands here rather than failing the INSERT with
-- "no partition of relation send_events found for row" -- a real risk here
-- since occurred_at is a SendGrid-supplied event timestamp, not a
-- platform-controlled ingestion time.
CREATE TABLE send_events_default PARTITION OF send_events DEFAULT;

CREATE INDEX idx_send_events_workspace_send ON send_events (workspace_id, send_id);

-- RLS on the PARENT table only -- Postgres automatically propagates a
-- parent's RLS policies to every partition, so applying this once here
-- covers send_events_2026_07/send_events_2026_08/send_events_default and
-- every future monthly partition too (see 0007_events_partitioned.sql's
-- comment on why FORCE is required -- the app role owns its own tables and
-- Postgres exempts owners from RLS by default). Only ever accessed via
-- withTenantTransaction (never a runtime-lookup-style bypass), so the bare
-- `::uuid` cast is safe here without a NULLIF guard, matching
-- events/sends's own single-policy precedent.
ALTER TABLE send_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE send_events FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON send_events
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id', true)::uuid);
