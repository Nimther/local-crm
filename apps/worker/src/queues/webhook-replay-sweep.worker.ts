import { Queue, Worker, type ConnectionOptions } from "bullmq";
import { withCrossWorkspaceScan, withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { scrubbedConsole } from "@mega-crm/redaction";
import { buildJobOptions, buildRedisConnectionOptions, STANDARD_JOB_RETENTION } from "@mega-crm/queue-core";
import {
  WEBHOOK_EVENTS_QUEUE,
  WEBHOOK_REPLAY_SWEEP_TICK_SCHEMA_VERSION,
  webhookReplaySweepTickJobSchema,
  buildWebhookEventsJobPayload,
  type WebhookEventsJob,
} from "@mega-crm/shared-schemas";
import {
  findStuckIngressJournalRows,
  pruneIngressJournal,
  purgeExpiredIngressJournalPayloads,
  INGRESS_JOURNAL_RETENTION_DAYS,
  INGRESS_JOURNAL_STUCK_THRESHOLD_MINUTES,
} from "@mega-crm/db/src/webhooks/ingress-journal.js";
import { pruneSendEventQuarantine, SEND_EVENT_QUARANTINE_RETENTION_DAYS } from "@mega-crm/db/src/webhooks/quarantine.js";
import { registerTrackedQueue } from "./queue-registry.js";

/**
 * Phase 13 (CMP-08, D-06/D-07, plan 13-06): the recovery half of CMP-08 --
 * plan 13-01's `ingress_journal` records what was received, this worker
 * makes it replayable. A scheduled sweep finds journal rows with no
 * ingestion-complete mark past `INGRESS_JOURNAL_STUCK_THRESHOLD_MINUTES` and
 * re-enqueues them onto the SAME `WEBHOOK_EVENTS_QUEUE` the live webhook
 * route already produces onto, reusing each row's own id as `journalId` so
 * completion can be marked and the sweep terminates (T-13-06-05). The same
 * tick also runs journal retention (Task 2) AFTER the replay step, so a row
 * this tick just re-enqueued can never have its payload purged before the
 * job it produced gets a chance to run.
 *
 * Cross-app shared-module placement (decided once, 13-01-PLAN.md, restated
 * here): `apps/worker` cannot import `@mega-crm/api` in production code (its
 * own devDependency-only constraint) -- this file builds its OWN producer
 * `Queue` for `WEBHOOK_EVENTS_QUEUE` through `@mega-crm/queue-core` against
 * the worker's own env, and constructs every job payload through the shared
 * pure `buildWebhookEventsJobPayload` (`@mega-crm/shared-schemas`) so this
 * producer and `apps/api/src/modules/webhooks/enqueue.ts`'s producer emit
 * byte-identical payloads without either app importing the other.
 */

export const WEBHOOK_REPLAY_SWEEP_QUEUE = "webhook-replay-sweep";

/**
 * 5 minutes -- an order of magnitude below the 15-minute stuck threshold
 * (`INGRESS_JOURNAL_STUCK_THRESHOLD_MINUTES`), so a row that just became
 * stuck is discovered within roughly one threshold of becoming stuck, and
 * well inside the ~7-day retention horizon (`INGRESS_JOURNAL_RETENTION_DAYS`).
 */
export const WEBHOOK_REPLAY_SWEEP_INTERVAL_MS = 5 * 60_000;

/**
 * 200 -- a bound so a mass-loss event degrades into more ticks rather than
 * one tick that re-enqueues an entire backlog at once and floods the
 * webhook-events queue ahead of live traffic.
 */
export const WEBHOOK_REPLAY_SWEEP_PAGE_LIMIT = 200;

/**
 * 5 -- a row that has been replayed this many times without ever being
 * marked complete is not a transient loss, it is a poison batch, and
 * continuing to replay it costs throughput while producing no new
 * information. When the cap is hit, this sweep stops enqueueing and lets
 * the ingestion-health watchdog (plan 13-11) surface it -- that plan carries
 * an acceptance criterion that an attempt-capped row is reported in its own
 * count, which is what keeps this cap from being a silent drop.
 * `findStuckIngressJournalRows` (plan 13-01) deliberately does NOT filter on
 * `replay_count` itself, for exactly this reason: the cap is applied here,
 * not hidden from the read plan 13-11's watchdog also uses.
 */
export const WEBHOOK_REPLAY_MAX_ATTEMPTS = 5;

/**
 * The stable id `upsertJobScheduler` dedupes by -- constant across every
 * boot, mirrors `send-reconciler.worker.ts`'s/`analytics-reconciliation.worker.ts`'s
 * own scheduler ids, so registering it on every worker boot never creates a
 * second competing schedule. This queue is brand new (no pre-existing
 * `tickQueue.add({repeat})` registration to migrate away from), so this file
 * carries no `LEGACY_*`/`removeRepeatable` cleanup block.
 */
const JOB_SCHEDULER_ID = "webhook-replay-sweep-tick";

const JOB_NAME = "run-webhook-replay-sweep-tick";

/** Built through the shared `@mega-crm/queue-core` factory (Phase 12, WRK-11, D-10). */
const DEFAULT_JOB_OPTIONS = buildJobOptions(STANDARD_JOB_RETENTION);

function requireRedisUrl(): string {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL is required for apps/worker's webhook-replay-sweep producer");
  }
  return redisUrl;
}

