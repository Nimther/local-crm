import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as authSchema from "./schema/auth.js";
import * as sendgridKeysSchema from "./schema/sendgrid-keys.js";
import * as contactsSchema from "./schema/contacts.js";
import * as suppressionsSchema from "./schema/suppressions.js";
import * as propertyRegistrySchema from "./schema/property-registry.js";
import * as apiKeysSchema from "./schema/api-keys.js";
import * as eventsSchema from "./schema/events.js";
import * as csvImportsSchema from "./schema/csv-imports.js";
import * as segmentsSchema from "./schema/segments.js";
import * as campaignsSchema from "./schema/campaigns.js";
import * as campaignRecipientsSchema from "./schema/campaign-recipients.js";
import * as sendsSchema from "./schema/sends.js";
import * as workspaceSendSettingsSchema from "./schema/workspace-send-settings.js";
import * as sendEventsSchema from "./schema/send-events.js";
import * as webhookEndpointsSchema from "./schema/webhook-endpoints.js";
import * as flowsSchema from "./schema/flows.js";
import * as flowVersionsSchema from "./schema/flow-versions.js";
import * as flowRunsSchema from "./schema/flow-runs.js";
import * as flowRunStepsSchema from "./schema/flow-run-steps.js";
import * as flowSegmentMembershipSnapshotSchema from "./schema/flow-segment-membership-snapshot.js";
import * as subscriptionStatusHistorySchema from "./schema/subscription-status-history.js";
import * as workspaceDailyRollupSchema from "./schema/workspace-daily-rollup.js";

const schema = {
  ...authSchema,
  ...sendgridKeysSchema,
  ...contactsSchema,
  ...suppressionsSchema,
  ...propertyRegistrySchema,
  ...apiKeysSchema,
  ...eventsSchema,
  ...csvImportsSchema,
  ...segmentsSchema,
  ...campaignsSchema,
  ...campaignRecipientsSchema,
  ...sendsSchema,
  ...workspaceSendSettingsSchema,
  ...sendEventsSchema,
  ...webhookEndpointsSchema,
  ...flowsSchema,
  ...flowVersionsSchema,
  ...flowRunsSchema,
  ...flowRunStepsSchema,
  ...flowSegmentMembershipSnapshotSchema,
  ...subscriptionStatusHistorySchema,
  ...workspaceDailyRollupSchema,
};

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL must be set to construct the Drizzle client (@mega-crm/db)");
}

const pool = new Pool({ connectionString: databaseUrl });

/**
 * Drizzle client used for better-auth's drizzleAdapter and any non-tenant
 * query (e.g. workspace-slug uniqueness lookups). This client is NOT the
 * tenant-scoped RLS pool — see apps/api/src/db.ts + middleware/tenant-context.ts
 * for the pool that runs `SET LOCAL app.current_workspace_id` per transaction.
 */
export const db = drizzle(pool, { schema });

export * from "./schema/auth.js";
export * from "./schema/sendgrid-keys.js";
export * from "./schema/contacts.js";
export * from "./schema/suppressions.js";
export * from "./schema/property-registry.js";
export * from "./schema/api-keys.js";
export * from "./schema/events.js";
export * from "./schema/csv-imports.js";
export * from "./schema/segments.js";
export * from "./schema/campaigns.js";
export * from "./schema/campaign-recipients.js";
export * from "./schema/sends.js";
export * from "./schema/workspace-send-settings.js";
export * from "./schema/send-events.js";
export * from "./schema/webhook-endpoints.js";
export * from "./schema/flows.js";
export * from "./schema/flow-versions.js";
export * from "./schema/flow-runs.js";
export * from "./schema/flow-run-steps.js";
export * from "./schema/flow-segment-membership-snapshot.js";
export * from "./schema/subscription-status-history.js";
export * from "./schema/workspace-daily-rollup.js";
export { TENANT_GUC_KEY } from "./rls.js";
