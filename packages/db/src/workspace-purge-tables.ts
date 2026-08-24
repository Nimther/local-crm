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
 * Plan 22-05 (PRG-02/PRG-04, D-10) extends the tracer's two-table walk to the
 * full FK order across every tenant table `docs/PII-INVENTORY.md` names,
 * reconciled table-by-table against that document. The order matters:
 * `subscription_status_history` (and every other child table) is walked
 * BEFORE `contacts` even though its own `contact_id` carries
 * `ON DELETE CASCADE` FROM `contacts` -- destroying the child explicitly,
 * rather than relying on the parent's cascade, keeps every destructive
 * statement bounded and checkpointed by this module's own batching, instead
 * of handing Postgres an implicit, unbounded, uncheckpointed cascade the
 * moment `contacts` rows are deleted.
 *
 * Three `ON DELETE RESTRICT` edges force part of this order (RESEARCH.md's
 * full FK graph walk):
 *   - `sends.flow_run_id` is `ON DELETE CASCADE` FROM `flow_runs` -- `sends`
 *     precedes `flow_runs` so deleting a flow_run never fires an uncounted
 *     cascade against `sends`.
 *   - `flow_runs.flow_version_id` is `ON DELETE RESTRICT` against
 *     `flow_versions` -- `flow_runs` precedes `flow_versions`.
 *   - `flows.trigger_segment_id` and `campaigns.segment_id` are both
 *     `ON DELETE RESTRICT` against `segments` -- `flows` and `campaigns`
 *     both precede `segments`.
 *
 * The two partitioned tables (`events`, `send_events`) use the SAME
 * `deletePurgeBatch` primitive as every other table -- drained row by row in
 * bounded pages. No partition-level structural operation (DROP/DETACH/
 * TRUNCATE) is ever issued for them or for anything else in this list,
 * because a structural operation would remove a neighbour tenant's rows
 * living in the same monthly partition (PRG-04, SC4).
 *
 * The three secret tables (`workspace_sendgrid_keys`,
 * `workspace_suppression_keys`, `workspace_webhook_endpoints`) are ordinary
 * tenant tables with a `workspace_id` column, destroyed by this SAME ordinary
 * walk -- never a bespoke code path, which would put them outside the
 * checkpoint and the count. They are ordered LAST in the walk: a purge that
 * fails halfway is far easier to resume when the credentials still exist than
 * when they are gone, and no requirement asks for credentials to die first.
 * `PURGE_SECRET_TABLES` names exactly those three so "the secrets are gone"
 * is assertable against a named set rather than by reading the order.
 *
 * `PURGE_EVIDENCE_TABLES` (`erasure_records`, `workspace_suppressions`,
 * `workspace_daily_rollup`) are excluded from `PURGE_TABLE_ORDER` entirely --
 * not merely ordered last -- because the latter two reference only
 * `organization`, never `contacts`, and with the organization row tombstoned
 * (never deleted, see `tombstoneOrganization`) neither is ever at cascade
 * risk. `erasure_records.contact_id` is `ON DELETE SET NULL` (migration
 * 0069) specifically so this evidence row survives `contacts` being
 * destroyed, readable, with its contact reference cleared.
 */

/** Every tenant table the physical purge walks, in FK-safe (child-before-parent) order. */
export type PurgeTable =
  | "send_events"
  | "flow_run_steps"
  | "campaign_recipients"
  | "subscription_status_history"
  | "flow_segment_membership_snapshot"
  | "flow_segment_sweep_checkpoint"
  | "events"
  | "sends"
  | "flow_runs"
  | "flow_versions"
  | "flows"
  | "campaigns"
  | "segments"
  | "contacts"
  | "csv_import_rows"
  | "csv_imports"
  | "workspace_property_registry"
  | "send_event_quarantine"
  | "ingress_journal"
  | "workspace_api_keys"
  | "workspace_send_settings"
  | "reputation_alert_state"
  | "workspace_sendgrid_keys"
  | "workspace_suppression_keys"
  | "workspace_webhook_endpoints";

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

/**
 * The full FK-safe walk order (plan 22-05), leaf to root. See this file's
 * header comment for the three restrict edges and the secret/evidence
 * placement rationale that shape this exact sequence.
 */
