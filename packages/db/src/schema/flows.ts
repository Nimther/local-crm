import { pgTable, text, timestamp, uuid, integer, jsonb, pgEnum } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { segments } from "./segments.js";

/**
 * Flow lifecycle status (FLOW-01/FLOW-06). `draft` -> `live` (published,
 * enrolling contacts) <-> `paused` (still exists, stops new entries). No
 * terminal state in v1 (D-18/D-22) -- a flow can be re-published or resumed
 * indefinitely. Transitions are enforced at the repository layer, not the
 * DB -- this enum only constrains the domain of valid values.
 */
export const flowStatusEnum = pgEnum("flow_status", ["draft", "live", "paused"]);

/**
 * Triggered chains (FLOW-01, Phase 6). A flow's actual node/edge graph lives
 * in the immutable `flow_versions.definition` -- this parent row tracks
 * lifecycle status plus the two live pointers (`draftVersionId`/
 * `liveVersionId`) into that version history. `triggerSegmentId` is
 * ON DELETE RESTRICT (mirrors `campaigns.segmentId`, T-04-01-03) so the DB
 * refuses to orphan a flow's trigger audience even if an app-level
 * delete-when-referenced check is bypassed. `reentryMode`/`reentryWindowDays`
 * back D-06's once-ever/once-per-N-days/every-time re-entry control;
 * `quietHoursMode`/`quietHoursStart`/`quietHoursEnd` back D-08/D-09's
 * per-flow quiet-hours override of the workspace default.
 */
export const flows = pgTable("flows", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  status: flowStatusEnum("status").notNull().default("draft"),
  triggerType: text("trigger_type"), // "event" | "segment"
  triggerEventName: text("trigger_event_name"),
  triggerSegmentId: uuid("trigger_segment_id").references(() => segments.id, { onDelete: "restrict" }),
  draftVersionId: uuid("draft_version_id"),
  liveVersionId: uuid("live_version_id"),
  reentryMode: text("reentry_mode").notNull().default("every_time"), // "once_ever" | "once_per_n_days" | "every_time"
  reentryWindowDays: integer("reentry_window_days"),
  quietHoursMode: text("quiet_hours_mode").notNull().default("inherit"), // "inherit" | "override" | "disabled"
  quietHoursStart: integer("quiet_hours_start"), // minutes from midnight
  quietHoursEnd: integer("quiet_hours_end"), // minutes from midnight
  // 06-04: D-15 flow-level exit conditions (segment membership or a
  // post-entry event) -- an array of flowExitConditionSchema-shaped objects
  // (@mega-crm/shared-schemas), validated at the app layer only. Added here
  // because updateFlowDraftSchema (06-02) already accepts this field but no
  // column existed yet to persist it (Rule 2 gap-fill).
  exitConditions: jsonb("exit_conditions").notNull().default([]),
  // 06-08: D-04 resumable-cursor state for flow-enroll-existing.worker.ts's
  // keyset-paginated batch enroll -- mirrors campaigns.snapshot_cursor.
  // Nullable; NULL means no batch has run yet for the current pass.
  enrollCursor: uuid("enroll_cursor"),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
