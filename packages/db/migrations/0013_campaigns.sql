CREATE TYPE "public"."campaign_status" AS ENUM('draft', 'scheduled', 'sending', 'sent', 'canceled');--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" "campaign_status" DEFAULT 'draft' NOT NULL,
	"segment_id" uuid NOT NULL,
	"template_id" text,
	"from_sender_id" text,
	"from_email" text,
	"scheduled_at" timestamp with time zone,
	"sendable_total" integer,
	"sent_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"excluded_total" integer,
	"snapshot_cursor" uuid,
	"sending_started_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_segment_id_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."segments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- Scheduler scan index (due-campaign worker filters status='scheduled' AND
-- scheduled_at <= now()) -- decided at table-creation time, same rationale
-- as the frequency-cap index on sends below.
CREATE INDEX idx_campaigns_scheduled ON campaigns (status, scheduled_at);
--> statement-breakpoint

-- RLS: same ENABLE + FORCE + workspace_isolation triplet as every other
-- tenant-scoped table (see 0004_contacts_rls_policies.sql / 0012_segments_rls_and_indexes.sql --
-- FORCE is required because the app role owns its own tables and Postgres
-- exempts owners from RLS by default). T-04-01-01.
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON campaigns
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id', true)::uuid);
