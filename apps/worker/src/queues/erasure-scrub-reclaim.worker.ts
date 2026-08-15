import { Queue, Worker, type ConnectionOptions, type Job } from "bullmq";
import type { PoolClient } from "pg";
import { withCrossWorkspaceScan, withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { scrubbedConsole } from "@mega-crm/redaction";
import { buildJobOptions, buildRedisConnectionOptions, STANDARD_JOB_RETENTION } from "@mega-crm/queue-core";
import {
  ERASURE_SCRUB_QUEUE,
  ERASURE_SCRUB_RECLAIM_TICK_SCHEMA_VERSION,
  erasureScrubReclaimTickJobSchema,
  buildErasureScrubJobPayload,
  buildErasureScrubJobId,
  type ErasureScrubJob,
} from "@mega-crm/shared-schemas";
import { registerTrackedQueue } from "./queue-registry.js";
import { wrapProcessor } from "../processor-wrapper.js";

/**
 * Phase 13 (CMP-04, D-04, R-05, plan 13-15): closes the last gap in CMP-04's
 * durability chain. Plan 13-10's `deleteContact` commits the anonymization,
 * the suppression insert, and the `erasure_records` row as ONE transaction,
 * and enqueues the scrub job only AFTER that transaction commits -- that
 * ordering is deliberate, and it is the safe one, but it has exactly one
 * failure mode: a crash, a Redis outage, or a process kill between the
 * commit and the enqueue leaves a durable `pending` `erasure_records` row
 * with no job behind it, and nothing else in this phase ever looks at it
 * again. This file is the half that makes "recoverable" true rather than
 * merely possible -- without it, the commit-then-enqueue ordering's whole
 * justification (that the failure state is durable and queryable) is
 * unearned, because nothing would ever query it.
 *
 * A scheduled tick (this file), not a boot-time sweep: a boot-time sweep is
 * cheaper and needs no queue, but recovery would then wait for the next
 * worker restart, which in a stable deployment can be weeks -- unacceptable
 * against a statutory erasure clock (CMP-04's flagged assumption, see
 * 13-15-SUMMARY.md).
 */

export const ERASURE_SCRUB_RECLAIM_QUEUE = "erasure-scrub-reclaim";

/**
 * 5 minutes, matching the sibling sweeps (`WEBHOOK_REPLAY_SWEEP_INTERVAL_MS`,
 * `RECONCILER_TICK_MS`'s order of magnitude). The tick is nearly free when
 * there is nothing to reclaim (one cross-workspace enumeration plus one
 * indexed per-workspace read), and an erasure is a compliance action with a
 * statutory clock -- discovering a stranded one within minutes rather than
 * hours costs nothing and buys the whole margin.
 */
export const ERASURE_SCRUB_RECLAIM_INTERVAL_MS = 5 * 60_000;

/**
 * 15 minutes. Must be comfortably longer than the widest plausible gap
 * between the erasure transaction's commit and a successful enqueue (a
 * single Redis round trip -- milliseconds in the normal case), and longer
 * than a normal scrub's duration for the `scrubbing` disjunct, or a healthy
 * in-progress scrub would be reclaimed underneath itself. Fifteen minutes is
 * the same order as `INGRESS_JOURNAL_STUCK_THRESHOLD_MINUTES` and for the
 * same reason: an order of magnitude above normal, so crossing it means
 * something actually broke. Plan 13-13's own SUMMARY records per-page scrub
 * timings well under this margin for the fixtures exercised there (see
 * 13-15-SUMMARY.md's own confirmation) -- if a future large-contact scrub is
 * observed to run longer, RAISE this value rather than shortening the scrub.
 */
export const ERASURE_SCRUB_RECLAIM_LEASE_MINUTES = 15;

/**
 * 100 per workspace per tick, so a mass-strand event (a Redis outage during
 * a bulk deletion) degrades into more ticks rather than one tick that floods
 * the scrub queue.
 */
export const ERASURE_SCRUB_RECLAIM_PAGE_LIMIT = 100;

/**
 * The stable id `upsertJobScheduler` dedupes by -- constant across every
 * boot, mirrors `webhook-replay-sweep.worker.ts`'s/`send-reconciler.worker.ts`'s
 * own scheduler ids, so registering it on every worker boot never creates a
 * second competing schedule. This queue is brand new (no pre-existing
 * `tickQueue.add({repeat})` registration to migrate away from).
 */
const JOB_SCHEDULER_ID = "erasure-scrub-reclaim-tick";

const JOB_NAME = "run-erasure-scrub-reclaim-tick";

/** Built through the shared `@mega-crm/queue-core` factory (Phase 12, WRK-11, D-10). */
const DEFAULT_JOB_OPTIONS = buildJobOptions(STANDARD_JOB_RETENTION);

function requireRedisUrl(): string {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL is required for apps/worker's erasure-scrub-reclaim producer");
  }
  return redisUrl;
}

