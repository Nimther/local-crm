CREATE TYPE "public"."subscription_status" AS ENUM('subscribed', 'unsubscribed', 'suppressed');--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"external_id" text,
	"email" text,
	"first_name" text,
	"last_name" text,
	"phone" text,
	"city" text,
	"country" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"subscription_status" "subscription_status" DEFAULT 'subscribed' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_workspace_external_id_unique" UNIQUE("workspace_id","external_id"),
	CONSTRAINT "contacts_workspace_email_unique" UNIQUE("workspace_id","email")
);
--> statement-breakpoint
CREATE TABLE "workspace_property_registry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"observed_type" text NOT NULL,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_property_registry_workspace_key_unique" UNIQUE("workspace_id","key")
);
--> statement-breakpoint
CREATE TABLE "workspace_suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email" text NOT NULL,
	"reason" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_suppressions_workspace_email_unique" UNIQUE("workspace_id","email")
);
--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_property_registry" ADD CONSTRAINT "workspace_property_registry_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_suppressions" ADD CONSTRAINT "workspace_suppressions_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;