/**
 * Lazily-created singleton producer `Queue` for `WEBHOOK_EVENTS_QUEUE`
 * (mirrors `send-dispatch.ts`'s `getDefaultRedisClient()` lazy-singleton
 * shape, not `flow-queues.ts`'s module-scope `const` producers) -- a test
 * can set `process.env.REDIS_URL` in its own `beforeAll` before this is
 * first called, the same convention every other test file in this
 * workspace already uses for `DATABASE_URL`/`SCAN_DATABASE_URL`. Registered
 * with the process-wide tracked-queue registry on first construction
 * (mirrors `campaign-scheduler.worker.ts`'s kickoff-queue comment: this is a
 * genuinely long-lived producer used on every tick, never closed after
 * registration).
 */
let webhookReplaySweepProducerQueue: Queue<WebhookEventsJob> | undefined;

function getWebhookReplaySweepProducerQueue(): Queue<WebhookEventsJob> {
  webhookReplaySweepProducerQueue ??= registerTrackedQueue(
    new Queue<WebhookEventsJob>(WEBHOOK_EVENTS_QUEUE, {
      connection: buildRedisConnectionOptions(requireRedisUrl()),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    })
  );
  return webhookReplaySweepProducerQueue;
}

export interface RunWebhookReplaySweepOptions {
  /**
   * Test-only: restricts the cross-workspace discovery scan to exactly
   * these workspace ids instead of every workspace in the database -- the
   * ephemeral test database is shared across parallel test files (this
   * project's wave-context convention: workspace-scoped assertions only).
   * Every production call (`createWebhookReplaySweepWorker`'s processor)
   * omits this and scans every workspace.
   */
  workspaceIds?: string[];
  /** Test-only override of `INGRESS_JOURNAL_STUCK_THRESHOLD_MINUTES`. */
  stuckThresholdMinutes?: number;
  /** Test-only override of `WEBHOOK_REPLAY_SWEEP_PAGE_LIMIT`. */
  pageLimit?: number;
  /** Test-only override of `WEBHOOK_REPLAY_MAX_ATTEMPTS`. */
  maxAttempts?: number;
  /** Test-only override of `INGRESS_JOURNAL_RETENTION_DAYS`. */
  retentionDays?: number;
  /**
   * Test-only override of `SEND_EVENT_QUARANTINE_RETENTION_DAYS` (gap-closure
   * plan 13-16, Task 2). Deliberately a SEPARATE option from `retentionDays`
   * rather than reusing it: the independence of the two horizons is the
   * property migration 0055's `send_event_quarantine` table comment asserts
   * ("quarantine retention can be pruned independently"), and a shared knob
   * would quietly remove it.
   */
  quarantineRetentionDays?: number;
}

