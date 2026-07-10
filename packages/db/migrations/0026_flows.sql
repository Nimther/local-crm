-- 06-01: durable storage spine for triggered flows (FLOW-01/FLOW-06/FLOW-07).
-- Five new tables. RLS ENABLE + FORCE + NULLIF-guarded workspace_isolation
-- policy is applied from THIS FIRST migration for every table (0019's
-- bare-cast bug is not reproduced here -- see 0019_campaigns_workspace_isolation_nullif_guard.sql
-- for why the NULLIF guard matters on a reused pooled connection).

CREATE TYPE "public"."flow_status" AS ENUM('draft', 'live', 'paused');--> statement-breakpoint
CREATE TYPE "public"."flow_run_status" AS ENUM('waiting', 'advancing', 'completed', 'exited', 'ejected');--> statement-breakpoint

-- flows: parent lifecycle row (draft/live/paused, no terminal state in v1).
CREATE TABLE "flows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" "flow_status" DEFAULT 'draft' NOT NULL,
	"trigger_type" text,
	"trigger_event_name" text,
	"trigger_segment_id" uuid,
	"draft_version_id" uuid,
	"live_version_id" uuid,
	"reentry_mode" text DEFAULT 'every_time' NOT NULL,
	"reentry_window_days" integer,
	"quiet_hours_mode" text DEFAULT 'inherit' NOT NULL,
	"quiet_hours_start" integer,
	"quiet_hours_end" integer,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "flows" ADD CONSTRAINT "flows_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flows" ADD CONSTRAINT "flows_trigger_segment_id_segments_id_fk" FOREIGN KEY ("trigger_segment_id") REFERENCES "public"."segments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- flow_versions: immutable snapshot of the node/edge graph (FLOW-06/FLOW-07).
CREATE TABLE "flow_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"flow_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "flow_versions" ADD CONSTRAINT "flow_versions_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_versions" ADD CONSTRAINT "flow_versions_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- flow_runs: per-contact run state. flow_version_id is the immutability PIN
-- (ON DELETE RESTRICT -- a referenced version can never be dropped out from
-- under an in-flight run).
CREATE TABLE "flow_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"flow_id" uuid NOT NULL,
	"flow_version_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"status" "flow_run_status" DEFAULT 'waiting' NOT NULL,
	"current_node_id" text,
	"next_wake_at" timestamp with time zone,
	"entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_entry_at" timestamp with time zone DEFAULT now() NOT NULL,
	"exited_at" timestamp with time zone,
	"exit_reason" text
);
--> statement-breakpoint
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_flow_version_id_flow_versions_id_fk" FOREIGN KEY ("flow_version_id") REFERENCES "public"."flow_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- flow_run_steps: append-only per-node-visit log (mirrors send_events shape).
CREATE TABLE "flow_run_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"flow_run_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"node_type" text NOT NULL,
	"outcome" text NOT NULL,
	"send_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "flow_run_steps" ADD CONSTRAINT "flow_run_steps_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_run_steps" ADD CONSTRAINT "flow_run_steps_flow_run_id_flow_runs_id_fk" FOREIGN KEY ("flow_run_id") REFERENCES "public"."flow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_run_steps" ADD CONSTRAINT "flow_run_steps_send_id_sends_id_fk" FOREIGN KEY ("send_id") REFERENCES "public"."sends"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- flow_segment_membership_snapshot: sweep-worker per-contact diff tracking.
CREATE TABLE "flow_segment_membership_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"flow_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "flow_segment_membership_snapshot" ADD CONSTRAINT "flow_segment_membership_snapshot_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_segment_membership_snapshot" ADD CONSTRAINT "flow_segment_membership_snapshot_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_segment_membership_snapshot" ADD CONSTRAINT "flow_segment_membership_snapshot_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_segment_membership_snapshot" ADD CONSTRAINT "flow_segment_membership_snapshot_workspace_flow_contact_unique" UNIQUE ("workspace_id", "flow_id", "contact_id");--> statement-breakpoint

-- Supporting indexes.
-- flow_runs due-timer scan (reconciliation worker filters status IN
-- ('waiting','advancing') AND next_wake_at <= now()).
CREATE INDEX idx_flow_runs_workspace_status_next_wake ON flow_runs (workspace_id, status, next_wake_at);
--> statement-breakpoint

-- D-07: at most one active (waiting/advancing) run per (workspace, flow,
-- contact). A table-level UNIQUE cannot express a WHERE predicate --
-- written as a partial unique index instead.
CREATE UNIQUE INDEX flow_runs_one_active_per_contact ON flow_runs (workspace_id, flow_id, contact_id) WHERE status IN ('waiting', 'advancing');
--> statement-breakpoint

-- RLS: ENABLE + FORCE + NULLIF-guarded workspace_isolation on all five new
-- tables (T-06-01-01/T-06-01-02). Applied from this FIRST migration --
-- do not defer the NULLIF guard to a follow-up fix (0019 lesson).
ALTER TABLE flows ENABLE ROW LEVEL SECURITY;
ALTER TABLE flows FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON flows
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

ALTER TABLE flow_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON flow_versions
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

ALTER TABLE flow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON flow_runs
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

ALTER TABLE flow_run_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_run_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON flow_run_steps
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

ALTER TABLE flow_segment_membership_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_segment_membership_snapshot FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON flow_segment_membership_snapshot
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
