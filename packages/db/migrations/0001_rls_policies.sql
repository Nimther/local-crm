-- Row-Level Security for every tenant-scoped domain table (TENANT-05).
--
-- Enforced via `current_setting('app.current_workspace_id', true)::uuid`,
-- populated per-transaction by apps/api/src/middleware/tenant-context.ts
-- using `SET LOCAL` (never plain `SET`) inside an AsyncLocalStorage-scoped
-- request context. This is the last line of defense against a missed
-- `WHERE workspace_id = ...` clause anywhere in application code — see
-- 01-RESEARCH.md Pitfall 1 / Pattern 2.
--
-- IMPORTANT: better-auth's own tables (user, session, account, verification,
-- organization, member, invitation) are deliberately NOT covered here —
-- better-auth queries them outside the tenant transaction and scopes access
-- via the session's active-organization membership instead (see
-- SKELETON.md "Out of Scope"). Every future tenant-scoped domain table
-- (contacts, events, segments, campaigns, flows, ...) must get the same
-- ENABLE ROW LEVEL SECURITY + workspace_isolation policy shape as below.

ALTER TABLE workspace_sendgrid_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON workspace_sendgrid_keys
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id', true)::uuid);
