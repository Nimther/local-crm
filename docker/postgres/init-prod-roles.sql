-- Phase 14 plan 08 (D-01, D-04/SEC-05, DB-13, T-14-51). Production
-- equivalent of docker/init-app-role.sql -- but combined with
-- scripts/ensure-db-roles.mjs's catch-up step into ONE file, because a
-- production Postgres data volume is ALWAYS freshly initialized (there is
-- no developer machine to run a second "ensure roles exist on an old
-- volume" pass the way `predev` does locally). This file must create the
-- full role set docker-entrypoint-initdb.d will ever need to create, in one
-- first-boot pass, or a role silently never exists in production.
--
-- Runs once, automatically, the FIRST time the `db` service's data volume is
-- initialized (RESEARCH.md Pitfall 5 -- docker-entrypoint-initdb.d scripts
-- never re-run against an existing volume). Idempotent regardless -- proven
-- directly against a local Postgres, not assumed: every CREATE ROLE below
-- is a `SELECT ... WHERE NOT EXISTS (...) \gexec` that executes ZERO
-- commands on a second run, and ALTER DATABASE OWNER / GRANT ALL PRIVILEGES
-- are naturally idempotent Postgres operations.
--
-- Deliberately NOT `DO $$ ... $$` / `IF NOT EXISTS THEN ... END IF` blocks,
-- even though that reads more naturally: psql's own `:'var'` variable
-- substitution (used below to inject each password) is a LEXICAL rewrite of
-- the raw SQL text BEFORE it is sent to the server, and psql's lexer treats
-- a dollar-quoted `$$...$$` body as an OPAQUE string it does not scan for
-- `:name` tokens at all -- confirmed empirically against this sandbox's own
-- Homebrew psql 17.10 (`RAISE NOTICE '%', :'app_password';` inside a real
-- `DO $$ ... $$` block fails with "syntax error at or near ':'", while the
-- identical substitution at top level works). The `\gexec` pattern below
-- keeps every `:'var'` reference at TOP LEVEL psql SQL text, outside any
-- dollar-quoted body, which is what actually makes the substitution apply.
--
-- Passwords are NEVER embedded here. `\getenv` (a native psql meta-command,
-- available since Postgres 9.4 -- not a shell/sed substitution this repo
-- would have to maintain separately) reads each one from the SAME process
-- environment docker-entrypoint.sh's `psql -f` invocation already runs
-- inside, i.e. the `db` service's own container environment
-- (docker-compose.prod.yml's `environment:` block, populated at deploy time
-- from the operator's externally-resolved env file -- see
-- docs/runbooks/production-topology.md). Each `\getenv` is followed by a
-- `\if :{?var}` presence check that raises a real SQL exception (failing
-- initdb loudly under the `ON_ERROR_STOP=1` the official postgres image's
-- own docker-entrypoint.sh always passes when running
-- docker-entrypoint-initdb.d/*.sql) rather than silently creating a role
-- with a blank password if the operator forgot to set one -- consistent
-- with this repo's fail-loud convention elsewhere (see
-- docker/pg-tls-entrypoint.sh's `openssl` presence check).
--
-- Deliberately NOT `\quit 1` -- tested directly against this sandbox's
-- Homebrew psql 17.10 and found that `\quit` does not accept (or honor) a
-- numeric exit-code argument at all ("extra argument \"1\" ignored") and
-- still exits 0, which would make docker-entrypoint.sh treat a tripped
-- guard as a SUCCESSFUL initdb -- the opposite of fail-loud. A real
-- `RAISE EXCEPTION` inside a variable-free `DO` block (no `:'var'`
-- substitution needed inside it, so the dollar-quote opacity problem this
-- file's header describes does not apply here) is what actually propagates
-- as psql's own reported ERROR and a non-zero process exit code --
-- re-verified empirically after finding the `\quit` bug, not assumed.

-- WR-02: `\if :{?var}` alone only detects an UNSET psql variable. But
-- docker-compose.prod.yml delivers these as `VAR: ${VAR}` -- if the
-- operator's env file never sets the value, Compose's own `${VAR}`
-- substitution resolves to an empty string, so the container's env var is
-- SET (to ""), not absent, and `\getenv` succeeds with a defined-but-empty
-- variable that this file's own stated guard ("refuse to create a role
-- with a blank password") must still catch. Each guard below therefore
-- checks BOTH conditions: unset (`\else` branch of `\if :{?var}`, checked
-- client-side, no query needed) and set-but-empty (`SELECT (:'var' = '')
-- \gset`, only run once the variable is confirmed defined, so the `:'var'`
-- substitution below is guaranteed to actually happen rather than leaving
-- literal `:'var'` text in the query for the server to choke on).
\getenv app_password MEGA_CRM_APP_PASSWORD
\if :{?app_password}
  SELECT (:'app_password' = '') AS is_blank \gset
\else
  \set is_blank 't'
\endif
\if :is_blank
  DO $guard$ BEGIN RAISE EXCEPTION 'init-prod-roles: MEGA_CRM_APP_PASSWORD is unset or empty -- refusing to create mega_crm_app with a blank password.'; END $guard$;
\endif

\getenv scan_password MEGA_CRM_SCAN_PASSWORD
\if :{?scan_password}
  SELECT (:'scan_password' = '') AS is_blank \gset
\else
  \set is_blank 't'
\endif
\if :is_blank
  DO $guard$ BEGIN RAISE EXCEPTION 'init-prod-roles: MEGA_CRM_SCAN_PASSWORD is unset or empty -- refusing to create mega_crm_scan with a blank password.'; END $guard$;
\endif

\getenv auth_password MEGA_CRM_AUTH_PASSWORD
\if :{?auth_password}
  SELECT (:'auth_password' = '') AS is_blank \gset
\else
  \set is_blank 't'
\endif
\if :is_blank
  DO $guard$ BEGIN RAISE EXCEPTION 'init-prod-roles: MEGA_CRM_AUTH_PASSWORD is unset or empty -- refusing to create mega_crm_auth with a blank password.'; END $guard$;
\endif

-- mega_crm_app: the primary application role (DATABASE_URL). NEVER
-- BYPASSRLS -- see docker/init-app-role.sql's own comment; Row-Level
-- Security silently stops protecting tenant data otherwise
-- (packages/db/migrations/0001_rls_policies.sql). quote_literal() (not
-- format's %L, since there is no DO block to run format() inside) does the
-- same SQL-injection-safe quoting of the psql-substituted password value.
SELECT 'CREATE ROLE mega_crm_app WITH LOGIN PASSWORD ' || quote_literal(:'app_password') ||
       ' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS'
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mega_crm_app')
\gexec

-- current_database() rather than a hardcoded literal -- this file must work
-- whatever POSTGRES_DB the operator's env file names, unlike dev's fixed
-- "mega_crm". Unconditional (not \gexec-guarded by an existence check) --
-- ALTER DATABASE ... OWNER and GRANT ALL PRIVILEGES are themselves
-- idempotent, so re-asserting them on every run is correct, not wasteful.
SELECT format('ALTER DATABASE %I OWNER TO mega_crm_app', current_database())
\gexec
SELECT format('GRANT ALL PRIVILEGES ON DATABASE %I TO mega_crm_app', current_database())
\gexec

-- Phase 10 (SEC-01/SEC-02, D-01): least-privilege login role for
-- cross-workspace background scans (packages/tenant-context/src/scan.ts's
-- withCrossWorkspaceScan). NOBYPASSRLS and NO database-owner grant -- this
-- role's visibility is entirely determined by explicit per-table GRANTs plus
-- role-scoped RLS policies added in migration 0041 onward, never by owning
-- anything or bypassing RLS. Connect privilege comes from PUBLIC's default;
-- no ALTER DATABASE ... OWNER, no GRANT ALL PRIVILEGES ON DATABASE -- exactly
-- mirroring docker/init-app-role.sql's own restriction.
SELECT 'CREATE ROLE mega_crm_scan WITH LOGIN PASSWORD ' || quote_literal(:'scan_password') ||
       ' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS'
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mega_crm_scan')
\gexec

-- Phase 10 (SEC-05, D-04): least-privilege login role for Better Auth's
-- drizzleAdapter pool. Same restriction as mega_crm_scan above -- not yet
-- granted anything until the grant matrix that wires it (see
-- docker/init-app-role.sql's own comment for the dev-side precedent).
SELECT 'CREATE ROLE mega_crm_auth WITH LOGIN PASSWORD ' || quote_literal(:'auth_password') ||
       ' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS'
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mega_crm_auth')
\gexec
