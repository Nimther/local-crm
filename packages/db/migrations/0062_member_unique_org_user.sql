-- Phase 14 (DB-12, Pitfall 17, plan 14-02): closes the one confirmed
-- structural gap RESEARCH.md's static schema read and this plan's own live
-- `pg_constraint`/`pg_index` introspection (`audit-missing-constraints.ts`,
-- run against the dev database migrated through 0061) both name --
-- `member(organizationId, userId)` carries only its primary key, no
-- uniqueness on the pair. `member` is Better Auth's own table (no
-- application code declares it); an invite-accept race can plausibly write
-- two membership rows for the same person in the same organization, and
-- every permission decision in this platform resolves through membership.
--
-- HAND-WRITTEN (not drizzle-kit generate output), following migration
-- 0057's proven structure literally -- same precedent this plan's own
-- header cites: duplicate pre-check first, no DELETE/UPDATE anywhere in
-- this file, blocking index build, `indisvalid` assertion.
--
-- DEVIATION FROM THE ROADMAP'S LITERAL WORDING (recorded in 14-02-PLAN.md
-- and repeated here so a future reader does not have to cross-reference):
-- the ROADMAP/CONTEXT.md text says `CREATE UNIQUE INDEX CONCURRENTLY` +
-- `ADD CONSTRAINT ... UNIQUE USING INDEX`. `CONCURRENTLY` is NOT expressible
-- inside this repo's migration model -- each migration file runs as one
-- `client.query(sql)` call, which Postgres's simple-query protocol wraps in
-- ONE implicit transaction end-to-end, and `CREATE INDEX CONCURRENTLY`
-- cannot run inside a transaction block. Migration 0057 already discovered
-- and documented this exact limitation; this migration follows the same
-- resolution (blocking build, `indisvalid` assertion) rather than
-- re-deriving it. Unlike 0057's `send_events` (partitioned, high write
-- volume, `FORCE ROW LEVEL SECURITY`), `member` is a small, UNpartitioned
-- table with one row per user per organization and NO row-level security
-- (migration 0045's header: "RLS is deliberately NOT used here" for the
-- seven better-auth tables) -- a blocking build here is milliseconds, and
-- there is no per-tenant write-blocking window to reason about. The
-- guarantee the ROADMAP asked for (no INVALID, non-enforcing index) is
-- delivered in full; only the mechanism differs, for a reason already
-- documented in this repository (migration 0057's own header).
--
-- CONSTRAINT/INDEX NAMING (verified empirically before choosing this,
-- rather than assumed): `ALTER TABLE ... ADD CONSTRAINT x UNIQUE USING
-- INDEX y` RENAMES the index to match the constraint name whenever x != y
-- (confirmed against a scratch table on this project's own Postgres 17.10).
-- To avoid any ambiguity about which name Step 3's `indisvalid` assertion
-- should target, this migration gives the index and the constraint the
-- SAME name (`member_organization_user_unique`) from the start -- Postgres
-- accepts this with no rename notice, and every later reference (the
-- Drizzle schema, this plan's test suite, any future migration) has
-- exactly one name to use.
--
-- =============================================================================
-- OPERATOR SEQUENCE (read this before applying, since a step lives outside SQL)
-- =============================================================================
-- 1. `npm run db:count-member-duplicates -w packages/db` -- read-only,
--    reports the exact blast radius: how many (organizationId, userId)
--    groups in `member` currently hold more than one row, and how many
--    rows would need deleting to resolve them.
-- 2. If that count is non-zero, run
--    `npm run db:resolve-member-duplicates -w packages/db` -- deletes all
--    but the earliest-createdAt row per group, in bounded, committed
--    batches (packages/db/scripts/count-member-duplicates.ts). Idempotent:
--    a second run finds nothing to do.
-- 3. Apply this migration.
-- If this migration is reached before step 2 has fully resolved the
-- backlog, Step 0 below raises and stops -- 0061 is already recorded as
-- applied, so re-running the migration chain after resolving simply
-- resumes here. This is the INTENDED behavior for an unresolved backlog,
-- not an unhandled case.
--
-- =============================================================================
-- STEP 0 -- fail closed on any surviving duplicate (organizationId, userId)
-- =============================================================================
-- Fails closed (raises and stops) rather than warns, and runs BEFORE every
-- subsequent step, for the same reason migration 0057's own Step 0 does:
-- a unique index build over surviving violations fails on the very first
-- conflicting row, and refusing up front is strictly cheaper and clearer
-- than letting the build fail partway through. Same precedent as migration
-- 0038's deadline guard (see its own header and
-- packages/db/src/__tests__/migration-0038-deadline-guard.test.ts for the
-- "guard an unsafe precondition with a loud failure" shape this copies).
--
-- No per-workspace loop here, unlike 0057's own guard: `member` carries NO
-- row-level security at all (migration 0045's header), so a single,
-- unscoped `SELECT ... FROM member` spanning every organization at once is
-- both correct and directly expressible -- there is no fail-closed GUC to
-- satisfy and no reason to iterate `organization` one row at a time the way
-- 0057 must for `send_events` (which IS `FORCE ROW LEVEL SECURITY`).
DO $$
DECLARE
  dup_count bigint;
BEGIN
  SELECT count(*) INTO dup_count
    FROM (
      SELECT 1
        FROM member
       GROUP BY "organizationId", "userId"
      HAVING count(*) > 1
    ) dupes;

  IF dup_count > 0 THEN
    RAISE EXCEPTION 'migration 0062 (member unique org/user) refuses to apply: % duplicate (organizationId, userId) group(s) survive in member. Run `npm run db:count-member-duplicates -w packages/db` to see the exact blast radius, then `npm run db:resolve-member-duplicates -w packages/db` to resolve them in bounded, committed batches, then re-apply this migration -- migration 0061 is already recorded as applied, so re-running the chain resumes here. This is the intended behavior for an unresolved backlog, not an unhandled case.', dup_count;
  END IF;
END $$;

-- =============================================================================
-- STEP 1 -- build the unique index, blocking, in ONE statement
-- =============================================================================
-- `member` is small (one row per membership) and NOT partitioned -- no
-- lock-cost tradeoff to make here the way migration 0057 had to reason
-- about for `send_events` at scale. See this file's header for why
-- CONCURRENTLY is not used and why this index is named identically to the
-- constraint Step 2 promotes it to.
CREATE UNIQUE INDEX member_organization_user_unique ON member ("organizationId", "userId");

-- =============================================================================
-- STEP 2 -- promote the index to a named constraint
-- =============================================================================
-- Unlike migration 0057's `send_events` (partitioned -- `ADD CONSTRAINT
-- ... USING INDEX` is documented as unsupported on partitioned tables,
-- verified live in that migration's own header), `member` is a plain,
-- unpartitioned table, so this IS supported and IS used here: the enforced
-- object becomes a named constraint backed by the index Step 1 just built,
-- not a bare index. `plan 14-05`'s `drizzle-kit generate` empty-diff gate
-- compares against a constraint declared the same way in
-- `packages/db/src/schema/auth.ts` -- see that file's own change,
-- committed alongside this migration.
ALTER TABLE member ADD CONSTRAINT member_organization_user_unique UNIQUE USING INDEX member_organization_user_unique;

-- =============================================================================
-- STEP 3 -- assert the index is valid rather than assuming it
-- =============================================================================
-- Same failure class as Pitfall 17 (CREATE UNIQUE INDEX CONCURRENTLY over
-- existing duplicates leaves an INVALID, non-enforcing index with no
-- migration-time error): an invalid index enforces nothing and reports no
-- error, so a duplicate insert that should have been rejected would
-- silently succeed. Because Step 1 is a single blocking statement there is
-- no partial-build window to catch here -- but this assertion stays
-- regardless, since it also catches the case where Step 1/2 were skipped,
-- reordered, or edited to a non-unique index during a later refactor.
DO $$
BEGIN
  IF NOT (SELECT indisvalid FROM pg_index WHERE indexrelid = 'member_organization_user_unique'::regclass) THEN
    RAISE EXCEPTION 'migration 0062: member_organization_user_unique is NOT valid after CREATE UNIQUE INDEX / ADD CONSTRAINT. An invalid index enforces nothing while reporting no error (same failure class as Pitfall 17) -- do not retry blindly; investigate the index state (pg_index, pg_stat_progress_create_index) before proceeding.';
  END IF;
END $$;

-- COMMENT recording DB-12's own intent, per this plan's action text.
COMMENT ON CONSTRAINT member_organization_user_unique ON member IS 'DB-12 (Phase 14): closes the invite-accept race that could otherwise write two membership rows for one person in one organization -- every permission decision in this platform resolves through membership.';
