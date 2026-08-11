import { pgTable, timestamp, uuid, unique } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { campaigns } from "./campaigns.js";
import { contacts } from "./contacts.js";

/**
 * Frozen recipient snapshot (D-02): the set of contacts a campaign will send
 * to is computed once (segment membership at snapshot time, not
 * re-evaluated live), so a segment definition edit mid-send never changes
 * who receives an in-flight campaign. `id` here is unused as an FK target;
 * the composite unique on (campaignId, contactId) is the idempotency
 * guarantee for the snapshot-writer batch job (recipient-snapshot.ts).
 */
export const campaignRecipients = pgTable(
  "campaign_recipients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("campaign_recipients_campaign_contact_unique").on(t.campaignId, t.contactId),
  ]
);
