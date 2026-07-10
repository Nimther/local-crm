import { pgTable, timestamp, uuid, unique } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { flows } from "./flows.js";
import { contacts } from "./contacts.js";

/**
 * Segment-triggered flow membership tracking (D-02): records the last time
 * the periodic segment-sweep worker (flow-segment-sweep.worker.ts) observed
 * a contact as a member of a segment-triggered flow's audience, so it can
 * diff against the current live membership and only enroll NEW entrants on
 * each sweep pass -- mirrors `campaign_recipients`' per-contact snapshot row
 * shape. The composite unique constraint is the sweep job's idempotency
 * guarantee (a redelivered sweep tick can never double-count a contact it
 * has already seen).
 */
export const flowSegmentMembershipSnapshot = pgTable(
  "flow_segment_membership_snapshot",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    flowId: uuid("flow_id")
      .notNull()
      .references(() => flows.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("flow_segment_membership_snapshot_workspace_flow_contact_unique").on(
      t.workspaceId,
      t.flowId,
      t.contactId
    ),
  ]
);
