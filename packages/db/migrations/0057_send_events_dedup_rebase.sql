-- Phase 13 (CMP-07, D-15, plan 13-07): re-bases send_events's dedup identity
-- off `sg_event_id` -- verified UNSTABLE across SendGrid webhook retries --
-- onto the compound, server-observed key `(workspace_id, send_id, event_type,
-- occurred_at)`. `sg_event_id` remains a stored, NOT NULL, forensic-
-- correlation column; it is DEMOTED out of uniqueness entirely, never
-- ADDED-ALONGSIDE the new columns -- keeping it in the enforced key would
-- preserve exactly the bypass this migration exists to close, since a
-- redelivery varying only `sg_event_id` would still produce a distinct key
-- tuple. `occurred_at` stays in the key because Postgres requires every
-- unique constraint on a partitioned table to include all partition-key
-- columns -- a structural constraint, not a design choice to revisit. This
-- is safe only because plan 13-04's `classifyOccurredAt` (migration 0055's
-- companion code change) already bounds `occurred_at` to
-- [now-7d, now+5min] before a row is ever constructed, closing the
-- vary-the-timestamp bypass; this migration closes the vary-the-event-id
-- bypass. Either fix alone leaves the other bypass open.
--
-- HAND-WRITTEN (not drizzle-kit generate output), its own migration, never
-- combined with another table's DDL -- same precedent as
-- 0020_send_events_partitioned.sql: Postgres declarative partitioning has no
-- expression in Drizzle's pgTable API.
--
-- =============================================================================
-- OPERATOR SEQUENCE (read this before applying, since a step lives outside SQL)
-- =============================================================================
-- 1. `npm run db:count-send-event-duplicates` -- read-only, reports the exact
--    blast radius: how many (workspace_id, send_id, event_type, occurred_at)
--    groups (restricted to send_id IS NOT NULL) currently hold more than one
--    row, and how many rows would need deleting to resolve them.
-- 2. If that count is non-zero, run `npm run db:resolve-send-event-duplicates`
--    -- deletes all but the earliest-received_at row per group, in bounded,
--    committed batches (packages/db/scripts/count-send-event-duplicates.ts).
--    Idempotent: a second run finds nothing to do.
-- 3. Apply this migration.
-- If this migration is reached before step 2 has fully resolved the backlog,
-- Step 0 below raises and stops -- 0056 is already recorded as applied, so
-- re-running the migration chain after resolving simply resumes here. This
-- is the INTENDED behavior for an unresolved backlog, not an unhandled case:
-- the alternative (proceeding anyway) is a unique index build that fails
-- partway through on a large partitioned table, which is strictly worse.
--
-- =============================================================================
-- STEP 0 -- fail closed on any surviving duplicate under the NEW key
-- =============================================================================
-- Hazard this guards: REVIEWS.md established that the bounded,
-- per-batch-committing DELETE this cleanup needs cannot be expressed inside
-- a migration under this repo's runner -- a `DO $$ ... END $$;` block is ONE
-- transaction end to end, so it cannot COMMIT per batch, and the
-- `--> statement-breakpoint` convention gives no loop construct at all. The
-- deletion therefore lives OUTSIDE this file, in the operator-invoked
-- `count-send-event-duplicates.ts --resolve` script (Task 1 of this plan,
-- following the Phase 9 D-08 `relocate-default-partition-rows.ts` precedent:
-- row-level bulk mutation over a partitioned table is operator-invoked and
-- never scheduled). This migration contains NO DELETE statement anywhere --
-- its only job regarding duplicates is to make skipping the resolve step
-- impossible to do silently.
--
-- Fails closed (raises and stops) rather than warns, and runs BEFORE every
-- subsequent step, because the alternative is worse than a refused
-- migration: Step 1's unique index build over surviving violations would
-- fail on the very first conflicting row, but by then it may already have
-- done work on some partitions and not others depending on internal build
-- order, leaving an ambiguous, possibly-invalid parent index that Step 2's
-- own assertion would then have to catch anyway -- refusing up front is
-- strictly cheaper and clearer. Same precedent as migration 0038's deadline
-- guard (see its own header and
-- packages/db/src/__tests__/migration-0038-deadline-guard.test.ts for the
-- "guard an unsafe precondition with a loud failure" shape this copies);
-- plan 13-12's migration 0061 uses the identical fail-closed shape for the
-- same class of reason.
--
-- MECHANISM, discovered and fixed during this plan's own test-writing (not
-- assumed): migrations apply as `mega_crm_app` (`packages/db/drizzle.config.ts`
-- reads `DATABASE_URL`, which is the app role in every environment this
-- project defines), and `send_events` carries `FORCE ROW LEVEL SECURITY` --
-- FORCE means even the table OWNER is subject to the `workspace_isolation`
-- policy, which is a bare-cast, fail-closed predicate as of migration 0044
-- (`current_setting('app.current_workspace_id')::uuid`, no `missing_ok`
-- argument). A single unscoped `SELECT ... FROM send_events` spanning every
-- tenant at once -- which is what a naive "count all duplicate groups"
-- query would need to be -- is therefore not just wrong, it is not
-- EXPRESSIBLE: a virgin connection that has never set that GUC raises
-- `unrecognized configuration parameter` on first touch, proven empirically
-- while writing this migration's own test suite. The fix mirrors Task 1's
-- TypeScript script exactly, translated into PL/pgSQL rather than
-- reinvented: loop over every workspace id from `organization` (a table
-- `mega_crm_app` can read without any GUC -- confirmed live, and unaffected
-- by `workspace_isolation`, which only governs `contacts`/`sends`/
-- `send_events`/etc.), `set_config('app.current_workspace_id', ..., true)`
-- for that one workspace, and count that workspace's OWN duplicate groups
-- before moving to the next. No new grant, no temporary
-- `NO FORCE ROW LEVEL SECURITY` toggle, no elevated role -- this stays
-- entirely inside `mega_crm_app`'s existing privileges, using the exact
-- session-scoped mechanism `@mega-crm/tenant-context`'s
-- `withTenantTransaction` already relies on everywhere else in this
-- codebase. The `set_config` calls are `is_local = true` (SET LOCAL
-- semantics) and this whole guard is one statement inside the migration's
-- single implicit transaction, so the GUC's value at the end of this loop
-- is simply whichever workspace was iterated last -- harmless, since every
-- statement after this guard (the index build, the validity assertion, the
-- constraint drop) is DDL or a system-catalog read, neither of which
-- `workspace_isolation` governs.
DO $$
DECLARE
  ws record;
  dup_count bigint := 0;
  ws_dup_count bigint;
