-- Phase 10 (SEC-05, D-04/D-05, plan 10-09 checkpoint option-a) — the Better
-- Auth trust boundary: partitions the seven better-auth tables between a new
-- dedicated login role (`mega_crm_auth`, created but ungranted since
-- migration 0041) and the existing `mega_crm_app` role.
--
-- `organization.id` is the value every one of the 22 tenant `workspace_id`
-- columns FKs to and every `workspace_isolation` RLS policy casts against
-- (see 0044) -- that is why `organization`, `member`, `invitation` and
-- `user` stay app-readable rather than being moved behind the boundary
-- wholesale: `workspace-lookup.ts`, `workspaces.ts`, `invites.ts` and
-- `members.ts` all resolve a workspace/membership/invite/user row through
-- `mega_crm_app` on the ordinary (non-tenant) Drizzle pool, outside any RLS
-- scope (these seven tables carry no RLS at all, see 0001_rls_policies.sql).
-- `session`, `account` and `verification` have no such live read/write site
-- anywhere in apps/api/src outside better-auth's own adapter -- moving them
-- behind an exclusive role removes the highest-value secret-bearing rows in
-- the database (session tokens, OAuth/password material, verification
-- tokens) from every query path except better-auth's.
--
-- `mega_crm_app` OWNS all seven tables (table ownership did not move here --
-- see the plan 10-09 checkpoint, option-c was considered and rejected: it
-- would make migrations, which apply as `mega_crm_app`, unable to alter
-- these tables without a privileged out-of-band step). That means
-- `mega_crm_app` can always `GRANT` these privileges back to itself -- this
-- migration is a boundary against an application bug or an injected query,
-- not against an attacker who already controls a session running as the
-- owning role. Documented in ARCHITECTURE.md §8, not left implicit.
--
-- RLS is deliberately NOT used here, and no policy is added to any of the
-- seven tables: better-auth's Drizzle adapter sets no session GUC (unlike
-- the tenant pool's `app.current_workspace_id`), so a policy on these
-- tables could only key on role -- which a GRANT/REVOKE partition expresses
-- more directly, and without Pitfall 12's failure mode (a naive RLS policy
-- here returns zero rows to every better-auth query with no SQL error,
-- breaking login/signup/session-validation platform-wide silently).

-- `mega_crm_auth`'s adapter performs the full range of data manipulation on
-- every one of the seven tables (better-auth reads, inserts, updates and
-- deletes rows across user/session/account/verification/organization/member/
-- invitation over the lifetime of a single request) -- a narrower grant
-- would fail at an unpredictable point in a flow rather than at boot.
GRANT USAGE ON SCHEMA public TO mega_crm_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON "user", session, account, verification, organization, member, invitation
  TO mega_crm_auth;

-- destructive: session/account/verification hold session tokens, OAuth
-- tokens and password hashes, and password-reset/email-verification tokens
-- respectively -- the highest-value secret-bearing rows in the database.
-- No live query site outside better-auth's own adapter reads or writes any
-- of the three (plan-time audit of apps/api/src, recorded in the plan 10-09
-- checkpoint). Revoking every privilege makes them reachable only through
-- the mega_crm_auth-backed adapter connection from this point forward.
REVOKE ALL PRIVILEGES ON session, account, verification FROM mega_crm_app;

-- destructive: organization/member/invitation/user stay app-readable (see
-- header comment) because workspace-lookup.ts, workspaces.ts, invites.ts and
-- members.ts genuinely read them outside better-auth's own API surface --
-- but the blanket ownership-derived privilege set is revoked first so what
-- remains is exactly what those call sites use, not whatever better-auth's
-- adapter happened to need historically.
REVOKE ALL PRIVILEGES ON organization, member, invitation, "user" FROM mega_crm_app;

-- Re-grant only what the audit of live query sites supports: read access on
-- all four workspace-shaped tables, plus UPDATE on organization for the
-- soft-delete path (workspaces.ts's DELETE /api/workspaces/:slug route sets
-- deletedAt). No INSERT/DELETE on any of the four, and no UPDATE beyond
-- organization -- member-role changes and invitation writes go exclusively
-- through better-auth's own API (auth.api.updateMemberRole/createInvitation/
-- etc.), which runs on the mega_crm_auth connection, not this one.
GRANT SELECT ON organization, member, invitation, "user" TO mega_crm_app;
GRANT UPDATE ON organization TO mega_crm_app;

-- Execution-discovered addition (deviation Rule 1/3, not part of the
-- checkpoint's application-level audit): Postgres enforces every foreign key
-- referencing "user" (account.userId, session.userId, member.userId,
-- invitation.inviterId) with an internal row-locking check
-- (`SELECT ... FOR KEY SHARE`) that runs under the REFERENCING table's OWNER
-- -- mega_crm_app owns account/session/member/invitation, not
-- mega_crm_auth -- regardless of which role's connection performs the
-- INSERT. That lock acquisition requires SELECT *and* UPDATE on "user", not
-- SELECT alone: verified empirically (a plain "SELECT ... FOR KEY SHARE OF
-- x" against "user" fails with `permission denied for table user` for a
-- role holding only SELECT, and a REFERENCES-only grant does not substitute
-- for it either). Without this grant, every mega_crm_auth insert into
-- account/session/member/invitation -- i.e. signup, login-session creation,
-- workspace creation and invite creation -- fails with a 42501 from deep
-- inside better-auth's adapter, breaking the SPEC R3 acceptance gate this
-- migration exists to satisfy. `mega_crm_app` gains no new application-level
-- read/write surface from this grant: no first-party source performs
-- `UPDATE "user"` outside better-auth's own (mega_crm_auth-backed) adapter,
-- and the plan 10-09 checkpoint's SELECT-only conclusion for "user" is
-- unchanged as an application-level fact -- this UPDATE grant exists purely
-- to satisfy Postgres's own FK-enforcement mechanism, which the plan-time
-- audit of live query sites had no way to surface (it audits
-- apps/api/src, not Postgres's constraint-trigger implementation).
GRANT UPDATE ON "user" TO mega_crm_app;

-- Execution-discovered addition (deviation Rule 1/3), a DDL-time sibling of
-- the runtime fix above: `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY
-- REFERENCES organization(id)` requires the issuing role to hold REFERENCES
-- on "organization" -- distinct from the SELECT+UPDATE needed for the
-- runtime RI check above, and checked only at constraint-creation time.
-- Migrations apply as `mega_crm_app`, and `organization.id` is the FK target
-- of every one of the 22 tenant tables (see header comment) plus `member`
-- and `invitation` -- any future migration that needs to add, drop or
-- re-create a foreign key referencing "organization" needs this grant to
-- issue that DDL at all. REFERENCES is a schema-authoring privilege, not a
-- data-access one: it grants no ability to read or write rows.
GRANT REFERENCES ON organization TO mega_crm_app;
