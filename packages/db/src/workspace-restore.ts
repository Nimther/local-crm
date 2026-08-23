import type { Pool, PoolClient } from "pg";
import { createPgPool } from "./pool.js";
import { PURGE_ADVISORY_LOCK_NAMESPACE } from "./workspace-purge-tables.js";

/**
 * Phase 22 (PRG-05, D-13/D-14/D-15, plan 22-06): the restore half of the
 * report-then-destroy purge state machine 22-01 built. `restoreWorkspace`
 * un-deletes a workspace -- clears `organization."deletedAt"` -- at any
 * point before the purge's first destructive batch, and refuses the moment
 * that batch has run. Nothing on this function's parameter list relaxes
 * that refusal: a partially destroyed workspace must never come back live
 * (D-14), so the one guarantee this file exists to provide has no escape
 * hatch to defeat it.
 *
 * D-14's boundary is a check-then-act pair against `purge_records`, and the
 * purge worker (apps/worker/src/queues/workspace-purge.worker.ts) reads and
 * writes that same row from a separate process. Two independent reads of
 * "has the purge started yet" can race each other, so this function takes
 * the SAME per-workspace advisory lock (`PURGE_ADVISORY_LOCK_NAMESPACE`,
 * `pg_try_advisory_lock(namespace, hashtext(workspaceId))`) the purge's own
 * `runWorkspacePurgeWalk` takes before its first destructive batch --
 * imported from `workspace-purge-tables.js`, never re-typed, because two
 * literal copies of the same magic number is a rename bug waiting to
 * happen. Whichever side takes the lock first decides the outcome: this
 * side refuses if it loses, and the purge's own single-flight guard (22-01,
 * unchanged by this file) skips without stamping anything if it loses.
 * `pg_try_advisory_lock` never waits -- a purge holding the lock means this
 * call refuses immediately rather than queuing behind however long that
 * purge takes (T-22-06-05, accepted risk).
 *
 * D-15: an overdue `scheduled` campaign is flipped to `draft` inside the
 * SAME transaction that clears `deletedAt`, not as a follow-up write and not
 * left to the campaign scheduler's own re-check. A restore that only clears
 * `deletedAt` and trusts the scheduler's next tick leaves a window between
 * this transaction's commit and that tick in which an overdue campaign is
 * both live and due -- and surprise mail is worse than surprise silence.
 * The flip is narrow: only `scheduled` campaigns whose `scheduled_at` has
 * already passed. A future-dated schedule is still the tenant's own intent,
 * and every other campaign status is not this decision's business.
 *
 * Everything above runs on ONE dedicated connection, in ONE transaction:
 * the advisory-lock probe, the `organization`/`purge_records` reads, the
 * `deletedAt` clear and the campaign flip. `campaigns` carries a fail-closed
 * `workspace_isolation` RLS policy (migration 0044) -- this function is not
 * request-scoped and has no `@mega-crm/tenant-context` transaction to ride
 * on (that package depends on `@mega-crm/db`, not the other way around), so
 * it binds `app.current_workspace_id` itself via `set_config(..., true)`
 * (`SET LOCAL` semantics, scoped to this one transaction) immediately before
 * issuing the campaign UPDATE -- the same mechanism `withTenantTransaction`
 * uses, run directly here because this package cannot import that one.
 */

/** Thrown when `organization` has no row for this id, or its `deletedAt` is already null. */
export class WorkspaceNotDeletedError extends Error {
  constructor(workspaceId: string) {
    super(
      `workspace ${workspaceId} cannot be restored: it is not currently soft-deleted ` +
        `(no organization row, or "deletedAt" is already null)`,
    );
    this.name = "WorkspaceNotDeletedError";
  }
}

/**
 * Thrown either because the purge's `first_destructive_batch_at` is already
 * set (past the point of no return, permanent and unconditional -- D-14),
 * or because a purge currently holds this workspace's advisory lock
 * (T-22-06-05 -- this call never waits, the caller may simply retry).
 */
export class WorkspacePurgeStartedError extends Error {
  constructor(workspaceId: string, reason: string) {
    super(`workspace ${workspaceId} cannot be restored: ${reason}`);
    this.name = "WorkspacePurgeStartedError";
  }
}

