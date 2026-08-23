import type { PoolClient } from "pg";

/**
 * Phase 22 (PRG-01 through PRG-05, D-05/D-07, plan 22-01): the frozen table
 * allowlist and the two batched-DML primitives the workspace-purge state
 * machine (`apps/worker/src/queues/workspace-purge.worker.ts`) walks.
 *
 * LIVES IN `packages/db`, NOT `apps/worker` -- this placement is load-bearing
 * rather than aesthetic. Plan 22-06's restore path and report builder (both
 * in `packages/db`) need `PURGE_ADVISORY_LOCK_NAMESPACE`, `PURGE_TABLE_ORDER`
 * and `countPurgeTableRows` too, and a package cannot depend back on an app
 * (`packages/contacts-core/src/logger.ts` states that rule explicitly, and
 * `@mega-crm/db` has no dependency on `apps/worker`). Its contents are
 * schema-adjacent anyway -- physical table names, workspace columns and
 * `PoolClient` primitives, not queue/worker orchestration.
 *
 * THREAT T-22-01-02 (Tampering, mitigate): every identifier `deletePurgeBatch`
 * and `countPurgeTableRows` issue comes ONLY from this frozen `PURGE_TABLE_SPECS`
 * record, indexed by the `PurgeTable` union -- never from a caller-supplied
 * string and never from a discovery-query result interpolated directly. This
 * mirrors `packages/db/src/partitions/relocate-default.ts`'s own T-09-17
 * discipline.
 *
 * For this phase's tracer (plan 22-01), `PURGE_TABLE_ORDER` is exactly the
 * two-table walk this plan proves end-to-end -- plan 22-05 extends it to the
 * full FK order across the remaining ~18 tenant tables. The order matters:
 * `subscription_status_history` is walked BEFORE `contacts` even though its
 * own `contact_id` carries `ON DELETE CASCADE` FROM `contacts` -- destroying
 * the child explicitly, rather than relying on the parent's cascade, keeps
 * every destructive statement bounded and checkpointed by this module's own
 * batching, instead of handing Postgres an implicit, unbounded,
 * uncheckpointed cascade the moment `contacts` rows are deleted.
 */

/** Every tenant table the physical purge walks, in FK-safe (child-before-parent) order. */
export type PurgeTable = "subscription_status_history" | "contacts";

/**
 * Phase 22 (D-05): 500, the same page size `apps/worker/src/queues/erasure-scrub.worker.ts`'s
 * precedent (`ERASURE_SCRUB_PAGE_LIMIT`) and `relocate-default.ts`'s
 * `RELOCATE_BATCH_SIZE` both use -- bounds each destructive transaction's
 * held row locks to a handful of milliseconds against normal accumulation
 * rates, while converging quickly on a workspace with many rows.
 */
export const PURGE_BATCH_SIZE = 500;

/**
 * A namespace distinct from `relocate-default.ts`'s own `RELOCATE_ADVISORY_LOCK_KEY`
 * (8_472_995) and `packages/test-support`'s `MIGRATION_ADVISORY_LOCK_KEY`
 * (8_472_991) -- an arbitrary int4 used as the two-key form's first argument
 * (`pg_try_advisory_lock(namespace, hashtext(workspaceId))`), so this lock's
 * key space can never collide with either of those single-key locks.
 */
export const PURGE_ADVISORY_LOCK_NAMESPACE = 8706;

/** The two-table walk this tracer proves end-to-end. Plan 22-05 extends this to the full FK order. */
export const PURGE_TABLE_ORDER: readonly PurgeTable[] = ["subscription_status_history", "contacts"];

interface PurgeTableSpec {
  /** The physical table name -- never interpolated from anywhere but this record. */
  readonly table: string;
  /** The column this table's rows are scoped by for a given workspace. */
  readonly workspaceColumn: string;
}

/**
 * The frozen allowlist `deletePurgeBatch`/`countPurgeTableRows` read their
 * identifiers from -- a `Record` keyed by `PurgeTable`, so TypeScript itself
 * enforces that every table named in `PURGE_TABLE_ORDER` has a corresponding
 * spec here.
 */
export const PURGE_TABLE_SPECS: Readonly<Record<PurgeTable, PurgeTableSpec>> = {
  subscription_status_history: { table: "subscription_status_history", workspaceColumn: "workspace_id" },
  contacts: { table: "contacts", workspaceColumn: "workspace_id" },
};

/**
 * Tables the purge NEVER deletes from, declared as a checkable constant
 * (D-10, PRG-02) rather than left as an absence a test can only infer.
 * `PURGE_TABLE_ORDER` and this list are asserted disjoint by the test suite
 * (workspace-purge.test.ts, plan 22-02) -- by assertion, not by inspection.
 */
export const PURGE_EVIDENCE_TABLES = ["erasure_records", "suppressions", "workspace_daily_rollup"] as const;

/**
 * One bounded, batched DELETE against `table`, scoped to `workspaceId`.
 * Mirrors `relocate-default.ts`'s own `ctid IN (SELECT ctid ... FOR UPDATE
 * SKIP LOCKED)` shape: `FOR UPDATE SKIP LOCKED` means a row a concurrent
 * writer already holds is skipped rather than blocked on, so this batch
 * never queues behind unrelated contention. Returns the number of rows
 * actually deleted -- 0 means this table's walk for this workspace has
 * reached exhaustion (the caller's loop-termination signal).
 *
 * Issues no partition-level DDL of any kind -- row-level `DELETE` only.
 */
export async function deletePurgeBatch(
  client: PoolClient,
  table: PurgeTable,
  workspaceId: string,
  limit: number = PURGE_BATCH_SIZE,
): Promise<number> {
  const spec = PURGE_TABLE_SPECS[table];
  const result = await client.query(
    `DELETE FROM ${spec.table}
      WHERE ctid IN (
        SELECT ctid FROM ${spec.table}
         WHERE ${spec.workspaceColumn} = $1
         LIMIT $2
         FOR UPDATE SKIP LOCKED
      )`,
    [workspaceId, limit],
  );
  return result.rowCount ?? 0;
}

/**
 * The remaining row count for `table` scoped to `workspaceId` -- used both
 * for the pre-destruction census (D-05/D-07) and to CONFIRM a batch that
 * deleted zero rows genuinely found none (rather than having skipped
 * everything via `FOR UPDATE SKIP LOCKED` under contention).
 */
export async function countPurgeTableRows(client: PoolClient, table: PurgeTable, workspaceId: string): Promise<number> {
  const spec = PURGE_TABLE_SPECS[table];
  const { rows } = await client.query<{ count: string }>(
    `SELECT count(*) AS count FROM ${spec.table} WHERE ${spec.workspaceColumn} = $1`,
    [workspaceId],
  );
  return Number(rows[0]?.count ?? 0);
}
