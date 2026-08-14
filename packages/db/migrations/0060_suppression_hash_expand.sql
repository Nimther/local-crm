-- Phase 13 (CMP-04, D-02, plan 13-12) -- the EXPAND half of a two-migration
-- sequence that replaces `workspace_suppressions.email` (plaintext) with an
-- HMAC of the normalized address, computed under a per-workspace key. This
-- migration adds the new key table and the new column set alongside the
-- existing plaintext column; it does not remove anything and does not
-- require the plaintext column to be empty. The CONTRACT half (dropping
-- `email`) is migration 0061, and it fails closed until every row has been
-- backfilled by `npm run db:rehash-suppressions` (packages/db/scripts/
-- rehash-suppressions.ts, this same plan's Task 2).
--
-- OPERATOR SEQUENCE (read before applying -- one step lives outside SQL):
--   1. Apply this migration (0060).
--   2. Run `npm run db:rehash-suppressions` -- computes email_hash for every
--      existing row from its stored plaintext, under that row's workspace's
--      key (created on first use for a workspace that had never suppressed
--      anything before this backfill touched it).
--   3. Apply migration 0061, which asserts no row is left with a null
--      email_hash, then drops the plaintext column.
-- An empty `workspace_suppressions` table (e.g. a fresh database) needs no
-- backfill step at all -- 0061's assertion passes trivially with zero rows.
--
-- workspace_suppression_keys: one HMAC key per workspace, envelope-encrypted
-- via @mega-crm/kms exactly as tenant SendGrid keys are (workspace_sendgrid_keys,
-- migration 0001) -- same wrapped-key column shape (encrypted_dek/ciphertext/
-- iv/auth_tag), same per-workspace-secret convention. RLS: FORCE ROW LEVEL
-- SECURITY with the same fail-closed, role-scoped workspace_isolation policy
-- every tenant-secret table gets (mirrors erasure_records/migration 0059's
-- fail-closed-from-birth precedent) -- this is tenant-owned key material, not
-- platform-ops metadata.
CREATE TABLE workspace_suppression_keys (
  workspace_id uuid PRIMARY KEY REFERENCES organization(id) ON DELETE CASCADE,
  encrypted_dek text NOT NULL,
  ciphertext text NOT NULL,
  iv text NOT NULL,
  auth_tag text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE workspace_suppression_keys IS
  'CMP-04/D-02, plan 13-12: one per-workspace HMAC key, envelope-encrypted via @mega-crm/kms (same wrapped shape as workspace_sendgrid_keys). Used to hash addresses before they are written to workspace_suppressions.email_hash. Per-workspace rather than platform-wide so a leaked key confines its blast radius to one tenant''s suppression list. No row for a workspace means that workspace has never suppressed anything -- loadWorkspaceSuppressionKey returns null and callers must treat that as "not suppressed" without creating a row.';

ALTER TABLE workspace_suppression_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_suppression_keys FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON workspace_suppression_keys TO mega_crm_app
  USING (workspace_id = current_setting('app.current_workspace_id')::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id')::uuid);

-- workspace_suppressions: add the hash column set, alongside the still-live
-- plaintext `email` column. `email` becomes nullable here -- a newly
-- suppressed address (post-0060 application code) writes ONLY email_hash,
-- leaving email null on every row created from this point forward, while
-- pre-existing rows keep their plaintext until the backfill runs. The
-- pre-existing (workspace_id, email) unique constraint is left in place
-- unchanged -- dropping it here, before the backfill, would remove the only
-- duplicate-suppression guard protecting rows that have not been hashed yet.
ALTER TABLE workspace_suppressions ADD COLUMN email_hash text;
ALTER TABLE workspace_suppressions ADD COLUMN suppressed_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE workspace_suppressions ADD COLUMN source text;
ALTER TABLE workspace_suppressions ALTER COLUMN email DROP NOT NULL;

-- UNIQUE, not a plain index -- this is the ON CONFLICT (workspace_id,
-- email_hash) target the three write sites (isEmailSuppressed's insert
-- callers) use going forward. Every existing row's email_hash is NULL at
-- this point, and Postgres treats NULL as distinct from every other value
-- in a unique index, so this index is trivially satisfied by any number of
-- not-yet-backfilled rows.
CREATE UNIQUE INDEX workspace_suppressions_workspace_email_hash_unique
  ON workspace_suppressions (workspace_id, email_hash);

COMMENT ON COLUMN workspace_suppressions.email_hash IS
  'CMP-04/D-02, plan 13-12: an HMAC-SHA256 of the normalized (lowercased, trimmed) address under this workspace''s own key (workspace_suppression_keys) -- see packages/contacts-core/src/suppression-hash.ts. The pre-send and pre-create suppression checks compare against this column, never against plaintext, so an erased contact''s address stays unmailable while no plaintext form of it survives anywhere. Null on rows not yet backfilled from the pre-13-12 plaintext column (see migration 0061 and npm run db:rehash-suppressions); non-null and unique per workspace thereafter.';

COMMENT ON COLUMN workspace_suppressions.suppressed_at IS
  'CMP-04/D-02, plan 13-12: when this address was suppressed. Defaults to now() on insert, same semantics as the pre-existing created_at, added under its own name so a future rename/reuse of created_at cannot silently change this column''s meaning.';

COMMENT ON COLUMN workspace_suppressions.source IS
  'CMP-04/D-02, plan 13-12: reserved for a future distinction between how a suppression originated (e.g. manual vs. webhook vs. erasure), separate from the existing free-text reason column. Not yet populated by any write site as of this migration -- nullable, no default.';
