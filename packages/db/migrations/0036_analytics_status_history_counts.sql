-- 07-01: subscription-status audit log (D-09) + per-send repeat open/click
-- counters (A4/D-11). RLS ENABLE + FORCE + NULLIF-guarded workspace_isolation
-- policy applied from this first migration for the new table, mirroring the
-- 0026_flows.sql precedent.

CREATE TABLE "subscription_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"old_status" text,
	"new_status" text NOT NULL,
	"source" text NOT NULL,
	"reason" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscription_status_history" ADD CONSTRAINT "subscription_status_history_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_status_history" ADD CONSTRAINT "subscription_status_history_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Timeline read-path index (D-09/ANLT-03).
CREATE INDEX idx_subscription_status_history_workspace_contact_changed ON subscription_status_history (workspace_id, contact_id, changed_at);
--> statement-breakpoint

-- A4/D-11: per-send repeat open/click counters. Every genuinely-new open/
-- click event increments its column, independent of the existing
-- first_opened_at/first_clicked_at first-write-only gate.
ALTER TABLE "sends" ADD COLUMN "open_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "sends" ADD COLUMN "click_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint

-- RLS: ENABLE + FORCE + NULLIF-guarded workspace_isolation (T-07-01-01).
ALTER TABLE subscription_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_status_history FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON subscription_status_history
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
