import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { flowRuns } from "./flow-runs.js";
import { sends } from "./sends.js";

/**
 * Append-only log of every node a flow run has passed through (FLOW-01,
 * mirrors `send_events`' append-only fact-log shape). One row per
 * node-visit outcome -- never updated, never deleted -- giving a full audit
 * trail of a run's path through the graph independent of `flow_runs`'
 * mutable `current_node_id`/`status`. `sendId` is nullable: only send-node
 * outcomes reference a `sends` row; condition/wait/branch nodes do not.
 */
export const flowRunSteps = pgTable("flow_run_steps", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  flowRunId: uuid("flow_run_id")
    .notNull()
    .references(() => flowRuns.id, { onDelete: "cascade" }),
  nodeId: text("node_id").notNull(),
  nodeType: text("node_type").notNull(),
  outcome: text("outcome").notNull(),
  sendId: uuid("send_id").references(() => sends.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