export interface WebhookReplaySweepTickSummary {
  workspacesScanned: number;
  rowsEnqueued: number;
  /** Rows a workspace's stuck-row scan returned but skipped because `replay_count` had already reached the attempt cap. */
  rowsSkippedAttemptCapped: number;
  /** Rows a workspace's stuck-row scan returned but skipped because `payload_purged_at` is non-null (a tombstone -- nothing left to replay). */
  rowsSkippedTombstoned: number;
  /**
   * Journal rows PRUNED (deleted outright) this tick -- rows that reached
   * `ingestion_completed_at` before aging past the retention horizon. A
   * rising prune count is normal throughput.
   */
  journalRowsPruned: number;
  /**
   * Journal PAYLOADS PURGED (row survives as a tombstone) this tick -- rows
   * that never reached `ingestion_completed_at` before aging past the
   * retention horizon. Deliberately reported as its own field, never summed
   * with `journalRowsPruned`: a rising purge count is confirmed, permanent
   * ingestion loss, and collapsing the two into one number hides exactly
   * the signal an operator needs (Codex follow-up review, WARNING finding 6).
   */
  journalPayloadsPurged: number;
  /**
   * `send_event_quarantine` rows PRUNED (deleted outright) this tick
   * (gap-closure plan 13-16, Task 2) -- closes 13-VERIFICATION.md Gap #1.
   * Deliberately reported as its own field, never summed with
   * `journalRowsPruned` or `journalPayloadsPurged`: a rising quarantine-prune
   * count is quarantine throughput ageing out, a different event from either
   * journal counter, and folding the three into one number would make all
   * three unreadable.
   */
  quarantineRowsPruned: number;
}

interface WorkspaceRow {
  id: string;
}

async function discoverWorkspaceIds(workspaceIds?: string[]): Promise<string[]> {
  return withCrossWorkspaceScan(async (client) => {
    const { rows } = await client.query<WorkspaceRow>(
      workspaceIds ? `SELECT id FROM organization WHERE id = ANY($1::uuid[])` : `SELECT id FROM organization`,
      workspaceIds ? [workspaceIds] : []
    );
    return rows.map((row) => row.id);
  });
}

interface ReplayCandidateRow {
  id: string;
  rawBatch: unknown;
}

interface WorkspaceTickResult {
  enqueueCandidates: ReplayCandidateRow[];
  rowsSkippedAttemptCapped: number;
  rowsSkippedTombstoned: number;
  journalRowsPruned: number;
  journalPayloadsPurged: number;
  quarantineRowsPruned: number;
}

interface WorkspaceTickThresholds {
  stuckThresholdMinutes: number;
  pageLimit: number;
  maxAttempts: number;
  retentionDays: number;
  quarantineRetentionDays: number;
}

/**
 * One workspace's full tick body -- replay step, then retention step, in
 * the SAME `withTenant`/`withTenantTransaction` scope (Task 2: retention
 * runs after replay so a row this tick just re-enqueued can never have its
 * payload purged before the job it produced gets a chance to run).
 *
 * The attempt-cap and tombstone filters live HERE, never inside
 * `findStuckIngressJournalRows` itself -- that function deliberately returns
 * every incomplete row regardless of `replay_count`/`payload_purged_at` so
 * plan 13-11's watchdog can report capped/purged rows as their own counts
 * from the SAME read (see that function's own doc comment).
 *
 * The `UPDATE ... RETURNING id, raw_batch` below increments `replay_count`
 * AND fetches the payload to enqueue in one round trip, inside this
 * Postgres transaction -- the actual Redis enqueue happens strictly AFTER
 * this transaction commits (the caller's loop, below). This is a
 * deliberate crash gap, not an oversight (REVIEWS.md LOW finding): the
 * increment commits in Postgres while the enqueue is a separate Redis call
 * outside that transaction, so a crash between the two has two possible
 * outcomes and both are acceptable -- an attempt is burned without a job
 * being created (self-healing: the row stays unmarked, the next tick
 * re-enqueues it, and the cap plus plan 13-11's watchdog bound the worst
 * case), or the job is created and the attempt is not recorded (harmless:
 * the webhook-events worker's dedup insert makes the extra processing a
 * no-op). The alternative designs are worse: enqueueing inside the
 * transaction risks a job for a row whose transaction later rolls back, and
 * a two-phase commit protocol buys nothing over an idempotent consumer.
 */
