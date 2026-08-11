CREATE TABLE "csv_import_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"csv_import_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"raw" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	CONSTRAINT "csv_import_rows_import_row_unique" UNIQUE("csv_import_id","row_number")
);
--> statement-breakpoint
CREATE TABLE "csv_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"duplicate_policy" text DEFAULT 'update' NOT NULL,
	"mapping" jsonb,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"processed_rows" integer DEFAULT 0 NOT NULL,
	"summary" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- NOTE (hand-adjusted after `drizzle-kit generate`): the generated diff also
-- tried to `CREATE TABLE "events"` + its two FKs again, because
-- packages/db/src/schema/events.ts has never had a drizzle-kit-generated
-- snapshot -- its PHYSICAL table was created by the hand-written
-- 0007_events_partitioned.sql (declarative partitioning has no pgTable
-- expression; see that file's and events.ts's own comments). Re-running
-- those statements here would fail with "relation already exists" against
-- an already-applied database. Stripped; only the two brand-new CSV-import
-- tables below are new DDL. The accompanying 0008_snapshot.json now
-- correctly records `events`, so future `drizzle-kit generate` runs will
-- stop re-proposing it.
ALTER TABLE "csv_import_rows" ADD CONSTRAINT "csv_import_rows_csv_import_id_csv_imports_id_fk" FOREIGN KEY ("csv_import_id") REFERENCES "public"."csv_imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "csv_import_rows" ADD CONSTRAINT "csv_import_rows_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "csv_imports" ADD CONSTRAINT "csv_imports_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;