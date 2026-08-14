-- GSD 08-05 linter fixture — NOT a real migration, never applied to any database.
-- Both placements drizzle-kit `generate` emits, which the rule must accept:
--   1. the delimiter alone on its own line
--   2. the delimiter appended directly after a completed statement's `;`
--
-- The prose here refers to the convention by name only ("statement-breakpoint"),
-- without the "-->" prefix, which is how a comment discusses it safely.
CREATE TABLE "widgets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "widgets" ADD CONSTRAINT "widgets_name_unique" UNIQUE("name");--> statement-breakpoint
CREATE INDEX "widgets_name_idx" ON "widgets" ("name");