/**
 * Lazily-created singleton producer `Queue` for `ERASURE_SCRUB_QUEUE`
 * (mirrors `webhook-replay-sweep.worker.ts`'s `getWebhookReplaySweepProducerQueue`
 * shape exactly): this tick is the SECOND producer of a queue plan 13-10's
 * `deleteContact` (apps/api) already produces onto. Registered with the
 * process-wide tracked-queue registry on first construction -- a genuinely
 * long-lived producer used on every tick, never closed after registration.
 */
let erasureScrubReclaimProducerQueue: Queue<ErasureScrubJob> | undefined;

function getErasureScrubReclaimProducerQueue(): Queue<ErasureScrubJob> {
  erasureScrubReclaimProducerQueue ??= registerTrackedQueue(
    new Queue<ErasureScrubJob>(ERASURE_SCRUB_QUEUE, {
      connection: buildRedisConnectionOptions(requireRedisUrl()),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    })
  );
  return erasureScrubReclaimProducerQueue;
}

export interface ReclaimableErasureRecordRow {
  id: string;
  workspaceId: string;
  contactId: string;
  status: "pending" | "scrubbing";
}

/**
 * Selects every reclaimable `erasure_records` row visible under the caller's
 * OWN tenant scope (the caller must already be inside a
 * `withTenant`/`withTenantTransaction` scope -- no explicit `workspace_id`
 * parameter here, mirroring `findDirtyRollupDays`'s identical convention:
 * scoped implicitly through RLS, never through an explicit filter). Two
 * disjuncts, both required:
 *
 * - `status = 'pending' AND requested_at < now() - lease` -- the
 *   crash-in-the-gap case this file exists to recover.
 * - `status = 'scrubbing' AND scrub_started_at < now() - lease` -- a worker
 *   that died mid-scrub. Included deliberately, not scope creep: a Redis
 *   flush or a worker kill strands a `scrubbing` record exactly as readily
 *   as a `pending` one, and re-running one is safe because plan 13-13 writes
 *   the resume cursor in the same transaction as each page's UPDATE, so a
 *   reclaimed scrub resumes from where it stopped rather than restarting.
 *
 * `complete` is excluded (nothing to do). `failed` is excluded too -- it is
 * a terminal, operator-visible outcome, not scope creep to leave alone:
 * re-enqueueing it would loop on a genuine error and overwrite the
 * `scrub_error` an operator needs. The right recovery for a `failed` record
 * is an operator decision, not an automatic loop.
 */
export async function findReclaimableErasureRecords(
  client: PoolClient,
  leaseMinutes: number,
  limit: number
): Promise<ReclaimableErasureRecordRow[]> {
  const { rows } = await client.query<ReclaimableErasureRecordRow>(
    `SELECT id, workspace_id as "workspaceId", contact_id as "contactId", status
     FROM erasure_records
     WHERE (status = 'pending' AND requested_at < now() - make_interval(mins => $1))
        OR (status = 'scrubbing' AND scrub_started_at < now() - make_interval(mins => $1))
     ORDER BY requested_at ASC
     LIMIT $2`,
    [leaseMinutes, limit]
  );
  return rows;
}

export interface ErasureScrubReclaimTickSummary {
  workspacesScanned: number;
  recordsReclaimed: number;
  workspacesErrored: number;
}

export interface RunErasureScrubReclaimOptions {
  /**
   * Test-only: restricts the cross-workspace discovery scan to exactly these
   * workspace ids instead of every workspace in the database -- the
   * ephemeral test database is shared across parallel test files (this
   * project's wave-context convention). Every production call
   * (`createErasureScrubReclaimWorker`'s processor) omits this and scans
   * every workspace.
   */
  workspaceIds?: string[];
  /** Test-only override of `ERASURE_SCRUB_RECLAIM_LEASE_MINUTES`. */
  leaseMinutes?: number;
  /** Test-only override of `ERASURE_SCRUB_RECLAIM_PAGE_LIMIT`. */
  pageLimit?: number;
}

interface WorkspaceRow {
  id: string;
}

