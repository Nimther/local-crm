CREATE TYPE "public"."send_status" AS ENUM('dispatching', 'sent', 'failed', 'excluded');--> statement-breakpoint
CREATE TABLE "sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"campaign_id" uuid,
	"contact_id" uuid NOT NULL,
	"kind" text DEFAULT 'campaign' NOT NULL,
	"status" "send_status" DEFAULT 'dispatching' NOT NULL,
	"exclusion_reason" text,
	"provider_message_id" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "sends_workspace_campaign_contact_unique" UNIQUE("workspace_id","campaign_id","contact_id")
);
--> statement-breakpoint
ALTER TABLE "sends" ADD CONSTRAINT "sends_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sends" ADD CONSTRAINT "sends_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sends" ADD CONSTRAINT "sends_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Frequency-cap covering index (SEND-04, RESEARCH.md Pitfall 4): decided at
-- table-creation time, not after an incident, so the per-contact
-- (workspace_id, contact_id, sent_at) cap check is an index scan, not a
-- sequential scan, at broadcast volume (T-04-01-04).
CREATE INDEX idx_sends_workspace_contact_sent_at ON sends (workspace_id, contact_id, sent_at);
--> statement-breakpoint

-- Campaign progress aggregation index (CAMP-05).
CREATE INDEX idx_sends_campaign_status ON sends (campaign_id, status);
--> statement-breakpoint

-- RLS: same ENABLE + FORCE + workspace_isolation triplet (T-04-01-01).
ALTER TABLE sends ENABLE ROW LEVEL SECURITY;
ALTER TABLE sends FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON sends
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id', true)::uuid);
