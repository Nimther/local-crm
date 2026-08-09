#!/usr/bin/env node
// Phase 10 (SEC-01/SEC-02, D-01/D-04) — idempotent cluster-role bootstrap for
// EXISTING Postgres data volumes.
//
// docker/init-app-role.sql only runs on a container's FIRST volume
// initialization (RESEARCH.md Pitfall 5) -- extending it with
// `CREATE ROLE mega_crm_scan` / `CREATE ROLE mega_crm_auth` does NOT
// retroactively create those roles for any developer or environment with an
// existing mega_crm_db_data volume. This script closes that gap: it runs the
// same idempotent `CREATE ROLE ... IF NOT EXISTS` blocks against a superuser
// DSN, so it is safe to run against a fresh volume (roles already exist,
// no-op) or a stale one (roles get created).
//
// Wired as the first step of the root `predev` npm script (before
// scripts/migrate-dev.mjs) so migration 0041's GRANT statements never hit a
// missing role.
//
// No dependencies beyond `pg` -- mirrors scripts/lint-migrations.mjs's
// no-framework style.

import { Client } from "pg";

import { resolveEnvPath } from "./env-path.mjs";

// GSD 10-15 (gap G-10-1): recurrence of the 08-07 failure class
// (SPECIFICATION.md:107) -- the TEST_ADMIN_DATABASE_URL-override convention
// was copied from provision-db.ts without the env-loading half of the
// pattern, so this script's admin DSN was invisible to the external env
// file every sibling DSN consumer (check-env.mjs, migrate-dev.mjs) already
// loads. Mirrors migrate-dev.mjs's exact shape. Kept at module scope, before
// DEFAULT_ADMIN_DSN/resolveAdminDsn, so resolveAdminDsn() can never run
// before process.env is populated. The catch branch exists so a machine
// with no file (e.g. CI, which exports variables directly) keeps working
// from already-exported variables.
try {
  process.loadEnvFile(resolveEnvPath());
} catch {
  // .env not present -- rely on already-exported environment variables
}

const DEFAULT_ADMIN_DSN = "postgres://postgres:postgres@localhost:5432/postgres";

function resolveAdminDsn() {
  return process.env.GSD_ADMIN_DATABASE_URL || process.env.TEST_ADMIN_DATABASE_URL || DEFAULT_ADMIN_DSN;
}

/**
 * The two roles this phase introduces. Password matches the existing
 * `mega_crm_app` dev convention (docker/init-app-role.sql) -- local dev only,
 * production DSNs carry their own secrets (Threat T-10-01-06, accepted).
 */
const ROLES = [
  { name: "mega_crm_scan", password: "mega_crm_dev_pw" },
  { name: "mega_crm_auth", password: "mega_crm_dev_pw" },
];

async function ensureRole(client, role) {
  const { rows } = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role.name]);
  if (rows.length > 0) {
    return { name: role.name, created: false };
  }

  // Role name/password are module constants, never caller-supplied -- no
  // injection surface, but password still can't be a bind parameter inside
  // CREATE ROLE, so it is inlined via a literal-safe (no quote in it) constant.
  await client.query(
    `CREATE ROLE ${role.name} WITH LOGIN PASSWORD '${role.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
  );
  return { name: role.name, created: true };
}

async function main() {
  const adminDsn = resolveAdminDsn();
  const client = new Client({ connectionString: adminDsn });
  await client.connect();

  try {
    const results = [];
    for (const role of ROLES) {
      results.push(await ensureRole(client, role));
    }

    for (const result of results) {
      console.log(`db:roles — ${result.name}: ${result.created ? "created" : "already exists"}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("db:roles failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
