-- Phase 22 (PRG-02, D-10, plan 22-01, Task 2): relaxes `erasure_records.contact_id`
-- so DSR/erasure evidence survives a physical workspace purge's destruction
-- of `contacts` rows.
--
-- The constraint being relaxed is the inline, unnamed `REFERENCES contacts(id)
-- ON DELETE CASCADE` clause in `packages/db/migrations/0059_contact_erasure.sql`'s
-- `CREATE TABLE erasure_records` -- an inline unnamed REFERENCES clause, so
-- Postgres applied its own default naming convention
-- (`<table>_<column>_fkey`), and the constraint's real name IS
-- `erasure_records_contact_id_fkey` (verified: 0059's own CREATE TABLE
-- statement never names it explicitly, so the default-naming case applies,
-- not a hand-named case).
--
-- Deliberately leaves `erasure_records.workspace_id -> organization.id
-- ON DELETE CASCADE` (0059) untouched: the purge never hard-deletes
-- `organization` (it tombstones it by UPDATE, migration 0068's own header
-- comment), so that constraint is harmless in practice, and relaxing it too
-- would weaken a constraint that is arguably correct on its own terms --
-- losing the evidence alongside a genuinely hard-deleted organization is
-- consistent, whereas losing it because one contact among many was purged
-- is not.

ALTER TABLE erasure_records ALTER COLUMN contact_id DROP NOT NULL;

-- destructive: this table is workspace-purge evidence (D-10) and must
-- outlive the contacts it references -- an ON DELETE CASCADE would silently
-- destroy the audit trail the moment the purge's batched contacts DELETE
-- removes the referenced row, with no application code involved and
-- regardless of statement ordering. Dropping the CASCADE constraint here
-- (immediately re-added below as ON DELETE SET NULL) is what closes that
-- gap.
ALTER TABLE erasure_records DROP CONSTRAINT erasure_records_contact_id_fkey;

-- Execution-discovered addition (deviation Rule 1/3, precedent: migration
-- 0046's own header comment, verified empirically here too): migration 0044
-- made every `workspace_isolation` policy fail-closed -- `current_setting(
-- 'app.current_workspace_id')` with no `missing_ok` argument RAISES when the
-- GUC was never set in the session, rather than returning NULL. A migration
-- file applies as a single `mega_crm_app` client with no tenant context ever
-- set, and BOTH `erasure_records` (0059) and `contacts` (0004) carry FORCE
-- ROW LEVEL SECURITY -- FORCE means even the owning role is subject to the
-- policy. Postgres's own FK-validation scan for `ADD CONSTRAINT ...
-- FOREIGN KEY` reads both tables (an anti-join of `erasure_records` against
-- `contacts`), so it raises "unrecognized configuration parameter" for that
-- scan, unconditionally, regardless of how many rows either table holds.
-- Disabling RLS on both tables for the span of this one statement, inside
-- this migration's single implicit transaction, is the narrowest fix -- no
-- new role, no session GUC, and both tables have RLS restored before the
-- transaction (and therefore the migration) commits, so no window exists
-- where a concurrent connection could observe RLS as disabled on either one.
ALTER TABLE erasure_records DISABLE ROW LEVEL SECURITY;
ALTER TABLE contacts DISABLE ROW LEVEL SECURITY;

ALTER TABLE erasure_records
  ADD CONSTRAINT erasure_records_contact_id_fkey
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL;

ALTER TABLE erasure_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE erasure_records FORCE ROW LEVEL SECURITY;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN erasure_records.contact_id IS
  'Phase 22 (PRG-02, D-10): nullable as of migration 0069 -- ON DELETE SET NULL, not CASCADE, so a workspace purge''s batched destruction of the contacts table leaves this evidence row on disk, readable, with contact_id set to NULL rather than being destroyed alongside the contact it once described.';
