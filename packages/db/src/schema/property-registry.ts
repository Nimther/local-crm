import { pgTable, text, timestamp, uuid, unique } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";

/**
 * Auto-discovered custom-property registry (D-10): a property is registered
 * the first time it's observed (API/event/CSV/UI) with its observed type
 * (string/number/bool/date) -- suggestions only, no enforcement. Written
 * from a single centralized helper, see
 * apps/api/src/modules/contacts/property-registry.ts's registerObservedProperty.
 */
export const workspacePropertyRegistry = pgTable(
  "workspace_property_registry",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    observedType: text("observed_type").notNull(), // "string" | "number" | "bool" | "date"
    firstSeenAt: timestamp("first_seen_at").notNull().defaultNow(),
  },
  (t) => [unique("workspace_property_registry_workspace_key_unique").on(t.workspaceId, t.key)]
);
