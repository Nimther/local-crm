-- Runs once when the docker-compose `db` service's data volume is first
-- initialized. Creates the non-superuser application role that every
-- environment (local Postgres or docker-compose) must use for
-- DATABASE_URL — the app role must NEVER have BYPASSRLS, or Row-Level
-- Security silently stops protecting tenant data (see
-- packages/db/migrations/0001_rls_policies.sql).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mega_crm_app') THEN
    CREATE ROLE mega_crm_app WITH LOGIN PASSWORD 'mega_crm_dev_pw'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

ALTER DATABASE mega_crm OWNER TO mega_crm_app;
GRANT ALL PRIVILEGES ON DATABASE mega_crm TO mega_crm_app;

-- Phase 10 (SEC-01/SEC-02, D-01): least-privilege login role for
-- cross-workspace background scans (packages/tenant-context/src/scan.ts's
-- withCrossWorkspaceScan). NOBYPASSRLS and NO database-owner grant -- this
-- role's visibility is entirely determined by explicit per-table GRANTs plus
-- role-scoped RLS policies added in migration 0041 onward, never by owning
-- anything or bypassing RLS. Connect privilege comes from PUBLIC's default;
-- no ALTER DATABASE ... OWNER, no GRANT ALL PRIVILEGES ON DATABASE.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mega_crm_scan') THEN
    CREATE ROLE mega_crm_scan WITH LOGIN PASSWORD 'mega_crm_dev_pw'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

-- Phase 10 (SEC-05, D-04): least-privilege login role for Better Auth's
-- drizzleAdapter pool. Created here (not a numbered migration -- see
-- scripts/ensure-db-roles.mjs) alongside mega_crm_scan; not yet granted
-- anything until the plan that wires the auth-role grant matrix.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mega_crm_auth') THEN
    CREATE ROLE mega_crm_auth WITH LOGIN PASSWORD 'mega_crm_dev_pw'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;
