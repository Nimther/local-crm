CREATE TABLE "workspace_send_settings" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"frequency_cap" integer DEFAULT 3 NOT NULL,
	"frequency_window_hours" integer DEFAULT 24 NOT NULL,
	"rps_limit" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_send_settings" ADD CONSTRAINT "workspace_send_settings_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- RLS: same ENABLE + FORCE + workspace_isolation triplet (T-04-01-01).
ALTER TABLE workspace_send_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_send_settings FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON workspace_send_settings
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id', true)::uuid);
