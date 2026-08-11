-- Phase 13 (CMP-04, D-02, plan 13-12) -- the CONTRACT half of the two-
-- migration sequence started by 0060 (expand). Fails closed on any
-- remaining un-backfilled row, then makes email_hash NOT NULL, drops the
-- now-obsolete (workspace_id, email) unique constraint, and drops the
-- plaintext email column entirely.
--
-- OPERATOR SEQUENCE (read before applying -- this is a two-migration change
-- with an application-level step in the middle that cannot be expressed in
-- SQL): apply through 0060, run `npm run db:rehash-suppressions`, then apply
-- this migration. If 0061 is reached before the backfill has fully run, the
-- guard below raises and stops -- migration 0060 is already recorded as
-- applied, so re-running the migration chain after resolving the backlog
-- simply resumes here. This is the INTENDED behavior for an unresolved
-- backfill, not an unhandled case -- same precedent as migration 0057's own
-- Step 0 guard and migration 0038's deadline guard.
--
-- =============================================================================
-- STEP 0 -- fail closed on any surviving null email_hash
-- =============================================================================
-- Hazard this guards: a workspace_suppressions row holding neither a hash
-- nor anything the send pipeline can compare against is a SILENT-MISS
-- surface -- the pre-send/pre-create check would hash a candidate address,
-- find no matching row (because this row has no hash at all), and conclude
-- the address is not suppressed. Mailing a person who asked not to be
-- mailed is exactly the failure CMP-04 exists to prevent, so this migration
-- refuses to proceed rather than silently dropping the plaintext column out
-- from under an unresolved row.
--
-- MECHANISM: migrations apply as mega_crm_app (drizzle.config.ts reads
-- DATABASE_URL, the app role in every environment this project defines),
-- and workspace_suppressions carries FORCE ROW LEVEL SECURITY -- FORCE means
-- even the table owner is subject to the fail-closed workspace_isolation
-- predicate (migration 0044: a bare-cast current_setting with no missing_ok
-- argument). A single unscoped `SELECT count(*) ... WHERE email_hash IS
-- NULL` spanning every tenant at once is therefore not just wrong, it is
-- NOT EXPRESSIBLE: a virgin connection that has never set
-- app.current_workspace_id raises `unrecognized configuration parameter` on
-- first touch. The fix mirrors migration 0057's own Step 0 exactly (see its
-- header for the fuller derivation, and
-- packages/db/src/__tests__/migration-0038-deadline-guard.test.ts for the
-- "guard an unsafe precondition with a loud failure" shape both migrations
-- copy): loop over every workspace id from `organization` (a table
-- mega_crm_app can read without any GUC), set_config
-- ('app.current_workspace_id', ..., true) for that one workspace, and count
-- that workspace's own null-email_hash rows before moving to the next. No
-- new grant, no temporary NO FORCE ROW LEVEL SECURITY toggle, no elevated
-- role -- entirely inside mega_crm_app's existing privileges.
--
-- An empty workspace_suppressions table (e.g. a from-empty test database, or
-- any environment with zero suppressions so far) passes this guard
-- trivially -- zero organizations or zero rows both sum to a null_count of 0.
DO $$
DECLARE
  ws record;
  null_count bigint := 0;
  ws_null_count bigint;
BEGIN
  FOR ws IN SELECT id FROM organization LOOP
    PERFORM set_config('app.current_workspace_id', ws.id::text, true);

    SELECT count(*) INTO ws_null_count
      FROM workspace_suppressions
     WHERE email_hash IS NULL;

    null_count := null_count + ws_null_count;
  END LOOP;

  IF null_count > 0 THEN
    RAISE EXCEPTION 'migration 0061 (suppression hash contract) refuses to apply: % workspace_suppressions row(s) still have a null email_hash, across all workspaces. Run `npm run db:rehash-suppressions` to backfill them from the pre-13-12 plaintext column, then re-apply this migration -- migration 0060 is already recorded as applied, so re-running the chain resumes here. This is the intended behavior for an unresolved backfill, not an unhandled case.', null_count;
  END IF;
END $$;

-- =============================================================================
-- STEP 1 -- email_hash becomes the enforced identity column
-- =============================================================================
ALTER TABLE workspace_suppressions ALTER COLUMN email_hash SET NOT NULL;

-- =============================================================================
-- STEP 2 -- drop the now-superseded (workspace_id, email) unique constraint
-- =============================================================================
-- Superseded by the (workspace_id, email_hash) unique index migration 0060
-- already created; the column this constraint covers is dropped in the very
-- next statement anyway.
ALTER TABLE workspace_suppressions DROP CONSTRAINT workspace_suppressions_workspace_email_unique;

-- =============================================================================
-- STEP 3 -- the plaintext column itself is gone
-- =============================================================================
-- This is the point of the whole migration: every row was proven to carry a
-- non-null email_hash by Step 0 above before this statement can be reached,
-- so dropping the plaintext column here closes T-13-12-01 -- no plaintext
-- email address survives in the workspace suppression list after this.
-- destructive: closes T-13-12-01 -- every row was proven hashed by Step 0 above before this statement can run.
ALTER TABLE workspace_suppressions DROP COLUMN email;