export interface RestoreWorkspaceResult {
  workspaceId: string;
  restoredAt: Date;
  /** Ids of the `scheduled` campaigns whose `scheduled_at` had already passed -- flipped to `draft` in this same transaction (D-15). */
  campaignsFlippedToDraft: string[];
}

export interface RestoreWorkspaceDeps {
  pool?: Pool;
}

let defaultRestorePool: Pool | undefined;

/**
 * Lazily built -- mirrors `packages/db/src/index.ts`'s own `getAuthDb()`
 * pattern: constructed on first use from `DATABASE_URL` read at CALL time,
 * not at module load, so importing this module never requires the env var
 * to already be set. `packages/db/scripts/restore-workspace.ts` loads its
 * own `.env` file before calling `restoreWorkspace`, same as every other
 * operator CLI in this package.
 */
function getDefaultRestorePool(): Pool {
  if (!defaultRestorePool) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL must be set to construct the default workspace-restore pool");
    }
    defaultRestorePool = createPgPool({ connectionString: databaseUrl, name: "workspace-restore" });
  }
  return defaultRestorePool;
}

interface OrganizationDeletedAtRow {
  deletedAt: Date | null;
}

interface PurgeRecordGuardRow {
  firstDestructiveBatchAt: Date | null;
}

/**
 * Un-deletes `workspaceId`: clears `organization."deletedAt"` and flips any
 * overdue `scheduled` campaign to `draft`, both in one transaction, guarded
 * by the purge's own advisory lock. See this module's header comment for
 * the full sequence rationale.
 */
export async function restoreWorkspace(
  workspaceId: string,
  deps: RestoreWorkspaceDeps = {},
): Promise<RestoreWorkspaceResult> {
  const pool = deps.pool ?? getDefaultRestorePool();
  const client: PoolClient = await pool.connect();
  let locked = false;

  try {
    const { rows: lockRows } = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock($1, hashtext($2)) AS locked`,
      [PURGE_ADVISORY_LOCK_NAMESPACE, workspaceId],
    );
    locked = lockRows[0]?.locked ?? false;
    if (!locked) {
      throw new WorkspacePurgeStartedError(
        workspaceId,
        "a purge is currently holding this workspace's advisory lock -- this call never waits, retry once it finishes",
      );
    }

    await client.query("BEGIN");
    try {
      const { rows: orgRows } = await client.query<OrganizationDeletedAtRow>(
        `SELECT "deletedAt" FROM organization WHERE id = $1 FOR UPDATE`,
        [workspaceId],
      );
      const org = orgRows[0];
      if (!org || org.deletedAt === null) {
        throw new WorkspaceNotDeletedError(workspaceId);
      }

      const { rows: purgeRows } = await client.query<PurgeRecordGuardRow>(
        `SELECT first_destructive_batch_at AS "firstDestructiveBatchAt" FROM purge_records WHERE workspace_id = $1`,
        [workspaceId],
      );
      const purgeRecord = purgeRows[0];
      if (purgeRecord && purgeRecord.firstDestructiveBatchAt !== null) {
        throw new WorkspacePurgeStartedError(
          workspaceId,
          "its purge has already destroyed at least one row (first_destructive_batch_at is set) -- " +
            "this is permanent and there is no parameter that relaxes it",
        );
      }

      await client.query(`UPDATE organization SET "deletedAt" = NULL WHERE id = $1`, [workspaceId]);

      // D-15: bind the tenant GUC for this transaction only (SET LOCAL
      // semantics via set_config's third `true` argument) so the narrow
      // UPDATE below satisfies campaigns' fail-closed workspace_isolation
      // policy (migration 0044).
      await client.query(`SELECT set_config('app.current_workspace_id', $1, true)`, [workspaceId]);
      const { rows: flippedRows } = await client.query<{ id: string }>(
        `UPDATE campaigns
            SET status = 'draft'
          WHERE workspace_id = $1
            AND status = 'scheduled'
            AND scheduled_at <= now()
        RETURNING id`,
        [workspaceId],
      );

      await client.query("COMMIT");

      return {
        workspaceId,
        restoredAt: new Date(),
        campaignsFlippedToDraft: flippedRows.map((row) => row.id),
      };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    }
  } finally {
    if (locked) {
      await client
        .query(`SELECT pg_advisory_unlock($1, hashtext($2))`, [PURGE_ADVISORY_LOCK_NAMESPACE, workspaceId])
        .catch(() => undefined);
    }
    client.release();
  }
}