BEGIN
  FOR ws IN SELECT id FROM organization LOOP
    PERFORM set_config('app.current_workspace_id', ws.id::text, true);

    SELECT count(*) INTO ws_dup_count
      FROM (
        SELECT 1
          FROM send_events
         WHERE send_id IS NOT NULL
         GROUP BY workspace_id, send_id, event_type, occurred_at
        HAVING count(*) > 1
      ) dupes;

    dup_count := dup_count + ws_dup_count;
  END LOOP;

  IF dup_count > 0 THEN
    RAISE EXCEPTION 'migration 0057 (send_events dedup rebase) refuses to apply: % duplicate group(s) survive under the new key (workspace_id, send_id, event_type, occurred_at), across all workspaces. Run `npm run db:count-send-event-duplicates` to see the exact per-workspace blast radius, then `npm run db:resolve-send-event-duplicates` to resolve them in bounded, committed batches, then re-apply this migration -- migration 0056 is already recorded as applied, so re-running the chain resumes here. This is the intended behavior for an unresolved backlog, not an unhandled case.', dup_count;
  END IF;
END $$;

-- =============================================================================
-- STEP 1 -- build the new unique index on the partitioned PARENT, blocking,
-- in ONE statement
-- =============================================================================
-- Postgres creates the matching child index on every attached partition and
-- attaches it automatically; the parent index is valid the instant this
-- statement returns. Must be UNIQUE: a plain (non-unique) CREATE INDEX
-- cannot back dedup and cannot be an ON CONFLICT target, so a non-unique
-- index here would apply cleanly and then fail every insert at runtime (the
-- worker's ON CONFLICT target, swapped in this same plan's Task 3, names
-- exactly these four columns).
--
-- This is a decision made HERE, in this header, not a branch left to
-- executor discretion at apply time (Codex follow-up review, WARNING finding
-- 5). Two alternatives were considered and rejected:
--
--   REJECTED: a non-blocking per-partition build plus a metadata-only parent
--   (`ON ONLY` + per-partition `CREATE INDEX CONCURRENTLY` + `ALTER INDEX
--   ... ATTACH PARTITION` for every existing partition). That entire
--   choreography exists for exactly one purpose -- letting each partition's
--   index build without taking a write lock, since a non-blocking
--   (CONCURRENTLY) build cannot be issued against a partitioned PARENT at
--   all. Remove the non-blocking requirement (see the lock-cost paragraph
--   below) and the choreography has no remaining reason to exist: it becomes
--   several times the DDL, a catalog enumeration this migration would have
--   to reimplement, and a window in which the parent index is invalid and
--   enforces nothing -- all to reach the same end state one statement
--   reaches directly.
--
--   REJECTED: an operator/pre-deploy script that builds the index(es)
--   outside this migration, mirroring Step 0's own shape for the duplicate
--   cleanup. The two problems are NOT the same shape despite looking
--   similar: the duplicate DELETE moved out because the migration runner
--   genuinely cannot express a per-batch-committing loop (a `DO` block is
--   one transaction). Index creation has no such expressiveness problem --
--   it is one statement the runner already handles natively inside its
--   single-transaction-per-file model. Moving it out anyway would add a
--   second mandatory operator step before every deploy of this migration,
--   buying only lock avoidance, which the next paragraph shows is not
--   needed here.
--
--   CHOSEN: the blocking parent build below, because the write lock it
--   takes has nothing to contend with. `send_events` has exactly ONE
--   writer in this codebase, `processWebhookEventBatch`
--   (apps/worker/src/queues/webhook-events.worker.ts), and ROADMAP.md's
--   R-05 decision commits this milestone's worker deploy to
--   stop-old-then-start-new (Phase 14) -- the worker process is stopped for
--   this migration's ENTIRE window; jobs wait in Redis, and the webhook
--   HTTP route's own write goes to `ingress_journal` (migration 0055), never
--   directly to `send_events`. The lock is therefore taken against no
--   concurrent traffic. Step 4 below (the old-constraint drop) already
--   depends on this exact same deploy-mode fact and records it in its own
--   comment -- recording both here keeps them from drifting apart.
--
-- LOCK COST, stated honestly rather than waved away: this statement takes a
-- write lock (SHARE lock class sufficient for a unique index build, but
-- still blocking against concurrent writers) on `send_events` and every
-- attached partition for the build's duration. Acceptable ONLY while the
-- sole writer is stopped, per the CHOSEN paragraph above. A future move to a
-- rolling worker deploy would need to revisit this decision, not merely
-- re-run this migration.
CREATE UNIQUE INDEX send_events_dedup_v2_idx ON send_events (workspace_id, send_id, event_type, occurred_at);