async function runWorkspaceTick(
  workspaceId: string,
  thresholds: WorkspaceTickThresholds
): Promise<WorkspaceTickResult> {
  return withTenant(workspaceId, () =>
    withTenantTransaction(async (client) => {
      const stuckRows = await findStuckIngressJournalRows(client, thresholds.stuckThresholdMinutes, thresholds.pageLimit);

      const eligibleIds: string[] = [];
      let rowsSkippedAttemptCapped = 0;
      let rowsSkippedTombstoned = 0;
      for (const row of stuckRows) {
        // A tombstone has no payload left to replay -- enqueueing one would
        // push an empty batch through the worker and burn an attempt
        // against nothing (plan 13-01's own retention-split rationale).
        if (row.payloadPurgedAt !== null) {
          rowsSkippedTombstoned += 1;
          continue;
        }
        if (row.replayCount >= thresholds.maxAttempts) {
          rowsSkippedAttemptCapped += 1;
          continue;
        }
        eligibleIds.push(row.id);
      }

      let enqueueCandidates: ReplayCandidateRow[] = [];
      if (eligibleIds.length > 0) {
        const { rows: updated } = await client.query<ReplayCandidateRow>(
          `UPDATE ingress_journal SET replay_count = replay_count + 1
             WHERE id = ANY($1::uuid[])
           RETURNING id, raw_batch as "rawBatch"`,
          [eligibleIds]
        );
        enqueueCandidates = updated;
      }

      // Task 2 (Codex follow-up review, WARNING finding 6): retention runs
      // AFTER the replay step above, in the SAME transaction -- a row this
      // tick just re-enqueued (its replay_count already incremented above)
      // cannot have its payload purged before the job it produced gets a
      // chance to run. Two calls, not one unconditional delete: a
      // successfully-ingested row has nothing left to prove and is deleted
      // outright; an incomplete row is the only remaining record that
      // ingestion lost a batch, so its payload is disposed of but the row
      // survives as a non-PII tombstone. See both functions' own doc
      // comments (packages/db/src/webhooks/ingress-journal.ts) for why this
      // split must never be merged back into one unconditional DELETE --
      // doing so would silently end the window plan 13-11's watchdog and
      // this sweep's own attempt-cap mitigation (T-13-06-02) both depend on.
      const journalRowsPruned = await pruneIngressJournal(client, thresholds.retentionDays);
      const journalPayloadsPurged = await purgeExpiredIngressJournalPayloads(client, thresholds.retentionDays);

      // Gap-closure plan 13-16, Task 2: a THIRD call, immediately after both
      // journal retention calls above, still inside this same tenant-scoped
      // transaction -- retention for `send_event_quarantine`, the sibling
      // table created by the same migration (0055). This is a plain row
      // delete, not the prune/purge split above it: a quarantined event is a
      // terminal decision with no replay value and no cross-workspace
      // reader, whereas an un-ingested journal row is evidence of a loss
      // that plan 13-11's watchdog still needs to see. Placement here (not a
      // second scheduler) is deliberate -- this transaction is already
      // tenant-scoped for exactly the workspace whose rows are being
      // deleted, which is what the table's fail-closed RLS policy requires,
      // and coming after both journal calls keeps replay-then-retention
      // ordering intact for this table too.
      const quarantineRowsPruned = await pruneSendEventQuarantine(client, thresholds.quarantineRetentionDays);

      return {
        enqueueCandidates,
        rowsSkippedAttemptCapped,
        rowsSkippedTombstoned,
        journalRowsPruned,
        journalPayloadsPurged,
        quarantineRowsPruned,
      };
    })
  );
}

