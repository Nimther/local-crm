-- 05-03: delivery-tracking fact + reason columns on sends (WBHK-04, D-06,
-- D-09). Each timestamptz fact column is set AT MOST ONCE by the webhook
-- worker via a `WHERE <col> IS NULL` first-write UPDATE -- never overwritten
-- by a later or replayed event.
ALTER TABLE "sends" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sends" ADD COLUMN "first_opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sends" ADD COLUMN "first_clicked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sends" ADD COLUMN "bounced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sends" ADD COLUMN "dropped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sends" ADD COLUMN "unsubscribed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sends" ADD COLUMN "spam_reported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sends" ADD COLUMN "bounce_reason" text;--> statement-breakpoint
ALTER TABLE "sends" ADD COLUMN "drop_reason" text;
