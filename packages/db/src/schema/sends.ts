import { pgTable, text, timestamp, uuid, pgEnum, unique } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { campaigns } from "./campaigns.js";
import { contacts } from "./contacts.js";

/** Per-message send lifecycle (SEND-04/SEND-06). */
export const sendStatusEnum = pgEnum("send_status", [
  "dispatching",
  "sent",
  "failed",
  "excluded",
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
  },
  (t) => [
    unique("sends_workspace_campaign_contact_unique").on(t.workspaceId, t.campaignId, t.contactId),
  ]
);
