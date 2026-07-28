import { randomUUID } from "node:crypto";
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

/**
 * `mega_crm_test_<workspace>_<runId>` — unique per workspace and per run (D-10),
 * so two concurrent CI runs can never collide on one physical database.
 */
export function buildEphemeralDatabaseName(workspace: string, runId: string): string {
  const name = `${TEST_DATABASE_PREFIX}_${sanitizeSegment(workspace)}_${sanitizeSegment(runId)}`;
  return name.slice(0, MAX_IDENTIFIER_LENGTH);
}

function resolveAdminDsn(explicit?: string): string {
  return explicit ?? process.env.TEST_ADMIN_DATABASE_URL ?? DEFAULT_ADMIN_DSN;
}

/**
 * Build the app-role DSN for a freshly created database by swapping the admin
 * DSN's credentials and pathname.
 *
 * Returning an app-role DSN rather than the admin one is load-bearing: under a
 * superuser DSN Row-Level Security is not enforced, and every RLS assertion in
 * the existing suites would silently become vacuous (D-11).
 */
function buildAppDsn(adminDsn: string, databaseName: string): string {
  const url = new URL(adminDsn);
  url.username = DEFAULT_APP_ROLE;
  url.password = process.env.TEST_APP_DB_PASSWORD ?? DEFAULT_APP_PASSWORD;
  url.pathname = `/${databaseName}`;
  return url.toString();
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
