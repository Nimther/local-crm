import { pgTable, timestamp, uuid, integer, text, boolean } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";

/**
 * Per-workspace send throttling (D-13): frequency cap (default 3 sends per
 * 24h window) protects contacts from being over-messaged across overlapping
 * campaigns/flows; `rpsLimit` is an optional override of the platform
 * default SendGrid rate ceiling, resolved by delivery-core when null.
 * `workspaceId` is the primary key -- one settings row per workspace, not a
 * generic id -- since every workspace has exactly zero-or-one row here.
 *
 * Phase 6 quiet-hours defaults (06-01, D-08/D-09/FLOW-01):
 * `defaultTimezone` is the workspace-level IANA fallback used when a
 * contact has no `contacts.timezone` set. `quietHoursStart`/`quietHoursEnd`
 * (minutes from midnight) define the workspace-default quiet window a flow
 * can inherit or override (`flows.quiet_hours_mode`); `quietHoursEnabled`
 * gates whether the window applies at all.
 */
export const workspaceSendSettings = pgTable("workspace_send_settings", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  frequencyCap: integer("frequency_cap").notNull().default(3),
  frequencyWindowHours: integer("frequency_window_hours").notNull().default(24),
  rpsLimit: integer("rps_limit"),
  defaultTimezone: text("default_timezone"),
  quietHoursStart: integer("quiet_hours_start"),
  quietHoursEnd: integer("quiet_hours_end"),
  quietHoursEnabled: boolean("quiet_hours_enabled").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
