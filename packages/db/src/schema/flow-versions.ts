import { pgTable, timestamp, uuid, integer, jsonb } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { flows } from "./flows.js";

/**
 * Immutable version snapshot of a flow's node/edge graph (FLOW-06/FLOW-07).
 * `definition` is the compiled nodes/edges jsonb shape
 * (packages/flows-core/src/flow-definition-schema.ts) -- pass jsonb objects
 * directly, never JSON.stringify (03-02 convention). `publishedAt` is null
 * while the version is still a draft; once a version is referenced by
 * `flows.live_version_id` it is NEVER mutated again -- any further edit
 * creates a NEW row with an incremented `versionNumber` (append-only). This
 * is the storage guarantee an in-flight `flow_runs` row relies on: its
 * `flow_version_id` pin can never be silently re-pointed to different node
 * behavior mid-run.
 */
export const flowVersions = pgTable("flow_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  flowId: uuid("flow_id")
    .notNull()
    .references(() => flows.id, { onDelete: "cascade" }),
  versionNumber: integer("version_number").notNull(),
  definition: jsonb("definition").notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
