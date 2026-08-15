import { Queue, Worker, type ConnectionOptions } from "bullmq";
import type { PoolClient } from "pg";
import { withCrossWorkspaceScan, withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { scrubbedConsole } from "@mega-crm/redaction";
import { buildJobOptions, STANDARD_JOB_RETENTION } from "@mega-crm/queue-core";
import { REPUTATION_TICK_SCHEMA_VERSION, reputationTickJobSchema } from "@mega-crm/shared-schemas";
import {
  classifyReputationRate,
  REPUTATION_WINDOW_DAYS,
  type ReputationMetric,
  type ReputationObservation,
} from "@mega-crm/delivery-core";
import { wrapProcessor } from "../processor-wrapper.js";

/**
 * Phase 13 (CMP-09, D-09 through D-12, plan 13-09): the measurement half of
 * the reputation watchdog. Computes each tenant's spam-complaint rate and
 * hard-bounce rate over a rolling window from the delivery fact columns the
 * platform already records (`sends.delivered_at`/`spam_reported_at`/
 * `bounced_at`), tiers them via `@mega-crm/delivery-core`'s pure
 * `classifyReputationRate`, and records the observation into
 * `reputation_alert_state` (migration 0058, plan 13-09 Task 2). Plan 13-11
 * turns a recorded tier crossing into operator/tenant email -- nothing in
 * this file pauses, throttles, or blocks sending.
 *
 * Discovery/write shape mirrors `analytics-reconciliation.worker.ts`/
 * `send-reconciler.worker.ts` exactly: workspace enumeration goes through
 * `withCrossWorkspaceScan` on the dedicated `mega_crm_scan` role (this
 * plan's only cross-tenant read -- `SELECT id FROM organization`, already
 * covered by migration 0042's grant list), and every per-workspace count +
 * write happens inside that workspace's own fresh `withTenant`/
 * `withTenantTransaction` scope. `reputation_alert_state` carries no RLS of
 * its own (migration 0058's own header comment), so this per-workspace
 * transaction's role -- `mega_crm_app`, which owns the table -- can write it
 * regardless of the tenant GUC; the `withTenant` scope here exists purely to
 * compute the `sends` counts under that workspace's own RLS-scoped read, not
 * to gate access to `reputation_alert_state` itself.
 */

export const REPUTATION_TICK_QUEUE = "reputation-tick";

/**
 * One hour. The ratio is computed over a `REPUTATION_WINDOW_DAYS` (7-day)
 * window, so it moves slowly and a shorter cadence would burn cross-tenant
 * scans without changing any decision a tighter interval could surface
 * sooner. One hour is well inside the cooldown window plan 13-11 will use
 * for re-firing an alert, so a tier crossing is observed long before it
 * could be alerted twice.
 */
export const REPUTATION_TICK_INTERVAL_MS = 60 * 60_000;

/**
 * The stable id `upsertJobScheduler` dedupes by -- constant across every
 * boot, mirrors every other repeatable-tick worker's own scheduler id, so
 * registering it on every worker boot never creates a second competing
 * schedule. This queue is brand new (no pre-existing `tickQueue.add({repeat})`
 * registration to migrate away from), so this file carries no
 * `LEGACY_*`/`removeRepeatable` cleanup block.
 */
const JOB_SCHEDULER_ID = "reputation-tick";

const JOB_NAME = "run-reputation-tick";

/** Built through the shared `@mega-crm/queue-core` factory (Phase 12, WRK-11, D-10). */
const DEFAULT_JOB_OPTIONS = buildJobOptions(STANDARD_JOB_RETENTION);

interface WorkspaceRow {
  id: string;
}

/** Raw numerator/denominator pair for one metric, before tiering. */
export interface ReputationRawCounts {
  numerator: number;
  denominator: number;
}

export interface WorkspaceReputationCounts {
  complaintRate: ReputationRawCounts;
  hardBounceRate: ReputationRawCounts;
}

/**
 * Counts, within the rolling window ending at `now`, the delivered
 * denominator and each metric's own numerator, over one workspace's `sends`.
 *
 * Window-membership anchoring (CMP-02's "eliminate day-semantics ambiguity"
 * concern, applied here to window membership rather than calendar-day
 * bucketing): each count is windowed on ITS OWN fact column, never on
 * `delivered_at` for every column uniformly. `complaint_rate`'s numerator is
 * "spam reports RECEIVED in the last 7 days" (`spam_reported_at` inside the
 * window), regardless of when the underlying send was delivered -- a send
 * delivered 10 days ago that received a late spam report 2 days ago DOES
 * count, because what a mailbox provider judges TODAY is complaint volume
 * arriving recently, not complaints paired to recently-delivered mail. The
 * alternative (windowing every column on `delivered_at`) would silently drop
 * exactly that case -- a send delivered outside the window but complained
 * about inside it -- undercounting the tenant's current complaint exposure.
 * The same reasoning anchors `hard_bounce_rate`'s numerator on `bounced_at`.
 * The shared `delivered` denominator is windowed on its own natural anchor,
 * `delivered_at`.
 *
 * Plain `timestamptz >= / <=` range comparisons need no `AT TIME ZONE 'UTC'`
 * cast (unlike `analytics-reconciliation.worker.ts`'s `::date` bucketing,
 * plan 13-02's Pitfall 1 lesson): a `timestamptz` comparison is an absolute
 * instant comparison, session-`TimeZone`-GUC-independent by construction --
 * that pitfall applies only to casting a `timestamptz` down to a `date`.
 */
export async function computeWorkspaceReputation(client: PoolClient, now: Date): Promise<WorkspaceReputationCounts> {
  const windowStart = new Date(now.getTime() - REPUTATION_WINDOW_DAYS * 24 * 60 * 60_000);

  const { rows } = await client.query<{
    deliveredCount: string;
    complaintCount: string;
    bounceCount: string;
  }>(
    `SELECT
       count(*) FILTER (WHERE delivered_at IS NOT NULL AND delivered_at >= $1 AND delivered_at <= $2) AS "deliveredCount",
       count(*) FILTER (WHERE spam_reported_at IS NOT NULL AND spam_reported_at >= $1 AND spam_reported_at <= $2) AS "complaintCount",
       count(*) FILTER (WHERE bounced_at IS NOT NULL AND bounced_at >= $1 AND bounced_at <= $2) AS "bounceCount"
     FROM sends`,
    [windowStart, now],
  );

  const row = rows[0];
  const deliveredCount = Number(row?.deliveredCount ?? 0);
  const complaintCount = Number(row?.complaintCount ?? 0);
  const bounceCount = Number(row?.bounceCount ?? 0);

  return {
    complaintRate: { numerator: complaintCount, denominator: deliveredCount },
    hardBounceRate: { numerator: bounceCount, denominator: deliveredCount },
  };
}

/**
 * Upserts one workspace's one-metric observation, writing ONLY the
 * `observed_*` columns (plus `updated_at`) -- the SET list below must never
 * name `alerted_tier`/`last_alert_sent_at`, which belong exclusively to
 * plan 13-11's watchdog claim (migration 0058's disjoint-column-set
 * contract). `ON CONFLICT (workspace_id, metric)` is an ABSOLUTE OVERWRITE,
 * never additive: running this twice with an unchanged input must leave the
 * row byte-identical (besides `updated_at`), mirroring
 * `reconcileWorkspaceDay`'s own overwrite-not-accumulate contract.
 */
export async function recordReputationObservation(
  client: PoolClient,
  workspaceId: string,
  observation: ReputationObservation,
  observedAt: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO reputation_alert_state (
       workspace_id, metric, observed_tier, observed_rate, observed_numerator, observed_denominator, observed_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (workspace_id, metric) DO UPDATE SET
       observed_tier = EXCLUDED.observed_tier,
       observed_rate = EXCLUDED.observed_rate,
       observed_numerator = EXCLUDED.observed_numerator,
       observed_denominator = EXCLUDED.observed_denominator,
       observed_at = EXCLUDED.observed_at,
       updated_at = now()`,
    [
      workspaceId,
      observation.metric satisfies ReputationMetric,
      observation.tier,
      observation.rate,
      observation.numerator,
      observation.denominator,
      observedAt,
    ],
  );
}

/**
 * One workspace's full tick body: compute both ratios, tier each via the
 * pure `classifyReputationRate`, and record BOTH observations in the SAME
 * `withTenant`/`withTenantTransaction` scope (Pitfall 5 precedent: every
 * workspace gets its own transaction/GUC; never shared across two workspace
 * ids). Records an observation for every workspace, including healthy and
 * below-floor ones -- a table that only contained threshold-crossers could
 * not distinguish "this tenant is fine" from "this tenant was never
 * measured", which is an operational blind spot a watchdog cannot report.
 */
async function runWorkspaceTick(workspaceId: string, now: Date): Promise<void> {
  await withTenant(workspaceId, () =>
    withTenantTransaction(async (client) => {
      const counts = await computeWorkspaceReputation(client, now);

      const complaintObservation = classifyReputationRate(
        "complaint_rate",
        counts.complaintRate.numerator,
        counts.complaintRate.denominator,
      );
      const hardBounceObservation = classifyReputationRate(
        "hard_bounce_rate",
        counts.hardBounceRate.numerator,
        counts.hardBounceRate.denominator,
      );

      await recordReputationObservation(client, workspaceId, complaintObservation, now);
      await recordReputationObservation(client, workspaceId, hardBounceObservation, now);
    }),
  );
}

export interface RunReputationTickOptions {
  /**
   * Test-only override of the tick's `now` -- every assertion in this
   * plan's test suite drives an injected clock so no case depends on the
   * wall clock (this module's own pure-function precedent,
   * `@mega-crm/delivery-core`'s `classifyReputationRate`). Production
   * (`createReputationTickWorker`'s processor) always omits this.
   */
  now?: Date;
  /**
   * Test-only: restricts the cross-workspace discovery scan to exactly
   * these workspace ids instead of every workspace in the database -- the
   * ephemeral test database is shared across parallel test files (this
   * project's wave-context convention: workspace-scoped assertions only).
   * Every production call (`createReputationTickWorker`'s processor) omits
   * this and scans every workspace.
   */
  workspaceIds?: string[];
}

/**
 * Discovery + per-workspace compute-tier-record, once. Exported standalone
 * (mirrors `runReconcilerTick`/`runWebhookReplaySweep`) so the test suite
 * can drive a full tick directly without a live BullMQ `Worker`.
 *
 * Enumerates workspaces through `withCrossWorkspaceScan` -- never a
 * tenant-scoped query, which cannot see across workspaces under RLS -- on
 * the dedicated `mega_crm_scan` role, mirroring
 * `analytics-reconciliation.worker.ts`'s own `SELECT id FROM organization`
 * exactly (`organization` carries no RLS of its own; migration 0042 grants
 * SELECT on it to `mega_crm_scan` with no accompanying policy).
 */
export async function runReputationTick(options: RunReputationTickOptions = {}): Promise<{ workspacesScanned: number }> {
  const now = options.now ?? new Date();

  const workspaceIds = await withCrossWorkspaceScan(async (client) => {
    const { rows } = await client.query<WorkspaceRow>(
      options.workspaceIds ? `SELECT id FROM organization WHERE id = ANY($1::uuid[])` : `SELECT id FROM organization`,
      options.workspaceIds ? [options.workspaceIds] : [],
    );
    return rows.map((row) => row.id);
  });

  for (const workspaceId of workspaceIds) {
    await runWorkspaceTick(workspaceId, now);
  }

  scrubbedConsole.log("reputation-tick: tick complete", { workspacesScanned: workspaceIds.length });
  return { workspacesScanned: workspaceIds.length };
}

/**
 * Test-only synchronization, mirrors `send-reconciler.worker.ts`'s/
 * `webhook-replay-sweep.worker.ts`'s identical WeakMap:
 * `createReputationTickWorker`'s own scheduler registration is
 * fire-and-forget in production. Lets `waitForReputationTickRegistration`
 * hand a test a promise that resolves only once registration (including
 * closing that internal handle) has actually settled, instead of sleeping.
 */
const registrationSettled = new WeakMap<Worker, Promise<void>>();

/**
 * Test-only: resolves once the `Worker` returned by
 * `createReputationTickWorker` has finished registering its scheduler (and
 * closed its own internal tick-registration `Queue` handle). Not used by
 * production code.
 */
export function waitForReputationTickRegistration(worker: Worker): Promise<void> {
  return registrationSettled.get(worker) ?? Promise.resolve();
}

export interface CreateReputationTickWorkerOptions {
  /**
   * Test-only, mirrors every other repeatable-tick worker's identical
   * option: BullMQ Workers start processing immediately on construction;
   * the scheduler-registration test asserts what gets REGISTERED without
   * wanting a real tick to race those assertions against a live database.
   * Omitted entirely from the constructed worker's options unless a caller
   * supplies it (G-12-1): forwarding this key with an `undefined` value
   * under the composition root's one-argument call shape would overwrite
   * BullMQ's own enabling default rather than fall back to it, silently
   * disabling the run loop.
   */
  autorun?: boolean;
}

/**
 * Constructs the repeatable reputation-tick Worker: registers the
 * one-hour job-scheduler tick (idempotent by `JOB_SCHEDULER_ID`) via the
 * SAME `upsertJobScheduler` + immediate boot job + try/catch/finally shape
 * `analytics-reconciliation.worker.ts`/`webhook-replay-sweep.worker.ts` use,
 * then processes each tick by validating the job payload against
 * `reputationTickJobSchema` (R-05) BEFORE ever calling `runReputationTick`
 * -- a `schemaVersion` this worker does not recognize is DEFERRED (logged,
 * the processor returns without processing) rather than best-effort
 * processed. The boot job's own payload also carries the current
 * `schemaVersion` (not an empty `{}`) so it passes this SAME validation
 * rather than deferring itself on every worker startup.
 */
export function createReputationTickWorker(
  connection: ConnectionOptions,
  options: CreateReputationTickWorkerOptions = {},
): Worker {
  const queue = new Queue(REPUTATION_TICK_QUEUE, { connection });
  const bootJobId = `boot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const worker = new Worker(
    REPUTATION_TICK_QUEUE,
    wrapProcessor(REPUTATION_TICK_QUEUE, async (job) => {
      const parsed = reputationTickJobSchema.safeParse(job.data);
      if (!parsed.success) {
        scrubbedConsole.error("reputation-tick: deferring job with an unrecognized payload shape", {
          jobId: job.id,
        });
        return;
      }
      await runReputationTick();
    }),
    // G-12-1: the `autorun` key is included ONLY when a caller actually
    // supplied a value -- never nullish-coalesced to a restated `true`,
    // which would be a second source of truth for a value BullMQ already
    // owns. Under the composition root's single-argument call shape,
    // `options.autorun` is `undefined` and this spread contributes nothing,
    // leaving BullMQ's own default in effect.
    { connection, ...(options.autorun !== undefined ? { autorun: options.autorun } : {}) },
  );

  // Fire-and-forget registration -- mirrors analytics-reconciliation.worker.ts's/
  // webhook-replay-sweep.worker.ts's try/catch/finally exactly: a Redis
  // hiccup at boot must log, not crash every other registered worker via an
  // unhandled promise rejection; the `finally` always closes this
  // short-lived internal Queue handle so a failure here never leaks a
  // standalone Redis connection past construction.
  const registration = (async () => {
    try {
      await queue.upsertJobScheduler(
        JOB_SCHEDULER_ID,
        { every: REPUTATION_TICK_INTERVAL_MS },
        {
          name: JOB_NAME,
          data: { schemaVersion: REPUTATION_TICK_SCHEMA_VERSION },
          opts: DEFAULT_JOB_OPTIONS,
        },
      );
      await queue.add(JOB_NAME, { schemaVersion: REPUTATION_TICK_SCHEMA_VERSION }, { ...DEFAULT_JOB_OPTIONS, jobId: bootJobId });
    } catch (err) {
      scrubbedConsole.error("reputation-tick: scheduler registration failed", err);
    } finally {
      await queue.close().catch(() => undefined);
    }
  })();
  registrationSettled.set(worker, registration);

  return worker;
}
