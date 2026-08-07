-- Phase 10 plan 10-10 (SEC-06, D-06/D-07) -- `workspace_api_keys.scopes`
-- moves from "reserved for v2 and unused" to an enforced set-membership
-- check on every API-key route (contacts:read, contacts:write,
-- events:write). The backfill below and the start of enforcement (this
-- migration plus `requireApiKeyScope` in apps/api/src/modules/api-keys/
-- api-key-auth.ts) ship in the SAME change per D-07: every key that
-- predates enforcement keeps every capability it already had, because the
-- column has always defaulted to an empty array (never actually checked
-- anywhere until this plan) -- enforcing scope checks before this backfill
-- ran would 403 every existing tenant integration on its very next request.
-- The empty-scope refusal this plan introduces therefore only ever applies
-- to a key deliberately stripped of scopes after this point.
--
-- Execution-discovered addition (deviation Rule 3): migration 0044 made
-- EVERY `workspace_isolation` policy fail-closed -- `current_setting('app.
-- current_workspace_id')` with no `missing_ok` argument, which RAISES when
-- the GUC was never set in the session at all, rather than returning NULL.
-- A migration file applies as a single `mega_crm_app` client with no tenant
-- context ever set, and `workspace_api_keys` carries FORCE ROW LEVEL
-- SECURITY (0006) -- FORCE means even the owning role (mega_crm_app) is
-- subject to the policy, so the bare backfill UPDATE above would raise
-- "unrecognized configuration parameter" for every row, on every workspace,
-- unconditionally (verified empirically against this migration chain).
-- The backfill is deliberately workspace-UNSCOPED (every tenant's keys),
-- so there is no single `app.current_workspace_id` value that would let it
-- pass the policy honestly -- disabling RLS for the span of this one
-- statement, inside this migration's single implicit transaction, is the
-- narrowest fix: no new role, no session GUC, and FORCE is restored before
-- the transaction (and therefore the migration) commits, so no window
-- where a concurrent connection could observe RLS as disabled on this
-- table.
ALTER TABLE workspace_api_keys DISABLE ROW LEVEL SECURITY;

UPDATE workspace_api_keys
SET scopes = ARRAY['contacts:read', 'contacts:write', 'events:write']
WHERE scopes = '{}' OR scopes IS NULL;

ALTER TABLE workspace_api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_api_keys FORCE ROW LEVEL SECURITY;

-- New keys default to the full set, since this phase ships no scope-picker
-- UI (D-07 defers it) -- narrowing scopes per key is a future-phase feature.
ALTER TABLE workspace_api_keys
  ALTER COLUMN scopes SET DEFAULT ARRAY['contacts:read', 'contacts:write', 'events:write'];
