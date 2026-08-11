import { pgTable, text, timestamp, uuid, pgEnum, unique, integer } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { campaigns } from "./campaigns.js";
import { contacts } from "./contacts.js";
import { flowRuns } from "./flow-runs.js";

/**
 * Per-message send lifecycle (SEND-04/SEND-06). Phase 11 (DLV-01/DB-08,
 * D-02) appends `reconciling`/`unknown` -- the ambiguous-outcome and
 * no-evidence-terminal states migrations 0047/0048 add to the live
 * database. The TS array order below is cosmetic (Drizzle only uses it for
 * type inference); the physical enum's on-disk order is whatever order
 * 0047/0048 added the two values in. This array MUST stay equal (as a set)
 * to `SEND_STATUSES` in `@mega-crm/delivery-core`'s
 * `send-state-machine.ts` -- `send-status-enum-parity.test.ts` asserts this
 * against both the TS array and the live database's `enum_range`, so
 * schema, delivery-core, and Postgres itself can never silently drift
 * apart.
 */
export const sendStatusEnum = pgEnum("send_status", [
  "dispatching",
  "sent",
  "failed",
  "excluded",
  "reconciling",
  "unknown",
]);

/**
 * Unified send ledger (SEND-04/SEND-06). One row per (workspace, campaign,
 * contact) send attempt -- the UNIQUE constraint below is the DB-level
 * idempotency guarantee that a retried dispatch job can never double-insert
 * a send (T-04-01-02). `campaignId` is nullable (ON DELETE SET NULL, not
 * cascade) so Phase 6 flow-triggered sends can share this same ledger table
 * without a campaign reference. `kind` distinguishes "campaign" sends from
 * future flow-step sends; `exclusionReason` records why a recipient was
 * skipped (suppressed, frequency-capped, etc.) without occupying a `status`
 * value of its own.
 *
 * Phase 5 delivery-tracking fact columns (05-03, WBHK-04/D-06/D-09): each
 * nullable timestamptz below is set by the webhook worker via a conditional
 * `WHERE <col> IS NULL` first-write UPDATE -- once set, a fact column is
 * NEVER overwritten by a later or replayed event (D-06 out-of-order
 * safety). `bounceReason`/`dropReason` carry the terminal reason string
 * alongside `bouncedAt`/`droppedAt`.
 *
 * Phase 6 flow-step columns (06-01, FLOW-01): `flowRunId`/`nodeId` identify
 * WHICH flow run and WHICH send-node produced this row when `kind='flow'`.
 * The flow-send idempotency guarantee lives in the
 * `sends_flow_run_node_unique` PARTIAL unique index (migration 0028, raw
 * SQL only -- Drizzle's `unique()` helper cannot express a partial index),
 * scoped to `WHERE kind = 'flow'` so campaign/test rows with a null
 * `flowRunId` never contend with it.
 *
 * Phase 7 repeat-engagement counters (07-01, A4/D-11): `openCount`/
 * `clickCount` climb once per genuinely-new open/click webhook event
 * (independent of `firstOpenedAt`/`firstClickedAt`'s first-write-only gate)
 * so the send log and contact timeline can show "xN" repeat opens/clicks.
 *
 * Phase 11 reconciliation columns (11-02, migration 0049, D-17): all three
 * nullable, no backfill, no historical row touched. `reconcilingSince` is
 * when this row entered the ambiguous `reconciling` status -- deliberately
 * a SEPARATE column from `queuedAt` (locked decision: Phase 15's
 * webhook-lag alert queries this column directly, and overloading
 * `queuedAt` would conflate "when the job was enqueued" with "when it
 * became ambiguous"). `dispatchedAt` is the moment the outbound SendGrid
 * `mail/send` call started; `dispatchDurationMs` is the wall-clock
 * milliseconds that call took -- together these make send duration
 * SQL-queryable (DLV-09) before any metrics infrastructure exists. Nothing
 * in this plan writes these columns yet; the worker-side write lands in a
 * later plan of this phase (11-03 onward).
 */
export const sends = pgTable(
  "sends",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("campaign"),
    status: sendStatusEnum("status").notNull().default("dispatching"),
    exclusionReason: text("exclusion_reason"),
    providerMessageId: text("provider_message_id"),
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    firstOpenedAt: timestamp("first_opened_at", { withTimezone: true }),
    firstClickedAt: timestamp("first_clicked_at", { withTimezone: true }),
    bouncedAt: timestamp("bounced_at", { withTimezone: true }),
    droppedAt: timestamp("dropped_at", { withTimezone: true }),
    unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
    spamReportedAt: timestamp("spam_reported_at", { withTimezone: true }),
    bounceReason: text("bounce_reason"),
    dropReason: text("drop_reason"),
    flowRunId: uuid("flow_run_id").references(() => flowRuns.id, { onDelete: "cascade" }),
    nodeId: text("node_id"),
    openCount: integer("open_count").notNull().default(0),
    clickCount: integer("click_count").notNull().default(0),
    reconcilingSince: timestamp("reconciling_since", { withTimezone: true }),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    dispatchDurationMs: integer("dispatch_duration_ms"),
  },
  (t) => [
    unique("sends_workspace_campaign_contact_unique").on(t.workspaceId, t.campaignId, t.contactId),
  ]
);
