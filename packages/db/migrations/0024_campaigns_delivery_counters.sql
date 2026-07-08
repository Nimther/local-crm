-- 05-03: unique-recipient delivery counters on campaigns (D-07/D-09).
-- Incremented exactly once per send the first time its matching `sends`
-- fact column is set (mirrors sent_count/failed_count precedent).
-- bounced_count groups both hard-bounce and address-drop terminals
-- ("не доставлено", D-08) -- the distinguishing reason stays queryable
-- per-send via sends.bounce_reason/drop_reason.
ALTER TABLE "campaigns" ADD COLUMN "delivered_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "opened_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "clicked_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "bounced_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "unsubscribed_count" integer DEFAULT 0 NOT NULL;
