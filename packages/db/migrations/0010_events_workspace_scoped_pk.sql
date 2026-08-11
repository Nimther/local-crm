-- events table: workspace-scoped PK + DEFAULT partition (CR-01/CR-03).
--
-- HAND-WRITTEN (not drizzle-kit generate output) -- same convention as
-- 0007_events_partitioned.sql: dropping/re-adding a partitioned table's
-- composite primary key and adding a DEFAULT partition have no expression in
-- Drizzle's pgTable API. packages/db/src/schema/events.ts remains
-- type-inference only; this migration owns the physical DDL change (no
-- accompanying drizzle-kit meta snapshot, matching the 0004/0006/0009
-- hand-authored precedent).
--
-- CR-01 (tenant isolation): the prior PRIMARY KEY (id, occurred_at) let a
-- tenant squat another tenant's client-supplied eventId -- the second
-- workspace's INSERT silently hit `ON CONFLICT (id, occurred_at) DO NOTHING`
-- and was dropped even though the API had already returned 202. Widening the
-- key to include workspace_id closes this: two tenants can never collide on
-- the same (id, occurred_at) again, and the events:ingest worker's
-- `ON CONFLICT` target is updated to match exactly (see
-- apps/worker/src/queues/events-ingest.worker.ts). A partitioned table's PK
-- change cascades to every existing partition automatically; widening the
-- key to include an additional column can never introduce a new uniqueness
-- violation on already-stored rows, so this ALTER is safe on a populated
-- table.
ALTER TABLE events DROP CONSTRAINT events_pkey;
ALTER TABLE events ADD PRIMARY KEY (workspace_id, id, occurred_at);

-- CR-03 (durability): only events_2026_07/events_2026_08 exist (0007) with
-- no catch-all -- any occurredAt outside that window (a backfill, or any
-- event after 2026-09-01) failed the INSERT with "no partition of relation
-- events found for row" even though the API had already returned 202 for an
-- accepted job. A DEFAULT partition guarantees every valid occurredAt has
-- somewhere to land; monthly partition pre-creation for query-performance
-- purposes remains a tracked operational follow-up (02-RESEARCH.md), not a
-- correctness requirement now that this catch-all exists. RLS policies on
-- the parent `events` table propagate automatically to this partition too
-- (documented in 0007_events_partitioned.sql).
CREATE TABLE events_default PARTITION OF events DEFAULT;
