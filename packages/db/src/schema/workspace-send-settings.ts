import { pgTable, timestamp, uuid, integer } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";

/**
 * Per-workspace send throttling (D-13): frequency cap (default 3 sends per
 * 24h window) protects contacts from being over-messaged across overlapping
 * campaigns/flows; `rpsLimit` is an optional override of the platform
 * default SendGrid rate ceiling, resolved by delivery-core when null.
 * `workspaceId` is the primary key -- one settings row per workspace, not a
 * generic id -- since every workspace has exactly zero-or-one row here.
 */
export const workspaceSendSettings = pgTable("workspace_send_settings", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  frequencyCap: integer("frequency_cap").notNull().default(3),
  frequencyWindowHours: integer("frequency_window_hours").notNull().default(24),
  rpsLimit: integer("rps_limit"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
