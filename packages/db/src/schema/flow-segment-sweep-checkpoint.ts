import { pgTable, timestamp, uuid, unique } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { flows } from "./flows.js";

/**
 * Phase 12 (WRK-05/WRK-06, D-09): the segment sweep's per-flow resume
 * cursor -- the last `contacts.id` considered by the most recently
 * COMMITTED page of that flow's bounded walk (`flow-segment-sweep-flow.worker.ts`).
 * Written in the SAME transaction as that page's enrollment work
 * (`flow-segment-sweep-checkpoint.ts`'s `advanceSweepCheckpoint`), so a kill
 * between pages is exactly resumable by construction.
 *
 * `cursor` is nullable for two DIFFERENT reasons that both mean "start from
 * the beginning": no row yet exists for this flow (first-ever sweep), or a
 * PRIOR walk completed its full pass and reset the cursor back to NULL
 * (`resetSweepCheckpoint`) -- this sweep is perpetual, unlike
 * `recipient-snapshot.ts`'s one-shot `campaigns.snapshot_cursor` freeze, so
 * a permanent cursor here would silently skip any contact inserted behind
 * it between ticks.
 */
export const flowSegmentSweepCheckpoint = pgTable(
  "flow_segment_sweep_checkpoint",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    flowId: uuid("flow_id")
      .notNull()
      .references(() => flows.id, { onDelete: "cascade" }),
    cursor: uuid("cursor"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("flow_segment_sweep_checkpoint_workspace_flow_unique").on(t.workspaceId, t.flowId)]
);
