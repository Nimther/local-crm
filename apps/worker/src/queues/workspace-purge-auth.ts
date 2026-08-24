import type { Pool, PoolClient } from "pg";
import { createPgPool } from "@mega-crm/db/src/pool.js";

/**
 * Phase 22 (PRG-02, D-12, plan 22-07): the ONE part of the workspace purge
 * that structurally cannot run on the worker's ordinary `mega_crm_app`
 * connection. Migration 0045 revoked every privilege `mega_crm_app` held on
 * `organization`/`member`/`invitation`/`user` and re-granted only `SELECT`
 * on all four plus `UPDATE` on `organization` -- the Phase 10 Better Auth
 * trust boundary. A plain delete against `member`/`invitation` through
 * that connection fails with Postgres permission-denied `42501`.
 *
 * PT-01 is resolved here as option (b): a dedicated pool authenticated as
 * the existing `mega_crm_auth` role (migration 0045 already grants it
 * SELECT/INSERT/UPDATE/DELETE on all seven Better Auth tables), rather than
 * a migration widening `mega_crm_app`'s own grants. Reusing a role that
 * already holds exactly these privileges keeps the blast-radius argument
 * that made the boundary worth having in the first place -- see this plan's
 * own `<objective>` for the full tradeoff.
 *
 * `AUTH_DATABASE_URL` is read LAZILY, at call time inside `createAuthPurgePool`,
 * never at module load and never added to `apps/worker/src/env.ts`'s boot
 * schema -- mirrors `packages/tenant-context/src/scan.ts`'s `getScanPool`
 * pattern and its own stated reason: a process's env schema that does not
 * declare a credential must not be able to crash an unrelated boot over it.
 * Most worker boots never purge a workspace in their lifetime; forcing every
 * one of them to carry this DSN would be exactly backwards.
 */

let authPurgePool: Pool | undefined;

/**
 * Builds (once) and memoises the dedicated `mega_crm_auth` pool this
 * module's two deletes run on. Never falls back to `DATABASE_URL`/`mega_crm_app`
 * -- a silent fallback would surface as a `42501` mid-purge instead of a
 * clear, actionable configuration error at the moment this function is
 * first called.
 */
export function createAuthPurgePool(): Pool {
  if (!authPurgePool) {
    const authDatabaseUrl = process.env.AUTH_DATABASE_URL;
    if (!authDatabaseUrl || authDatabaseUrl.trim() === "") {
      throw new Error(
        "AUTH_DATABASE_URL is required to purge a workspace's member/invitation rows -- " +
          "it must be the mega_crm_auth DSN, the only database role holding DELETE on " +
          "those two Better Auth tables (migration 0045). Refusing to fall back to " +
          "DATABASE_URL/mega_crm_app: that connection would fail the delete with a " +
          "Postgres 42501 mid-purge instead of failing loudly here.",
      );
    }
    // Distinct pool name (never "db"/"auth"/"tenant-context") so this
    // connection is identifiable in connection-level observability as the
    // purge worker's own elevated credential, not confused with
    // `packages/db/src/index.ts`'s own lazily-built `authDb` pool (named
    // "auth"), which apps/api's better-auth adapter owns.
    authPurgePool = createPgPool({ connectionString: authDatabaseUrl, name: "worker-workspace-purge-auth" });
  }
  return authPurgePool;
}

/** Worker shutdown path only. A no-op when the pool was never created -- the common case, since most worker processes never purge a workspace. */
export async function closeAuthPurgePool(): Promise<void> {
  if (authPurgePool) {
    const pool = authPurgePool;
    authPurgePool = undefined;
    await pool.end();
  }
}

export interface WorkspaceAuthPurgeCounts {
  memberCount: number;
  invitationCount: number;
}

/**
 * Gap-closure plan 22-11 (PRG-02): counts `member`/`invitation` rows for a
 * workspace on the ORDINARY platform client -- a plain `Pool | PoolClient`
 * from `pg`, the SAME `workspacePurgePool` `workspace-purge.worker.ts`
 * already uses for everything else, NEVER `createAuthPurgePool()`. Migration
 * 0045 grants `mega_crm_app` `SELECT` on `member`/`invitation` (the same
 * grant `workspace-purge-auth.test.ts`'s and
 * `workspace-purge-resume.test.ts`'s own `memberCount`/`invitationCount`
 * fixture helpers already rely on), so no new grant and no migration is
 * needed to read these counts before the destructive delete.
 *
 * This function must NEVER be moved onto the elevated `mega_crm_auth` pool.
 * `deleteWorkspaceAuthRows` below issues EXACTLY TWO statements against
 * EXACTLY TWO tables on that connection -- that narrowness is the entire
 * justification for holding the elevated credential in the first place.
 * Adding a third statement (even a read-only `count(*)`) to that pool would
 * silently widen the audited blast radius this module's own header comment
 * exists to bound.
 */
export async function countWorkspaceAuthRows(
  client: Pool | PoolClient,
  workspaceId: string,
): Promise<WorkspaceAuthPurgeCounts> {
  const { rows: memberRows } = await client.query<{ count: string }>(
    `SELECT count(*) AS count FROM member WHERE "organizationId" = $1`,
    [workspaceId],
  );
  const { rows: invitationRows } = await client.query<{ count: string }>(
    `SELECT count(*) AS count FROM invitation WHERE "organizationId" = $1`,
    [workspaceId],
  );
  return {
    memberCount: Number(memberRows[0]?.count ?? 0),
    invitationCount: Number(invitationRows[0]?.count ?? 0),
  };
}

/**
 * The entire justification for holding the `mega_crm_auth` credential is
 * that its use is narrow enough to audit at a glance: this function issues
 * EXACTLY TWO statements, in ONE transaction, against EXACTLY TWO tables
 * (`invitation` then `member`), both scoped to `workspaceId`. Nothing else
 * may ever run on this connection -- no reads of tenant tables, no
 * `user`/`session`/`account` statement, no `organization` update. `user`,
 * `session` and `account` are deliberately never touched here: a user left
 * with zero workspaces simply has an empty workspace list, and deleting the
 * global identity itself is an explicitly deferred idea for this phase (it
 * races with signups and touches the auth trust boundary on its own terms).
 */
export async function deleteWorkspaceAuthRows(workspaceId: string): Promise<WorkspaceAuthPurgeCounts> {
  const pool = createAuthPurgePool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const invitationResult = await client.query(`DELETE FROM invitation WHERE "organizationId" = $1`, [workspaceId]);
    const memberResult = await client.query(`DELETE FROM member WHERE "organizationId" = $1`, [workspaceId]);
    await client.query("COMMIT");
    return {
      invitationCount: invitationResult.rowCount ?? 0,
      memberCount: memberResult.rowCount ?? 0,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