/**
 * Discovery + per-workspace replay-then-retention, once. Exported standalone
 * (mirrors `runReconcilerTick`/`runFlowSegmentSweepTick`) so the test suite
 * can drive a full tick directly without a live BullMQ `Worker`.
 *
 * Enumerates workspaces through `withCrossWorkspaceScan` exactly as every
 * other cross-tenant discovery scan in this codebase does (never a
 * tenant-scoped query, which cannot see across workspaces under RLS), then
 * opens a fresh `withTenant`/`withTenantTransaction` scope per workspace --
 * every journal read/write stays properly tenant-scoped; only the workspace
 * ENUMERATION itself uses the admin scan role (T-13-06-04).
 */
export async function runWebhookReplaySweep(
  options: RunWebhookReplaySweepOptions = {}
): Promise<WebhookReplaySweepTickSummary> {
  const thresholds: WorkspaceTickThresholds = {
    stuckThresholdMinutes: options.stuckThresholdMinutes ?? INGRESS_JOURNAL_STUCK_THRESHOLD_MINUTES,
    pageLimit: options.pageLimit ?? WEBHOOK_REPLAY_SWEEP_PAGE_LIMIT,
    maxAttempts: options.maxAttempts ?? WEBHOOK_REPLAY_MAX_ATTEMPTS,
    retentionDays: options.retentionDays ?? INGRESS_JOURNAL_RETENTION_DAYS,
    quarantineRetentionDays: options.quarantineRetentionDays ?? SEND_EVENT_QUARANTINE_RETENTION_DAYS,
  };

  const workspaceIds = await discoverWorkspaceIds(options.workspaceIds);
  const producerQueue = getWebhookReplaySweepProducerQueue();

  let rowsEnqueued = 0;
  let rowsSkippedAttemptCapped = 0;
  let rowsSkippedTombstoned = 0;
  let journalRowsPruned = 0;
  let journalPayloadsPurged = 0;
  let quarantineRowsPruned = 0;

  for (const workspaceId of workspaceIds) {
    const result = await runWorkspaceTick(workspaceId, thresholds);
    rowsSkippedAttemptCapped += result.rowsSkippedAttemptCapped;
    rowsSkippedTombstoned += result.rowsSkippedTombstoned;
    journalRowsPruned += result.journalRowsPruned;
    journalPayloadsPurged += result.journalPayloadsPurged;
    quarantineRowsPruned += result.quarantineRowsPruned;

    // Redis enqueue happens strictly AFTER the Postgres transaction above
    // has committed -- see runWorkspaceTick's own doc comment for the
    // deliberate crash-gap analysis this ordering implies.
    for (const candidate of result.enqueueCandidates) {
      const events = Array.isArray(candidate.rawBatch) ? candidate.rawBatch : [];
      await producerQueue.add("webhook-events", buildWebhookEventsJobPayload(workspaceId, events, candidate.id));
      rowsEnqueued += 1;
    }
  }

  const summary: WebhookReplaySweepTickSummary = {
    workspacesScanned: workspaceIds.length,
    rowsEnqueued,
    rowsSkippedAttemptCapped,
    rowsSkippedTombstoned,
    journalRowsPruned,
    journalPayloadsPurged,
    quarantineRowsPruned,
  };
  scrubbedConsole.log("webhook-replay-sweep: tick complete", summary);
  return summary;
}

/**
 * Test-only synchronization, mirrors `send-reconciler.worker.ts`'s/
 * `campaign-scheduler.worker.ts`'s identical WeakMap:
 * `createWebhookReplaySweepWorker`'s own scheduler registration is
 * fire-and-forget in production. Lets `waitForWebhookReplaySweepRegistration`
 * hand a test a promise that resolves only once registration has actually
 * settled, instead of sleeping.
 */