/**
 * Cross-tenant workspace enumeration (T-13-15-05): the ONLY statement that
 * runs under `withCrossWorkspaceScan` -- `organization` is already granted
 * `SELECT` to `mega_crm_scan` (migration 0042), so this enumeration needs no
 * new grant. `erasure_records` itself gets NO scan grant and NO `_scan`
 * policy of its own -- every erasure-record read happens inside a
 * PER-WORKSPACE `withTenant` scope below, under the table's own fail-closed
 * `workspace_isolation` policy. The alternative (granting the scan role
 * access to `erasure_records`) would work and is the more obvious move, and
 * it widens a cross-tenant read surface over a compliance table for no gain.
 */
async function discoverWorkspaceIds(workspaceIds?: string[]): Promise<string[]> {
  return withCrossWorkspaceScan(async (client) => {
    const { rows } = await client.query<WorkspaceRow>(
      workspaceIds ? `SELECT id FROM organization WHERE id = ANY($1::uuid[])` : `SELECT id FROM organization`,
      workspaceIds ? [workspaceIds] : []
    );
    return rows.map((row) => row.id);
  });
}

/**
 * Discovery + per-workspace reclaim, once. Exported standalone (mirrors
 * `runWebhookReplaySweep`/`runReconcilerTick`) so the test suite can drive a
 * full tick directly without a live BullMQ `Worker`.
 *
 * Enumerates workspaces through `withCrossWorkspaceScan` exactly as every
 * other cross-tenant discovery scan in this codebase does, then opens a
 * fresh `withTenant`/`withTenantTransaction` scope per workspace to read
 * that workspace's own reclaimable records -- only the workspace ENUMERATION
 * itself uses the admin scan role.
 *
 * Builds each job through `buildErasureScrubJobPayload`/`buildErasureScrubJobId`
 * (`@mega-crm/shared-schemas`) -- the SAME derivation plan 13-10's
 * `deleteContact` uses for the SAME queue's other producer. This is the
 * load-bearing detail of the whole plan: there are two producers of this
 * job, and if each derived the id independently, each would be internally
 * consistent and the two would still collide on nothing, so reclaiming a
 * record whose job DID get enqueued would queue a second scrub over the same
 * contact. One exported derivation used by both is what turns that race into
 * a no-op (BullMQ's own jobId dedup). That dedup is a cheap first layer, not
 * the guarantee -- it only holds while the job is still in Redis; once a
 * completed job ages out under `STANDARD_JOB_RETENTION`, the same id can be
 * enqueued again. The authoritative idempotency is plan 13-13's own
 * already-complete check on the `erasure_records` row (`runErasureScrub`
 * returns immediately when its record's status is `complete`), which holds
 * regardless of Redis state.
 *
 * A single workspace's failure (a rejecting enqueue, a transient query
 * error) is caught and logged so it does not abort the remaining workspaces
 * -- a single tenant's transient failure must not stop every other tenant's
 * erasures from being reclaimed.
 */
export async function runErasureScrubReclaim(
  options: RunErasureScrubReclaimOptions = {}
): Promise<ErasureScrubReclaimTickSummary> {
  const leaseMinutes = options.leaseMinutes ?? ERASURE_SCRUB_RECLAIM_LEASE_MINUTES;
  const pageLimit = options.pageLimit ?? ERASURE_SCRUB_RECLAIM_PAGE_LIMIT;

  const workspaceIds = await discoverWorkspaceIds(options.workspaceIds);
  const producerQueue = getErasureScrubReclaimProducerQueue();

  let recordsReclaimed = 0;
  let workspacesErrored = 0;

  for (const workspaceId of workspaceIds) {
    try {
      const records = await withTenant(workspaceId, () =>
        withTenantTransaction((client) => findReclaimableErasureRecords(client, leaseMinutes, pageLimit))
      );

      for (const record of records) {
        const jobId = buildErasureScrubJobId(record.id);
        const payload = buildErasureScrubJobPayload(record.workspaceId, record.contactId, record.id);
        await producerQueue.add("erasure-scrub", payload, { jobId });
        recordsReclaimed += 1;
      }
    } catch (err) {
      workspacesErrored += 1;
      scrubbedConsole.error(
        "erasure-scrub-reclaim: workspace tick failed, continuing with remaining workspaces",
        err
      );
    }
  }

  const summary: ErasureScrubReclaimTickSummary = {
    workspacesScanned: workspaceIds.length,
    recordsReclaimed,
    workspacesErrored,
  };
  scrubbedConsole.log("erasure-scrub-reclaim: tick complete", summary);
  return summary;
}