-- =============================================================================
-- STEP 2 -- assert the index is valid rather than assuming it
-- =============================================================================
-- Same failure class as Phase 14's Pitfall 17 (CREATE UNIQUE INDEX
-- CONCURRENTLY over existing duplicates leaves an INVALID, non-enforcing
-- index with no migration-time error): an invalid index enforces nothing and
-- reports no error, so an insert that should have been deduped would
-- silently succeed twice. Because the chosen route (Step 1) is a single
-- blocking statement, there is no per-partition loop for a partial build to
-- fail in the middle of -- but this assertion stays regardless, since it
-- also catches the case where Step 1 was skipped, reordered, or edited to a
-- non-unique index during a later refactor. Cheap, and the only thing
-- standing between a partial build and a dedup guarantee that exists only on
-- paper.
DO $$
BEGIN
  IF NOT (SELECT indisvalid FROM pg_index WHERE indexrelid = 'send_events_dedup_v2_idx'::regclass) THEN
    RAISE EXCEPTION 'migration 0057: send_events_dedup_v2_idx is NOT valid after CREATE UNIQUE INDEX. An invalid index enforces nothing while reporting no error (same failure class as Phase 14 Pitfall 17) -- do not retry blindly; investigate the index state (pg_index, pg_stat_progress_create_index) before proceeding.';
  END IF;
