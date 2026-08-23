import { pgTable, text, timestamp, uuid, jsonb } from "drizzle-orm/pg-core";

/**
 * Phase 22 (PRG-01/PRG-02/PRG-03/PRG-05, D-05/D-07/D-10, plan 22-01): the
 * platform-level checkpoint AND durable evidence record for the workspace
 * physical-purge state machine. The physical table -- including its unique
 * index on workspace_id and its status index -- is created by the
 * hand-written migration packages/db/migrations/0068_workspace_purge_records.sql.
 * This file exists purely so application code (the purge worker,
 * `apps/worker/src/queues/workspace-purge.worker.ts` and its checkpoint
 * module) gets typed query results via Drizzle's schema inference, matching
 * `ops-alert-state.ts`'s own precedent.
 *
 * FIVE STATUS VALUES, forming the whole state machine: `pending` (eligible,
 * not yet announced) -> `reported` (census written, reported_at set,
 * nothing destroyed yet) -> `purging` (first destructive batch has started)
 * -> `complete` (tombstone applied, purged_at set) -- with `failed` reachable
 * from either `purging` or the walk's own restore-check, and the SOLE exit
 * from `failed` is an operator explicitly returning the record to `purging`
 * (see workspace-purge.worker.ts's own doc comment on the destructive
 * selector). The destructive selector matches `reported` and `purging`
 * ONLY -- `pending` has nothing to destroy yet, `complete` must never be
 * re-walked, and `failed` is deliberately never auto-resumed.
 *
 * DELIBERATELY RLS-FREE: unlike every tenant-scoped table in this codebase,
 * this table carries no `workspace_isolation` policy. Same "role identity is
 * the boundary" precedent as `ops_alert_state`/`dead_letter_jobs`/
 * `partition_maintenance_runs` -- it holds no tenant PII (ids, timestamps,
 * status, per-table row counts and an error string only, D-10), is read and
 * written exclusively by the platform-side purge worker, and a `workspace_id`
 * column here is the one column this whole table is organized around, not a
 * tenant-facing surface a policy would need to gate.
 *
 * DELIBERATELY FK-FREE: `workspaceId` carries NO `.references(...)` to
 * `organization.id`. This is the load-bearing property that makes the whole
 * design work -- this row must survive the destruction of every tenant table
 * the purge walks AND must survive independently of `organization` itself
 * (which is retired by an anonymizing UPDATE, never a DELETE, but a future
 * hard-delete of a long-tombstoned organization row must never be blocked by,
 * or cascade into, this evidence record). A `.references()` here would make
 * this checkpoint a cascade target of the very table it exists to survive.
 */
export const purgeRecords = pgTable("purge_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().unique(),
  softDeletedAt: timestamp("soft_deleted_at", { withTimezone: true }).notNull(),
  eligibleAt: timestamp("eligible_at", { withTimezone: true }).notNull(),
  reportedAt: timestamp("reported_at", { withTimezone: true }),
  firstDestructiveBatchAt: timestamp("first_destructive_batch_at", { withTimezone: true }),
  purgedAt: timestamp("purged_at", { withTimezone: true }),
  lastProgressAt: timestamp("last_progress_at", { withTimezone: true }),
  status: text("status").notNull().default("pending"),
  tableCounts: jsonb("table_counts").notNull().default({}),
  completedTables: text("completed_tables").array().notNull().default([]),
  purgeError: text("purge_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * TypeScript-side mirror of migration 0068's CHECK-free (but application-
 * enforced) status vocabulary. Left as plain `text` on the Drizzle column
 * above (not a Drizzle enum) for the same reason `erasure-records.ts` does:
 * no CHECK constraint backs this column in SQL (the migration deliberately
 * leaves it unconstrained so an operator's manual recovery UPDATE, per the
 * destructive-selector's own doc comment, never fights a CHECK), so a
 * Drizzle enum would be a second, possibly-drifting declaration of a rule
 * the database itself does not enforce.
 */
export type PurgeRecordStatus = "pending" | "reported" | "purging" | "complete" | "failed";