/**
 * Test-only synchronization, mirrors `webhook-replay-sweep.worker.ts`'s/
 * `send-reconciler.worker.ts`'s identical WeakMap:
 * `createErasureScrubReclaimWorker`'s own scheduler registration is
 * fire-and-forget in production. Lets `waitForErasureScrubReclaimRegistration`
 * hand a test a promise that resolves only once registration has actually
 * settled, instead of sleeping.
 */
const registrationSettled = new WeakMap<Worker, Promise<void>>();

/**
 * Test-only: resolves once the `Worker` returned by
 * `createErasureScrubReclaimWorker` has finished registering its scheduler
 * (and closed its own internal tick-registration `Queue` handle). Not used
 * by production code.
 */
export function waitForErasureScrubReclaimRegistration(worker: Worker): Promise<void> {
  return registrationSettled.get(worker) ?? Promise.resolve();
}

export interface CreateErasureScrubReclaimWorkerOptions {
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
 * Constructs the repeatable erasure-scrub-reclaim Worker: registers the
 * 5-minute job-scheduler tick (idempotent by `JOB_SCHEDULER_ID`) via the
 * SAME `upsertJobScheduler` + immediate boot job + try/catch/finally shape
 * `webhook-replay-sweep.worker.ts`/`analytics-reconciliation.worker.ts` use,
 * then processes each tick by validating the job payload against
 * `erasureScrubReclaimTickJobSchema` (R-05) BEFORE ever calling
 * `runErasureScrubReclaim` -- a `schemaVersion` this worker does not
 * recognize is DEFERRED (logged, the processor returns without processing)
 * rather than best-effort-processed. The boot job's own payload also carries
 * the current `schemaVersion` (not an empty `{}`) so it passes this SAME
 * validation rather than deferring itself on every worker startup.
 */
export function createErasureScrubReclaimWorker(
  connection: ConnectionOptions,
  options: CreateErasureScrubReclaimWorkerOptions = {}
): Worker {
  const queue = new Queue(ERASURE_SCRUB_RECLAIM_QUEUE, { connection });
  const bootJobId = `boot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const worker = new Worker(
    ERASURE_SCRUB_RECLAIM_QUEUE,
    wrapProcessor(ERASURE_SCRUB_RECLAIM_QUEUE, async (job: Job) => {
      const parsed = erasureScrubReclaimTickJobSchema.safeParse(job.data);
      if (!parsed.success) {
        scrubbedConsole.error("erasure-scrub-reclaim: deferring job with an unrecognized payload shape", {
          jobId: job.id,
        });
        return;
      }
      await runErasureScrubReclaim();
    }),
    // G-12-1: the `autorun` key is included ONLY when a caller actually
    // supplied a value -- never nullish-coalesced to a restated `true`,
    // which would be a second source of truth for a value BullMQ already
    // owns. Under the composition root's single-argument call shape,
    // `options.autorun` is `undefined` and this spread contributes nothing,
    // leaving BullMQ's own default in effect.
    { connection, ...(options.autorun !== undefined ? { autorun: options.autorun } : {}) }
  );

  // Fire-and-forget registration -- mirrors webhook-replay-sweep.worker.ts's
  // try/catch/finally exactly: a Redis hiccup at boot must log, not crash
  // every other registered worker via an unhandled promise rejection; the
  // `finally` always closes this short-lived internal Queue handle so a
  // failure here never leaks a standalone Redis connection past construction.
  const registration = (async () => {
    try {
      await queue.upsertJobScheduler(
        JOB_SCHEDULER_ID,
        { every: ERASURE_SCRUB_RECLAIM_INTERVAL_MS },
        {
          name: JOB_NAME,
          data: { schemaVersion: ERASURE_SCRUB_RECLAIM_TICK_SCHEMA_VERSION },
          opts: DEFAULT_JOB_OPTIONS,
        }
      );
      await queue.add(
        JOB_NAME,
        { schemaVersion: ERASURE_SCRUB_RECLAIM_TICK_SCHEMA_VERSION },
        { ...DEFAULT_JOB_OPTIONS, jobId: bootJobId }
      );
    } catch (err) {
      scrubbedConsole.error("erasure-scrub-reclaim: scheduler registration failed", err);
    } finally {
      await queue.close().catch(() => undefined);
    }
  })();
  registrationSettled.set(worker, registration);

  return worker;
}
