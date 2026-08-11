import { pgTable, text, timestamp, uuid, jsonb, boolean } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { sends } from "./sends.js";

/**
 * Logical/type-inference shape ONLY (WBHK-01/02/03, D-14/D-16). Drizzle's
 * `pgTable` cannot express `PARTITION BY RANGE (occurred_at)` or a composite
 * primary key that includes the partition key column the way Postgres
 * declarative partitioning requires -- the physical partitioned table, its
 * monthly partitions, indexes, and RLS policy are created by HAND-WRITTEN
 * migrations (packages/db/migrations/0020_send_events_partitioned.sql), NOT
 * by `drizzle-kit generate` against this file (mirrors events.ts's own
 * "type-inference shape ONLY" precedent -- see that file's doc-comment).
 * This file exists purely so application code (webhook-events.worker.ts,
 * future contact-timeline reads) gets typed query results via Drizzle's
 * schema inference.
 *
 * `sendId` is NULLABLE (D-15): an event whose custom_args.send_id points at
 * a deleted/orphaned send -- or a test send with no `sends` row at all --
 * is still stored, just without a resolvable FK target.
 *
 * Physical UNIQUE dedup key (as of 0057, REPLACING 0020's original):
 * `(workspace_id, send_id, event_type, occurred_at)`, enforced by the
 * `send_events_dedup_v2_idx` unique index built on the partitioned parent.
 * This REPLACES the doc-comment's own prior claim -- rewritten here, not
 * appended to, because leaving the old rationale in place next to a
 * correction is worse than either alone. The prior key,
 * `(workspace_id, sg_event_id, occurred_at)`, rested on an assumption
 * verified FALSE (Phase 13, CMP-07, Pitfall 14 second half): `sg_event_id`
 * is NOT reliably stable across SendGrid webhook retries, so a redelivery
 * with a fresh event id inserted a second row and double-counted
 * delivered/opened/clicked. `sg_event_id` is retained on every row as a
 * stored, `NOT NULL` column for forensic and log correlation ONLY -- it has
 * no role in uniqueness after 0057, and is deliberately never re-added
 * alongside the new columns (that would silently reopen the exact bypass
 * this migration closes).
 *
 * `occurred_at` stays in the key for a STRUCTURAL reason, not a design
 * preference: `send_events` is partitioned by range on `occurred_at`, and
 * Postgres requires every unique constraint on a partitioned table to
 * include all partition-key columns. What makes including it safe (rather
 * than reopening the ORIGINAL vary-the-timestamp bypass this same
 * assumption once permitted) is plan 13-04's bounding, documented just
 * below: `occurredAt` is no longer arbitrary provider input by the time it
 * reaches this table.
 *
 * Two accepted trade-offs of the new key, both intentional and both pinned
 * by tests (apps/worker/src/queues/__tests__/webhook-events-dedup-rebase.test.ts):
 *   - a `send_id`-less (orphan) row NEVER dedupes against another orphan
 *     row, even an identical one -- Postgres treats NULL as always distinct
 *     in a unique index. Accepted because an orphan event drives zero
 *     counters, so the cost of a redelivered orphan is bounded to storage.
 *   - two genuinely-new events of the SAME type on the SAME send in the
 *     SAME second (SendGrid's timestamp granularity) collapse to ONE row.
 *     Accepted as the more likely-correct interpretation of that input, not
 *     merely tolerated (see webhook-events.worker.ts's own comment at the
 *     `open`/`click` cases for the full reasoning).
 *
 * `ON CONFLICT (workspace_id, send_id, event_type, occurred_at) DO NOTHING`
 * in webhook-events.worker.ts's `processWebhookEventBatch` names exactly
 * these four columns, matching `send_events_dedup_v2_idx` directly -- no
 * named constraint backs this index (verified live against PostgreSQL
 * 17.10: `ALTER TABLE ... ADD CONSTRAINT ... UNIQUE USING INDEX` is not
 * supported on partitioned tables, so migration 0057 does not attempt one;
 * see that migration's own Step 3 for the verification detail), but
 * `ON CONFLICT` matches a unique index directly without needing one.
 *
 * Phase 13 (CMP-05, D-15, plan 13-04): `occurredAt` is now a BOUNDED value
 * on the write path -- `classifyOccurredAt` (`@mega-crm/delivery-core`)
 * rejects any provider timestamp outside `[now - 7d, now + 5min]` before a
 * row is ever constructed, so a manipulated or clock-skewed value can no
 * longer choose a partition or enter this table's dedup key. A rejected
 * event is written to `send_event_quarantine` instead (migration 0055).
 * `receivedAt` remains the separate SERVER-SIDE authority: it is always
 * `now()` at insert time, un-bounded and never derived from provider
 * input -- the two columns answer different questions ("when did this
 * happen, per the provider" vs. "when did we receive it") and neither is
 * a substitute for the other.
 */
export const sendEvents = pgTable("send_events", {
  id: uuid("id").notNull(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  sgEventId: text("sg_event_id").notNull(),
  sendId: uuid("send_id").references(() => sends.id, { onDelete: "set null" }),
  eventType: text("event_type").notNull(),
  reason: text("reason"),
  payload: jsonb("payload").notNull().default({}),
  isTest: boolean("is_test").notNull().default(false),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});
