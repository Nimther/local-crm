import { pgTable, bigserial, text, timestamp, integer } from "drizzle-orm/pg-core";

/**
 * Phase 14 plan 12 (DB-11, D-08). Logical/type-inference shape ONLY -- the
 * physical table is created by the hand-written migration
 * packages/db/migrations/0063_partition_retention_drops.sql, matching
 * `partition-maintenance-runs.ts`/`dead-letter-jobs.ts`'s own precedent in
 * this directory.
 *
 * Append-only ledger: one row per partition the retention tick has ever
 * dropped, written by `packages/db/src/partitions/retention.ts`'s
 * `dropExpiredPartitions`. This is the "answerable from the database"
 * half of T-14-79's mitigation -- `partition_maintenance_runs` (the
 * singleton health row `runPartitionMaintenance` upserts every tick) can
 * only ever describe the MOST RECENT run, so "what did retention remove
 * last month" is unanswerable from that row alone once a later tick has
 * overwritten it. This table is the durable history the singleton cannot
 * hold; `partition_maintenance_runs.retention_status`/`retention_error`
 * (migration 0063's other half) is the complementary "did the most recent
 * run succeed, and if not why" signal -- the two together are what "where
 * does the drop record live" resolves to (this plan's own action text asks
 * that question explicitly; see 14-12-SUMMARY.md for the full reasoning).
 *
 * NO `workspace_id` column, and this is deliberate, not an oversight --
 * same reasoning as every other table in this directory with no such
 * column: this carries only platform-level operational metadata (partition
 * names, ranges, the horizon that made a given drop eligible), never tenant
 * data, so it must never receive the RLS ENABLE/FORCE + `workspace_isolation`
 * treatment every tenant-scoped table in this directory gets.
 */
export const partitionRetentionDrops = pgTable("partition_retention_drops", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  parentTable: text("parent_table").notNull(),
  partitionName: text("partition_name").notNull(),
  rangeStart: timestamp("range_start", { withTimezone: true }).notNull(),
  rangeEnd: timestamp("range_end", { withTimezone: true }).notNull(),
  horizonMonths: integer("horizon_months").notNull(),
  droppedAt: timestamp("dropped_at", { withTimezone: true }).notNull().defaultNow(),
});