export const PURGE_TABLE_ORDER: readonly PurgeTable[] = [
  "send_events",
  "flow_run_steps",
  "campaign_recipients",
  "subscription_status_history",
  "flow_segment_membership_snapshot",
  "flow_segment_sweep_checkpoint",
  "events",
  "sends",
  "flow_runs",
  "flow_versions",
  "flows",
  "campaigns",
  "segments",
  "contacts",
  "csv_import_rows",
  "csv_imports",
  "workspace_property_registry",
  "send_event_quarantine",
  "ingress_journal",
  "workspace_api_keys",
  "workspace_send_settings",
  "reputation_alert_state",
  "workspace_sendgrid_keys",
  "workspace_suppression_keys",
  "workspace_webhook_endpoints",
];

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
  // Both partitioned. Drained row by row via the same `deletePurgeBatch`
  // primitive as every table below -- no partition-level structural
  // operation of any kind is issued for either (PRG-04, SC4): a structural
  // operation would remove a neighbour tenant's rows living in the same
  // monthly partition.
  send_events: { table: "send_events", workspaceColumn: "workspace_id" },
  events: { table: "events", workspaceColumn: "workspace_id" },

  flow_run_steps: { table: "flow_run_steps", workspaceColumn: "workspace_id" },
  campaign_recipients: { table: "campaign_recipients", workspaceColumn: "workspace_id" },
  subscription_status_history: { table: "subscription_status_history", workspaceColumn: "workspace_id" },
  flow_segment_membership_snapshot: { table: "flow_segment_membership_snapshot", workspaceColumn: "workspace_id" },
  flow_segment_sweep_checkpoint: { table: "flow_segment_sweep_checkpoint", workspaceColumn: "workspace_id" },

  // `sends.flow_run_id` is ON DELETE CASCADE FROM `flow_runs` -- `sends`
  // precedes `flow_runs` below so deleting a flow_run never fires an
  // uncounted cascade against `sends`.
  sends: { table: "sends", workspaceColumn: "workspace_id" },
  // `flow_runs.flow_version_id` is ON DELETE RESTRICT against
  // `flow_versions` -- `flow_runs` precedes `flow_versions`.
  flow_runs: { table: "flow_runs", workspaceColumn: "workspace_id" },
  flow_versions: { table: "flow_versions", workspaceColumn: "workspace_id" },
  // `flows.trigger_segment_id` and `campaigns.segment_id` are both
  // ON DELETE RESTRICT against `segments` -- both precede `segments`.
  flows: { table: "flows", workspaceColumn: "workspace_id" },
  campaigns: { table: "campaigns", workspaceColumn: "workspace_id" },
  segments: { table: "segments", workspaceColumn: "workspace_id" },

  // After everything that references it. Not needed for FK correctness
  // (those edges are all cascades once the restrict-guarded parents above are
  // gone) but needed to keep every delete bounded and counted rather than
  // relying on the cascade `contacts` deletion would otherwise trigger.
  contacts: { table: "contacts", workspaceColumn: "workspace_id" },

  // Fan-in-free tenant tables -- `csv_import_rows` before `csv_imports`
  // (its parent) for the same bounded-and-counted reason as `contacts`
  // above, even though the FK there is also a plain cascade.
  csv_import_rows: { table: "csv_import_rows", workspaceColumn: "workspace_id" },
  csv_imports: { table: "csv_imports", workspaceColumn: "workspace_id" },
  workspace_property_registry: { table: "workspace_property_registry", workspaceColumn: "workspace_id" },
  send_event_quarantine: { table: "send_event_quarantine", workspaceColumn: "workspace_id" },
  ingress_journal: { table: "ingress_journal", workspaceColumn: "workspace_id" },
  workspace_api_keys: { table: "workspace_api_keys", workspaceColumn: "workspace_id" },
  workspace_send_settings: { table: "workspace_send_settings", workspaceColumn: "workspace_id" },
  reputation_alert_state: { table: "reputation_alert_state", workspaceColumn: "workspace_id" },

  // The three secret tables, LAST: a purge that fails halfway is far easier
  // to resume when the credentials still exist than when they are gone, and
  // no requirement asks for credentials to die first. Destroyed by this
  // ordinary walk, not a bespoke path -- see `PURGE_SECRET_TABLES` below.
  workspace_sendgrid_keys: { table: "workspace_sendgrid_keys", workspaceColumn: "workspace_id" },
  workspace_suppression_keys: { table: "workspace_suppression_keys", workspaceColumn: "workspace_id" },
  workspace_webhook_endpoints: { table: "workspace_webhook_endpoints", workspaceColumn: "workspace_id" },
};

/**
 * The three secret tables, named as a checkable constant (T-22-05-07, D-11)
 * so "the secrets are gone" is assertable against a named set rather than by
 * reading `PURGE_TABLE_ORDER`. Destroyed by the ordinary walk like every
 * other table -- this constant documents the set and its ordering
 * constraint (last in `PURGE_TABLE_ORDER`), it does not route them around
 * the loop.
 */
export const PURGE_SECRET_TABLES = [
  "workspace_sendgrid_keys",
  "workspace_suppression_keys",
  "workspace_webhook_endpoints",
] as const;

/**
 * Tables the purge NEVER deletes from, declared as a checkable constant
 * (D-10, PRG-02) rather than left as an absence a test can only infer.
 * `PURGE_TABLE_ORDER` and this list are asserted disjoint by the test suite
 * (workspace-purge.test.ts / workspace-purge-tables.test.ts) -- by assertion,
 * not by inspection. `workspace_suppressions` and `workspace_daily_rollup`
 * reference only `organization`, never `contacts` -- with the organization
 * row tombstoned rather than removed, neither is ever at cascade risk, which
 * is why they are excluded from the order entirely rather than merely
 * ordered last.
 */
export const PURGE_EVIDENCE_TABLES = ["erasure_records", "workspace_suppressions", "workspace_daily_rollup"] as const;

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