const registrationSettled = new WeakMap<Worker, Promise<void>>();

/**
 * Test-only: resolves once the `Worker` returned by
 * `createWebhookReplaySweepWorker` has finished registering its scheduler
 * (and closed its own internal tick-registration `Queue` handle). Not used
 * by production code.
 */
export function waitForWebhookReplaySweepRegistration(worker: Worker): Promise<void> {
  return registrationSettled.get(worker) ?? Promise.resolve();
}

export interface CreateWebhookReplaySweepWorkerOptions {
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
 * Constructs the repeatable webhook-replay-sweep Worker: registers the
 * 5-minute job-scheduler tick (idempotent by `JOB_SCHEDULER_ID`) via the
 * SAME `upsertJobScheduler` + immediate boot job + try/catch/finally shape
 * `analytics-reconciliation.worker.ts` uses, then processes each tick by
 * validating the job payload against `webhookReplaySweepTickJobSchema`
 * (R-05) BEFORE ever calling `runWebhookReplaySweep` -- a `schemaVersion`
 * this worker does not recognize is DEFERRED (logged, the processor returns
 * without processing) rather than best-effort-processed. The boot job's own
 * payload also carries the current `schemaVersion` (not an empty `{}`) so
 * it passes this SAME validation rather than deferring itself on every
 * worker startup.
 */
export function createWebhookReplaySweepWorker(
  connection: ConnectionOptions,
  options: CreateWebhookReplaySweepWorkerOptions = {}
): Worker {
  const queue = new Queue(WEBHOOK_REPLAY_SWEEP_QUEUE, { connection });
  const bootJobId = `boot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const worker = new Worker(
    WEBHOOK_REPLAY_SWEEP_QUEUE,
    async (job) => {
      const parsed = webhookReplaySweepTickJobSchema.safeParse(job.data);
      if (!parsed.success) {
        scrubbedConsole.error("webhook-replay-sweep: deferring job with an unrecognized payload shape", {
          jobId: job.id,
        });
        return;
      }
      await runWebhookReplaySweep();
    },
    // G-12-1: the `autorun` key is included ONLY when a caller actually
    // supplied a value -- never nullish-coalesced to a restated `true`,
    // which would be a second source of truth for a value BullMQ already
    // owns. Under the composition root's single-argument call shape,
    // `options.autorun` is `undefined` and this spread contributes nothing,
    // leaving BullMQ's own default in effect.
    { connection, ...(options.autorun !== undefined ? { autorun: options.autorun } : {}) }
  );

  // Fire-and-forget registration -- mirrors analytics-reconciliation.worker.ts's
  // try/catch/finally exactly: a Redis hiccup at boot must log, not crash
  // every other registered worker via an unhandled promise rejection; the
  // `finally` always closes this short-lived internal Queue handle so a
  // failure here never leaks a standalone Redis connection past construction.
  const registration = (async () => {
    try {
      await queue.upsertJobScheduler(
        JOB_SCHEDULER_ID,
        { every: WEBHOOK_REPLAY_SWEEP_INTERVAL_MS },
        {
          name: JOB_NAME,
          data: { schemaVersion: WEBHOOK_REPLAY_SWEEP_TICK_SCHEMA_VERSION },
          opts: DEFAULT_JOB_OPTIONS,
        }
      );
      await queue.add(
        JOB_NAME,
        { schemaVersion: WEBHOOK_REPLAY_SWEEP_TICK_SCHEMA_VERSION },
        { ...DEFAULT_JOB_OPTIONS, jobId: bootJobId }
      );
    } catch (err) {
      scrubbedConsole.error("webhook-replay-sweep: scheduler registration failed", err);
    } finally {
      await queue.close().catch(() => undefined);
    }
  })();
  registrationSettled.set(worker, registration);

  return worker;
}
