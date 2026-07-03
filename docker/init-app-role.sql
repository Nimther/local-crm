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
