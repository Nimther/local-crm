import { pgTable, text, timestamp, uuid, pgEnum } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { flows } from "./flows.js";
import { flowVersions } from "./flow-versions.js";
import { contacts } from "./contacts.js";

/**
 * Per-contact run state through a flow's node graph (FLOW-01, D-06/D-07).
 * `flowVersionId` is ON DELETE RESTRICT and is THE PIN -- once a run enters,
 * it is bound to the exact version it started with and is NEVER re-pointed
 * even if the flow is later re-published (FLOW-06/FLOW-07 immutability
 * guarantee). `nextWakeAt` is the durable timer source of truth for wait
 * steps/quiet-hours deferrals -- the reconciliation worker scans on this
 * column. `lastEntryAt` is D-06's once-per-N-days re-entry clock (distinct
 * from `enteredAt`, which never changes once the row exists). At most one
 * `waiting`/`advancing` run may exist per (workspace, flow, contact) --
 * enforced by the `flow_runs_one_active_per_contact` partial unique index
 * (migration 0026), not expressible via Drizzle's table-level `unique()`.
 */
export const flowRunStatusEnum = pgEnum("flow_run_status", [
  "waiting",
  "advancing",
  "completed",
  "exited",
  "ejected",
]);

export const flowRuns = pgTable("flow_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  flowId: uuid("flow_id")
    .notNull()
    .references(() => flows.id, { onDelete: "cascade" }),
  flowVersionId: uuid("flow_version_id")
    .notNull()
    .references(() => flowVersions.id, { onDelete: "restrict" }),
  contactId: uuid("contact_id")
    .notNull()
    .references(() => contacts.id, { onDelete: "cascade" }),
  status: flowRunStatusEnum("status").notNull().default("waiting"),
  currentNodeId: text("current_node_id"),
  nextWakeAt: timestamp("next_wake_at", { withTimezone: true }),
  enteredAt: timestamp("entered_at", { withTimezone: true }).notNull().defaultNow(),
  lastEntryAt: timestamp("last_entry_at", { withTimezone: true }).notNull().defaultNow(),
  exitedAt: timestamp("exited_at", { withTimezone: true }),
  exitReason: text("exit_reason"),
});
