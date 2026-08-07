import { createHash, randomUUID } from "node:crypto";
import { URL } from "node:url";

import { Pool } from "pg";

/**
 * 08-02 (QG-04) — ephemeral test-database provisioning.
 *
 * This module is the only place in Phase 8 with enough privilege to destroy
 * real data, so the destructive half is guarded from the inside: the name
 * validation is the FIRST thing dropEphemeralDatabase does, before any Pool is
 * constructed and before any string reaches SQL. Putting the check at the call
 * site instead would let a future caller bypass it by building the name
 * differently (08-RESEARCH.md § Security Domain).
 *
 * There is deliberately no environment variable, argument or flag that skips
 * the validation.
 */

/** Every ephemeral database must live under this namespace. */
const TEST_DATABASE_PREFIX = "mega_crm_test";

/** Postgres identifiers are limited to 63 bytes. */
const MAX_IDENTIFIER_LENGTH = 63;

/** Only these characters may ever reach a DROP DATABASE statement. */
const SAFE_IDENTIFIER = /^[a-z0-9_]+$/;

const DEFAULT_ADMIN_DSN = "postgres://postgres:postgres@localhost:5432/postgres";
const DEFAULT_APP_ROLE = "mega_crm_app";
const DEFAULT_APP_PASSWORD = "mega_crm_dev_pw";

/**
 * Phase 10 (SEC-01/SEC-05, D-01/D-04) — the two additional least-privilege
 * login roles this phase introduces. Exported so callers (and their own
 * tests) reference the same constant rather than re-typing the role name.
 */
export const SCAN_ROLE = "mega_crm_scan";
export const AUTH_ROLE = "mega_crm_auth";

/**
 * Double-quote a Postgres identifier, doubling any embedded double quote.
 *
 * Exported for direct unit assertion. It is defense in depth, not the primary
 * control — the `SAFE_IDENTIFIER` allow-list already rejects anything with a
 * quote in it — but a quoting helper that is never tested is a quoting helper
 * nobody can trust.
 */
