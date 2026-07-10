-- 06-01: workspace-level default timezone + quiet-hours window (D-08/D-09).
-- default_timezone is the IANA fallback used when a contact has no
-- contacts.timezone set; quiet_hours_start/quiet_hours_end are
-- minutes-from-midnight; quiet_hours_enabled gates whether the window
-- applies at all.
ALTER TABLE "workspace_send_settings" ADD COLUMN "default_timezone" text;--> statement-breakpoint
ALTER TABLE "workspace_send_settings" ADD COLUMN "quiet_hours_start" integer;--> statement-breakpoint
ALTER TABLE "workspace_send_settings" ADD COLUMN "quiet_hours_end" integer;--> statement-breakpoint
ALTER TABLE "workspace_send_settings" ADD COLUMN "quiet_hours_enabled" boolean DEFAULT false NOT NULL;
