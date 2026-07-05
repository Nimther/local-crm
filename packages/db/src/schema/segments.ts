import { pgTable, text, timestamp, uuid, jsonb, integer } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";

/**
 * Dynamic segments (SEGM-01..04, Phase 3). `definition` is the versioned
 * SegmentDefinition JSON (packages/shared-schemas/src/segment.ts) compiled at
 * read time by @mega-crm/segments-core's compileSegmentDefinition -- this
 * table is always dynamic (D-13, no static snapshots). `memberCount` /
 * `memberCountAt` are the last-computed count + freshness timestamp (D-11),
 * nullable until the first computation lands (on create). Deletion is free
 * this phase (D-14) -- no FK yet references segments.id; Phase 4/6 will add
 * restrict-when-referenced once campaigns/flows exist.
 */
export const segments = pgTable("segments", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  definition: jsonb("definition").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
  memberCount: integer("member_count"),
  memberCountAt: timestamp("member_count_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