export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function sanitizeSegment(segment: string): string {
  return segment.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

/** Hex characters of content hash appended when the name must be truncated. */
const TRUNCATION_HASH_LENGTH = 8;

/**
 * `mega_crm_test_<workspace>_<runId>` — unique per workspace and per run (D-10),
 * so two concurrent CI runs can never collide on one physical database.
 *
 * 08-REVIEW WR-06: a plain `.slice(0, 63)` has no collision-avoidance step.
 * `TEST_DATABASE_PREFIX + "_"` already consumes 14 of the 63 available bytes,
 * leaving 49 for `<workspace>_<runId>` combined -- two different `runId`s for
 * a sufficiently long `workspace` string can truncate to an IDENTICAL 63-byte
 * name, and `createEphemeralDatabase`'s `dropEphemeralDatabase`-then-create
 * sequence would drop the first run's still-in-use database out from under it.
 * When truncation is needed, the tail is instead a short content hash of the
 * FULL un-truncated name, so any two distinct (workspace, runId) pairs stay
 * distinguishable even after the cut -- rather than merely detecting the
 * collision, this avoids it by construction.
 */
export function buildEphemeralDatabaseName(workspace: string, runId: string): string {
  const name = `${TEST_DATABASE_PREFIX}_${sanitizeSegment(workspace)}_${sanitizeSegment(runId)}`;
  if (name.length <= MAX_IDENTIFIER_LENGTH) return name;

  const hash = createHash("sha256").update(name).digest("hex").slice(0, TRUNCATION_HASH_LENGTH);
  const keepLength = MAX_IDENTIFIER_LENGTH - TRUNCATION_HASH_LENGTH - 1; // -1 for the "_" separator
  return `${name.slice(0, keepLength)}_${hash}`;
}

function resolveAdminDsn(explicit?: string): string {
  return explicit ?? process.env.TEST_ADMIN_DATABASE_URL ?? DEFAULT_ADMIN_DSN;
}

/**
 * Phase 10 (SEC-01/SEC-05, D-01/D-04) — ensure the two cluster-level login
 * roles this phase introduces exist, idempotently.
 *
 * Mirrors `scripts/ensure-db-roles.mjs`'s DO-block shape and
 * `docker/init-app-role.sql`'s role definition exactly (NOSUPERUSER
 * NOCREATEDB NOCREATEROLE NOBYPASSRLS). Called from `createEphemeralDatabase`
 * below so every ephemeral test database is provisioned against a cluster
 * that already has both roles, the same way a fresh docker-compose volume
 * does via `docker/init-app-role.sql` (RESEARCH.md Pitfall 5: role creation
 * cannot live inside a numbered migration, and CI's runner always starts
 * from a fresh volume where a stale-volume gap can't occur — but a
 * developer's long-lived local Postgres, exercised by this same test path,
 * can).
 */
export async function ensureClusterRoles(adminDsn?: string): Promise<void> {
  const pool = new Pool({ connectionString: resolveAdminDsn(adminDsn) });
  try {
    for (const role of [SCAN_ROLE, AUTH_ROLE]) {
      const { rows } = await pool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
      if (rows.length > 0) continue;

      // Role names are module constants (SCAN_ROLE/AUTH_ROLE), never
      // caller-supplied -- no injection surface in this literal interpolation.
      await pool.query(
        `CREATE ROLE ${role} WITH LOGIN PASSWORD 'mega_crm_dev_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
      );
    }
  } finally {
    await pool.end();
  }
}

/**
 * Build a role-scoped DSN for a database by swapping the admin DSN's
 * credentials and pathname.
 *
 * Generalized from the former `buildAppDsn` (Phase 10, D-01/D-04): the same
 * swap-credentials-and-pathname shape now serves the app role, the scan role
 * and the auth role, since all three connect to the same physical database
 * under different identities.
 */
export function buildRoleDsn(
  adminDsn: string,
  databaseName: string,
  role: string,
  password: string,
): string {
  const url = new URL(adminDsn);
  url.username = role;
  url.password = password;
  url.pathname = `/${databaseName}`;
  return url.toString();
}

/**
 * Build the app-role DSN for a freshly created database.
 *
 * Returning an app-role DSN rather than the admin one is load-bearing: under a
 * superuser DSN Row-Level Security is not enforced, and every RLS assertion in
 * the existing suites would silently become vacuous (D-11).
 */
function buildAppDsn(adminDsn: string, databaseName: string): string {
  return buildRoleDsn(
    adminDsn,
    databaseName,
    DEFAULT_APP_ROLE,
    process.env.TEST_APP_DB_PASSWORD ?? DEFAULT_APP_PASSWORD,
  );
}

/**
 * Reject any database name outside the test namespace.
 *
 * Called as the first statement of dropEphemeralDatabase — before a Pool
 * exists, before interpolation — so no argument can route around it.
 */
function assertDroppableName(databaseName: string): void {
  // Deliberately the SAME prefix rule as guard.ts's — `startsWith`, not
  // `startsWith(prefix + "_")`. A stricter rule here would refuse to drop a
  // database the guard happily accepts (e.g. `mega_crm_testing_ground`),
  // leaking it forever. The two rules must agree or teardown silently fails.
  if (!databaseName.startsWith(TEST_DATABASE_PREFIX)) {
    throw new Error(
      `REFUSED: will not drop "${databaseName}" — it is outside the ${TEST_DATABASE_PREFIX} namespace.`,
    );
  }
  if (!SAFE_IDENTIFIER.test(databaseName)) {
    throw new Error(
      `REFUSED: will not drop "${databaseName}" — the name contains characters outside [a-z0-9_].`,
    );
  }
}

export async function dropEphemeralDatabase(
  databaseName: string,
  adminDsn?: string,
): Promise<void> {
  // FIRST statement — no connection, no interpolation before this point.
  assertDroppableName(databaseName);

  const pool = new Pool({ connectionString: resolveAdminDsn(adminDsn) });
  try {
    // Terminate other backends first: DROP DATABASE fails while sessions are
    // still attached, which is the normal state right after a test run.
    await pool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [databaseName],
    );
    await pool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
  } finally {
    await pool.end();
  }
}

export async function createEphemeralDatabase(options: {
  workspace: string;
  runId?: string;
}): Promise<{ databaseName: string; dsn: string; adminDsn: string }> {
  const adminDsn = resolveAdminDsn();
  const runId = options.runId ?? process.env.GSD_TEST_RUN_ID ?? randomUUID().slice(0, 8);
  const databaseName = buildEphemeralDatabaseName(options.workspace, runId);

  // Phase 10: the two new cluster roles must exist before the migration
  // chain's GRANT statements run against this database (0041 onward).
  await ensureClusterRoles(adminDsn);

  // Reuse the guarded drop path rather than issuing a raw DROP here, so the
  // namespace check applies to creation's cleanup too.
  await dropEphemeralDatabase(databaseName, adminDsn);

  const pool = new Pool({ connectionString: adminDsn });
  try {
    // DEFAULT_APP_ROLE is a module constant, never caller-supplied, so the
    // literal role name here carries no injection surface.
    await pool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)} OWNER mega_crm_app`);
  } finally {
    await pool.end();
  }

  return { databaseName, dsn: buildAppDsn(adminDsn, databaseName), adminDsn };
}
