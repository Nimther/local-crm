-- 06-01 (T-06-01-04): extend the unified sends ledger with flow-step
-- columns. The partial UNIQUE index below is the DB-level idempotency
-- guarantee that a redelivered flow-step send job can never double-insert
-- a send for the same (workspace, flow_run, node) -- mirrors sends'
-- existing sends_workspace_campaign_contact_unique constraint shape, but
-- scoped WHERE kind = 'flow' so campaign/test rows (flow_run_id IS NULL)
-- never contend with it.
ALTER TABLE "sends" ADD COLUMN "flow_run_id" uuid;--> statement-breakpoint
ALTER TABLE "sends" ADD COLUMN "node_id" text;--> statement-breakpoint
ALTER TABLE "sends" ADD CONSTRAINT "sends_flow_run_id_flow_runs_id_fk" FOREIGN KEY ("flow_run_id") REFERENCES "public"."flow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX sends_flow_run_node_unique ON sends (workspace_id, flow_run_id, node_id) WHERE kind = 'flow';
