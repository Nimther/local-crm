import { pgTable, text, timestamp, uuid, integer, boolean, pgEnum } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { segments } from "./segments.js";

/**
 * Campaign lifecycle status (CAMP-01/CAMP-03). `draft` -> `scheduled` (D-06
 * picker sets scheduledAt) or straight to `sending` (immediate launch) ->
 * `sent`/`canceled`. Transitions are enforced at the repository layer, not
 * the DB -- this enum only constrains the domain of valid values.
 */
export const campaignStatusEnum = pgEnum("campaign_status", [
  "draft",
  "scheduled",
  "sending",
  "sent",
  "canceled",
]);

/**
 * Broadcast campaigns (CAMP-01/CAMP-03, Phase 4). `segmentId` is
 * ON DELETE RESTRICT (not cascade) so the DB refuses to orphan a campaign's
 * audience even if the app-level D-14 delete-when-referenced check is
 * bypassed (T-04-01-03). Progress counters (`sentCount`/`failedCount`) plus
 * `sendableTotal`/`excludedTotal` back CAMP-05's progress UI;
 * `snapshotCursor` supports a resumable recipient-snapshot batch job (see
 * recipient-snapshot.ts). `fanOutComplete` (04-06) guards the
 * campaign-kickoff worker's breakdown+fan-out pass so a redelivered kickoff
 * job never re-walks `campaign_recipients` or re-enqueues sends once the
 * pass has already completed (T-04-06-03). `sendingStartedAt`/`terminalAt`
 * timestamp the sending/sent-or-canceled transitions for audit/metrics.
 */
export const campaigns = pgTable("campaigns", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  status: campaignStatusEnum("status").notNull().default("draft"),
  segmentId: uuid("segment_id")
    .notNull()
    .references(() => segments.id, { onDelete: "restrict" }),
  templateId: text("template_id"),
  fromSenderId: text("from_sender_id"),
  fromEmail: text("from_email"),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  sendableTotal: integer("sendable_total"),
  sentCount: integer("sent_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  excludedTotal: integer("excluded_total"),
  snapshotCursor: uuid("snapshot_cursor"),
  fanOutComplete: boolean("fan_out_complete").notNull().default(false),
  sendingStartedAt: timestamp("sending_started_at", { withTimezone: true }),
  terminalAt: timestamp("terminal_at", { withTimezone: true }),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
