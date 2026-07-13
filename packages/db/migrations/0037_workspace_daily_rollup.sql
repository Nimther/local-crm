-- 07-06: per-workspace-per-day analytics rollup table (ANLT-04). Maintained
-- incrementally (webhook worker, same-transaction increment) AND reconciled
-- periodically (analytics-reconciliation.worker.ts overwrite from a fresh
-- COUNT over sends) -- see workspace-daily-rollup.ts's doc comment.

CREATE TABLE "workspace_daily_rollup" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"day" date NOT NULL,
	"sent_count" integer DEFAULT 0 NOT NULL,
	"delivered_count" integer DEFAULT 0 NOT NULL,
	"opened_count" integer DEFAULT 0 NOT NULL,
	"clicked_count" integer DEFAULT 0 NOT NULL,
	"bounced_count" integer DEFAULT 0 NOT NULL,
	"unsubscribed_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_daily_rollup" ADD CONSTRAINT "workspace_daily_rollup_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_daily_rollup" ADD CONSTRAINT "workspace_daily_rollup_workspace_day_unique" UNIQUE ("workspace_id", "day");--> statement-breakpoint

-- RLS: ENABLE + FORCE + NULLIF-guarded workspace_isolation, applied from this
-- FIRST migration (0026_flows.sql precedent -- do not defer the NULLIF guard
-- to a follow-up fix, per the 0019 lesson).
ALTER TABLE workspace_daily_rollup ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_daily_rollup FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON workspace_daily_rollup
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