END $$;

-- =============================================================================
-- STEP 3 -- promote to a named constraint IF AND ONLY IF this Postgres
-- version supports it on a partitioned table (it does not, here)
-- =============================================================================
-- `ALTER TABLE ... ADD CONSTRAINT ... UNIQUE USING INDEX` is documented as
-- unsupported on partitioned tables, and this was VERIFIED live rather than
-- trusted from RESEARCH.md's migration sketch (which used it) or the
-- advisory review (which flagged it as probably wrong): against a scratch
-- PostgreSQL 17.10 database (the same major version this project's
-- `docker-compose.yml` pins), issuing
-- `ALTER TABLE t ADD CONSTRAINT t_uniq UNIQUE USING INDEX t_uniq_idx` on a
-- RANGE-partitioned table raises exactly
-- `ERROR: ALTER TABLE / ADD CONSTRAINT USING INDEX is not supported on
-- partitioned tables`. Per Task 2's own instructions, since unsupported,
-- this migration does NOT attempt it -- no ALTER TABLE ADD CONSTRAINT
-- statement exists in this file. The consequence, stated explicitly: no
-- NAMED constraint backs this uniqueness guarantee going forward, only the
-- attached, valid unique index built in Step 1. This is not a weaker
-- guarantee -- Postgres enforces uniqueness via the index itself regardless
-- of whether a named constraint wraps it, and `ON CONFLICT (workspace_id,
-- send_id, event_type, occurred_at)` (Task 3's worker change) matches a
-- unique index directly without needing one. A future migration that wants
-- to reference this uniqueness guarantee by constraint name has no name to
-- reference -- reference the index name (`send_events_dedup_v2_idx`)
-- instead.

-- =============================================================================
-- STEP 4 -- drop the OLD dedup constraint, LAST, after the new index is
-- enforced and valid
-- =============================================================================
-- Confirmed from the LIVE catalog rather than assumed: migration 0020
-- declares the old constraint inline as
-- `UNIQUE (workspace_id, sg_event_id, occurred_at)`, so Postgres
-- auto-generated its name. Applying migrations 0000 through 0020 against a
-- scratch database and querying `pg_constraint` (`contype = 'u'`) for
-- `send_events` returns exactly one row:
-- `send_events_workspace_id_sg_event_id_occurred_at_key`. This is that exact
-- name, not a guess.
--
-- Ordered LAST, after Step 1's index is built and Step 2 has asserted it
-- valid -- dropping first would leave a window with NO dedup protection at
-- all (expand/contract discipline).
--
-- DEPLOY-ORDERING ASSUMPTION THIS STEP RESTS ON (REVIEWS.md MEDIUM finding,
-- recorded explicitly rather than left implicit): dropping the old
-- constraint in the SAME migration that Task 3's new `ON CONFLICT
-- (workspace_id, send_id, event_type, occurred_at)` target requires creates
-- a window in which OLD worker code -- whose insert still names
-- `ON CONFLICT (workspace_id, sg_event_id, occurred_at)` -- would match NO
-- constraint and fail at runtime on EVERY insert. That window is EMPTY under
-- this milestone's actual deploy mode: ROADMAP.md's R-05 decision adopts
-- stop-old-then-start-new for the worker in Phase 14, so no old worker
-- process is ever running while this new schema is live -- the same fact
-- Step 1's header cites. A future move to a rolling worker deploy would
-- silently reintroduce a total ingestion outage during the rollout window;
-- this comment is where that future reader needs to see it. The drop is NOT
-- split into a follow-on migration to buy rolling-deploy safety -- that
-- would leave the old constraint enforcing a key the code no longer targets
-- for a full phase, and the deploy mode that makes an immediate drop safe is
-- already the one this milestone has committed to.
ALTER TABLE send_events DROP CONSTRAINT send_events_workspace_id_sg_event_id_occurred_at_key;
