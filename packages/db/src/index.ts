import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { createPgPool } from "./pool.js";
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
import * as partitionRetentionDropsSchema from "./schema/partition-retention-drops.js";
import * as opsAlertStateSchema from "./schema/ops-alert-state.js";
import * as purgeRecordsSchema from "./schema/purge-records.js";

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
  ...partitionRetentionDropsSchema,
  ...opsAlertStateSchema,
  ...purgeRecordsSchema,
};

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL must be set to construct the Drizzle client (@mega-crm/db)");
}

// Phase 14 plan 03 (DB-14, D-11): built through the shared createPgPool
// factory (packages/db/src/pool.ts) -- the error handler, the TLS decision
// and this pool's explicit named size ("db" in PG_POOL_SIZES) all live
// there now, not here.
const pool = createPgPool({ connectionString: databaseUrl, name: "db" });

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
    // Phase 14 plan 03 (DB-14, D-11): same factory as `pool` above, named
    // "auth" in PG_POOL_SIZES.
    authPool = createPgPool({ connectionString: authDatabaseUrl, name: "auth" });
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
// Phase 14 plan 12 (DB-11): the retention drop ledger's own type-inference
// shape -- see that file's header for why it exists alongside
// partition_maintenance_runs.retention_status/retention_error rather than
// instead of it.
export * from "./schema/partition-retention-drops.js";
// Phase 15 plan 12 (OPS-13): the shared alert-dedup table's own
// type-inference shape -- see that file's header for the keyed-not-singleton
// rationale.
export * from "./schema/ops-alert-state.js";
// Phase 22 (PRG-01/PRG-02/PRG-03/PRG-05, plan 22-01): the workspace-purge
// checkpoint-plus-evidence table's own type-inference shape -- see that
// file's header for the RLS-free/FK-free rationale.
export * from "./schema/purge-records.js";
// Phase 22 (plan 22-01): the frozen purge table allowlist and its batched-
// DELETE/count primitives -- lives in packages/db (not apps/worker) because
// 22-06's restore path and report builder, both in packages/db, need to
// import PURGE_ADVISORY_LOCK_NAMESPACE / PURGE_TABLE_ORDER / countPurgeTableRows
// too, and a package cannot depend back on an app.
export * from "./workspace-purge-tables.js";
// Phase 22 (PRG-05, D-13/D-14/D-15, plan 22-06): the restore half of the
// purge state machine -- see that file's header for the shared-advisory-lock
// and D-15 overdue-campaign rationale.
export * from "./workspace-restore.js";
// Phase 22 (PRG-01, D-07, plan 22-06): the on-demand eligibility census the
// operator report CLI builds -- see that file's header for why it never
// writes.
export * from "./workspace-purge-report.js";
export { TENANT_GUC_KEY } from "./rls.js";
// Phase 14 plan 01 (D-13, DB-05/DB-06, OPS-04/OPS-05): the one shared
// definition of "a migration is applied", consumed by scripts/migrate-runner.mjs
// (indirectly, via drizzle-orm's own migrate()) and apps/api's /readyz route
// (directly, via assertMigrationsCurrent).
export * from "./migration-journal.js";
// Phase 14 plan 03 (DB-14, D-11): the one factory every first-party
// production Postgres pool must go through (Task 1/2). Re-exported from the
// package root for consumers that already import from "@mega-crm/db" and
// have DATABASE_URL available at that point; consumers that must NOT
// eagerly construct this module's own top-level `pool`/`authDb` (e.g.
// packages that stay dependency-light on env vars, per scan.ts's own lazy
// pattern) import "@mega-crm/db/src/pool.js" directly instead -- see
// packages/tenant-context's migrated call sites for that precedent.
export * from "./pool.js";
