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
import * as flowSegmentSweepCheckpointSchema from "./schema/flow-segment-sweep-checkpoint.js";
import * as subscriptionStatusHistorySchema from "./schema/subscription-status-history.js";
import * as workspaceDailyRollupSchema from "./schema/workspace-daily-rollup.js";
import * as partitionMaintenanceRunsSchema from "./schema/partition-maintenance-runs.js";
import * as sendReconcilerRunsSchema from "./schema/send-reconciler-runs.js";
import * as deadLetterJobsSchema from "./schema/dead-letter-jobs.js";
import * as ingressJournalSchema from "./schema/ingress-journal.js";
import * as sendEventQuarantineSchema from "./schema/send-event-quarantine.js";
import * as reputationAlertStateSchema from "./schema/reputation-alert-state.js";
import * as ingestionAlertStateSchema from "./schema/ingestion-alert-state.js";
import * as erasureRecordsSchema from "./schema/erasure-records.js";
import * as workspaceSuppressionKeysSchema from "./schema/workspace-suppression-keys.js";

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
  ...flowSegmentSweepCheckpointSchema,
  ...subscriptionStatusHistorySchema,
  ...workspaceDailyRollupSchema,
  ...partitionMaintenanceRunsSchema,
  ...sendReconcilerRunsSchema,
  ...deadLetterJobsSchema,
  ...ingressJournalSchema,
  ...sendEventQuarantineSchema,
  ...reputationAlertStateSchema,
  ...ingestionAlertStateSchema,
  ...erasureRecordsSchema,
  ...workspaceSuppressionKeysSchema,
};

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL must be set to construct the Drizzle client (@mega-crm/db)");
}

const pool = new Pool({ connectionString: databaseUrl });

// CR-03 precedent (see authPool below / @mega-crm/tenant-context's pool.on):
// without this listener an idle-connection termination surfaces as an
// uncaught 'error' event and crashes the process.
pool.on("error", (err) => {
  console.error("idle pg pool client error (connection dropped)", err);
});

/**
 * Drizzle client used for any non-tenant, app-role query (e.g. workspace-slug
 * uniqueness lookups, the four workspace-shaped better-auth tables' own
 * read/write sites in apps/api/src/modules/tenancy). This client is NOT the
 * tenant-scoped RLS pool — see apps/api/src/db.ts + middleware/tenant-context.ts
 * for the pool that runs `SET LOCAL app.current_workspace_id` per transaction.
 * As of Phase 10 (SEC-05) it is also no longer better-auth's own adapter pool
 * — see `authDb` below.
 */
export const db = drizzle(pool, { schema });

/**
 * Phase 10 (SEC-05, D-04) — better-auth's drizzleAdapter pool, connecting as
 * the dedicated `mega_crm_auth` login role rather than `mega_crm_app`. Built
 * LAZILY (mirrors `packages/tenant-context/src/scan.ts`'s `getScanPool`
 * pattern), not at module load like `pool`/`db` above: the worker process
 * imports `@mega-crm/db` too (for its own non-auth queries) but no worker
 * source imports the better-auth schema or holds `AUTH_DATABASE_URL`, so
 * eager construction here would throw at worker boot for no reason. Exposed
 * as a Drizzle client (not a factory function) via a Proxy so call sites
 * (`drizzleAdapter(authDb, ...)`) are unchanged from the `db` shape they
 * replace — the underlying pool is constructed on first property access.
 */
let authPool: Pool | undefined;
let authDbInstance: ReturnType<typeof drizzle<typeof schema>> | undefined;

function getAuthDb(): ReturnType<typeof drizzle<typeof schema>> {
  if (!authDbInstance) {
    const authDatabaseUrl = process.env.AUTH_DATABASE_URL;
    if (!authDatabaseUrl) {
      throw new Error("AUTH_DATABASE_URL must be set to construct the auth Drizzle client (@mega-crm/db)");
    }
    authPool = new Pool({ connectionString: authDatabaseUrl });
    // CR-03 precedent (see `pool` above / scan.ts's getScanPool): without
    // this listener an idle-connection termination surfaces as an uncaught
    // 'error' event and crashes the process.
    authPool.on("error", (err) => {
      console.error("idle auth pg pool client error (connection dropped)", err);
    });
    authDbInstance = drizzle(authPool, { schema });
  }
  return authDbInstance;
}

export const authDb: ReturnType<typeof drizzle<typeof schema>> = new Proxy(
  {} as ReturnType<typeof drizzle<typeof schema>>,
  {
    get(_target, prop, receiver): unknown {
      return Reflect.get(getAuthDb(), prop, receiver) as unknown;
    },
  },
);

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
export * from "./schema/flow-segment-sweep-checkpoint.js";
export * from "./schema/subscription-status-history.js";
export * from "./schema/workspace-daily-rollup.js";
export * from "./schema/partition-maintenance-runs.js";
export * from "./schema/send-reconciler-runs.js";
export * from "./schema/dead-letter-jobs.js";
export * from "./schema/reputation-alert-state.js";
export * from "./schema/ingestion-alert-state.js";
export * from "./schema/workspace-suppression-keys.js";
// Phase 13 (CMP-04, plan 13-13, Rule 3 -- blocking): erasure-records.ts was
// imported into the merged `schema` object above (plan 13-10) but never
// re-exported from this module's public surface, so `ErasureRecordStatus`
// and the `erasureRecords` table were unreachable from any consumer of
// `@mega-crm/db` -- this plan is the first to need them.
export * from "./schema/erasure-records.js";
export { TENANT_GUC_KEY } from "./rls.js";
