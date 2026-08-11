import "./load-env.js";
import type { Redis } from "ioredis";
import type { Job, Worker } from "bullmq";
import { scrubbedConsole } from "@mega-crm/redaction";
import { attachSharedErrorListeners, buildRedisConnectionOptions, createRedisConnection } from "@mega-crm/queue-core";
import { closeTrackedQueues } from "./queues/queue-registry.js";
import { isTerminalJobFailure, writeDeadLetterOnTerminalFailure } from "./queues/dead-letter/dead-letter-writer.js";
import { createEventsIngestWorker } from "./queues/events-ingest.worker.js";
import { createImportsCsvWorker } from "./queues/imports-csv.worker.js";
import { createEmailBroadcastWorker } from "./queues/email-broadcast.worker.js";
import { createEmailTriggeredWorker } from "./queues/email-triggered.worker.js";
import { createCampaignKickoffWorker } from "./queues/campaign-kickoff.worker.js";
import { createCampaignSchedulerWorker } from "./queues/campaign-scheduler.worker.js";
import { createWebhookEventsWorker } from "./queues/webhook-events.worker.js";
import { createAnalyticsReconciliationWorker } from "./queues/analytics-reconciliation.worker.js";
import { createFlowRunAdvanceWorker } from "./queues/flows/flow-run-advance.worker.js";
import { createFlowReconciliationWorker } from "./queues/flows/flow-reconciliation.worker.js";
import { createFlowTriggerEvaluatorWorker } from "./queues/flows/flow-trigger-evaluator.worker.js";
import { createFlowSegmentSweepWorker } from "./queues/flows/flow-segment-sweep.worker.js";
import { createFlowSegmentSweepFlowWorker } from "./queues/flows/flow-segment-sweep-flow.worker.js";
import { createFlowEnrollExistingWorker } from "./queues/flows/flow-enroll-existing.worker.js";
import { createPartitionMaintenanceWorker } from "./queues/partition-maintenance.worker.js";
import { createSendReconcilerWorker } from "./queues/send-reconciler.worker.js";
import { createWebhookReplaySweepWorker } from "./queues/webhook-replay-sweep.worker.js";

/**
 * The worker process's runtime handle: a standalone shared ioredis
 * connection (kept for process-level shutdown/inspection, e.g. a future
 * @bull-board wiring) plus every registered BullMQ Worker. 02-06 (event
 * ingestion) registers events:ingest below; 02-07 (CSV import) pushes its
 * Worker into `workers` here too — this file stays the single place that
 * owns process-level startup/shutdown, so neither slice plan needs to
 * re-derive graceful-shutdown wiring.
 *
 * Each Worker gets its OWN internal connection built from plain
 * `buildRedisConnectionOptions(...)` (not this shared `connection`
 * instance) -- BullMQ bundles its own internal `ioredis` copy at a
 * different version than this workspace's, so passing a constructed
 * `Redis` client instance across that boundary is a TypeScript nominal-type
 * mismatch (see events-ingest.worker.ts's `createEventsIngestWorker` doc
 * comment); a plain options object has no such class identity and works
 * regardless. `worker.close()` (called below) already closes each Worker's
 * own BullMQ-managed connection.
 */
export interface WorkerRuntime {
  connection: ReturnType<typeof createRedisConnection>;
  workers: Worker[];
  close: () => Promise<void>;
}

/**
 * Phase 12 (WRK-07): the shutdown ordering, factored out of `buildWorker()`
 * so it is testable without constructing all sixteen production workers
 * (`graceful-shutdown.test.ts` drives this directly against a handful of
 * real, test-scoped `Worker`s/`Queue`s).
 *
 * Order matters: every registered `Worker` closes FIRST (draining any
 * in-flight job to completion, BullMQ's own default), THEN every tracked
 * long-lived `Queue` handle (`queue-registry.ts`) closes, and ONLY THEN does
 * the shared connection disconnect. A producer `Queue` close racing a
 * still-draining `Worker` could drop an enqueue the worker was mid-making;
 * closing workers first removes that race entirely. Idempotent: calling
 * this twice is safe -- `closeTrackedQueues()` drains its own registry
 * before closing, so a second call has nothing left to close, and BullMQ's
 * own `Worker.close()` and `Redis.disconnect()` both tolerate being called
 * more than once.
 */
export async function closeWorkerRuntime(workers: Worker[], connection: Redis): Promise<void> {
  await Promise.all(workers.map((worker) => worker.close()));
  await closeTrackedQueues();
  connection.disconnect();
}

/**
 * Phase 12 (WRK-08/WRK-10): attaches the shared error/failed listener over
 * the FULL worker array handed to it, rather than at each factory's own
 * construction site. Factored out of `buildWorker()` so
 * `shared-error-listener.test.ts` can drive it directly against a handful
 * of real, test-scoped `Worker`s without constructing all sixteen
 * production workers (the same testability reasoning as
 * `closeWorkerRuntime` above).
 *
 * `onTerminalFailure` composes the terminal-vs-mid-retry gate
 * (`isTerminalJobFailure`) with the dead-letter writer explicitly, even
 * though the writer re-checks the same gate internally -- a mid-retry
 * failure must never reach the writer at all, not merely be filtered inside
 * it, so the composition is visible at the call site that wires the two
 * together.
 *
 * Attaching over the array (not per-factory) is deliberate: the array is
 * the exhaustive registry of every worker this process runs, so a worker
 * added to it later can never be forgotten the way a per-factory call site
 * could be if a future author simply forgot to add it to a new factory.
 */
export function attachSharedListeners(workers: Worker[]): void {
  const onTerminalFailure = (job: Job | undefined, err: Error, queueName: string): Promise<void> | undefined => {
    if (!job || !isTerminalJobFailure(job)) {
      return undefined;
    }
    return writeDeadLetterOnTerminalFailure(job, err, queueName);
  };

  for (const worker of workers) {
    attachSharedErrorListeners(worker, worker.name, { onTerminalFailure });
  }
}

/**
 * Assembles the worker runtime: one shared Redis connection plus the
 * events:ingest (EVNT-02/EVNT-03) and imports:csv (CONT-02) BullMQ Workers.
 * No HTTP listener; this is a long-running background process, not a
 * server.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- composition root: the declared Promise<WorkerRuntime> is the contract server.ts awaits, and boot ordering is not something to reshape for a lint rule
export async function buildWorker(): Promise<WorkerRuntime> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL is required for apps/worker to start");
  }

  // Phase 10 (SEC-01/SEC-02, P3): the worker is the ONLY process that may
  // hold this credential -- apps/api/src/env.ts's schema deliberately does
  // not declare SCAN_DATABASE_URL at all, which is the structural half of
  // the "API process holds neither scan-role credentials nor membership"
  // proof. Fail fast here rather than let the first cross-workspace scan
  // throw lazily deep inside a BullMQ job.
  const scanDatabaseUrl = process.env.SCAN_DATABASE_URL;
  if (!scanDatabaseUrl) {
    throw new Error(
      "SCAN_DATABASE_URL is required for apps/worker to start -- cross-workspace scans connect as the dedicated least-privilege mega_crm_scan role"
    );
  }

  // 04-16 gap closure: the send workers registered below (email-broadcast,
  // email-triggered) call signUnsubscribeToken/buildListUnsubscribeUrl
  // (packages/delivery-core/src/unsubscribe-token.ts) on every send --
  // those throw lazily per-job if unset. Fail fast here, before any Worker
  // is constructed, so a missing/weak secret dies the process at boot
  // instead of exhausting BullMQ retries into the failed set (the observed
  // UAT Test 4/5 failure mode).
  const unsubscribeTokenSecret = process.env.UNSUBSCRIBE_TOKEN_SECRET;
  if (!unsubscribeTokenSecret || unsubscribeTokenSecret.length < 32) {
    throw new Error(
      "UNSUBSCRIBE_TOKEN_SECRET (>=32 chars) is required for apps/worker to start -- it signs every List-Unsubscribe token"
    );
  }
  const publicAppUrl = process.env.PUBLIC_APP_URL;
  if (!publicAppUrl) {
    throw new Error(
      "PUBLIC_APP_URL is required for apps/worker to start -- it builds the public unsubscribe link"
    );
  }

  const connection = createRedisConnection(redisUrl);
  const workers: Worker[] = [
    createEventsIngestWorker(buildRedisConnectionOptions(redisUrl)),
    createImportsCsvWorker(buildRedisConnectionOptions(redisUrl)),
    // SEND-03: two independently-concurrent queues (bounded broadcast,
    // higher-concurrency triggered) -- each gets its OWN
    // buildRedisConnectionOptions(...) call, same nominal-type reason as the
    // two workers above (never a constructed Redis instance).
    createEmailBroadcastWorker(buildRedisConnectionOptions(redisUrl)),
    createEmailTriggeredWorker(buildRedisConnectionOptions(redisUrl)),
    // CAMP-02/SEND-01: closes the launch-to-send loop -- the kickoff worker
    // consumes CAMPAIGN_KICKOFF_QUEUE (produced by both the launch route's
    // immediate-launch enqueue and the scheduler below); the scheduler scans
    // due `scheduled` campaigns and produces the same kickoff job.
    createCampaignKickoffWorker(buildRedisConnectionOptions(redisUrl)),
    createCampaignSchedulerWorker(buildRedisConnectionOptions(redisUrl)),
    // WBHK-01/03: its own dedicated lane (not folded into events-ingest or
    // either send queue), per CLAUDE.md queue-isolation guidance.
    createWebhookEventsWorker(buildRedisConnectionOptions(redisUrl)),
    // ANLT-04 (07-06): periodic correctness backstop for workspace_daily_rollup
    // -- overwrites each recent day's row from a fresh scan of `sends`,
    // self-healing any drift from the webhook worker's incremental increments.
    createAnalyticsReconciliationWorker(buildRedisConnectionOptions(redisUrl)),
    // FLOW-01/03/06/07 (06-05): the flow execution engine -- the advance
    // worker steps one flow_run one node at a time (send/exit this plan),
    // the reconciliation worker is its durable due-run backstop scan.
    createFlowRunAdvanceWorker(buildRedisConnectionOptions(redisUrl)),
    createFlowReconciliationWorker(buildRedisConnectionOptions(redisUrl)),
    // FLOW-02/04 (06-06): the trigger evaluator -- matches an ingested
    // event's name against live event-triggered flows, applies re-entry
    // control + the one-active-run guard, and creates version-pinned runs.
    createFlowTriggerEvaluatorWorker(buildRedisConnectionOptions(redisUrl)),
    // FLOW-02 (06-08): the segment-entry periodic bulk-diff sweep (D-02b
    // safety net) -- discovery half, enqueues one bounded walk job per flow.
    createFlowSegmentSweepWorker(buildRedisConnectionOptions(redisUrl)),
    // WRK-05/WRK-06 (12-06): the sweep's bounded, checkpointed, resumable
    // per-flow walk -- pages on contacts.id under a per-page statement
    // timeout, committing its resume cursor in the same transaction as
    // that page's enrollment work, so a kill between pages is exactly
    // resumable by construction.
    createFlowSegmentSweepFlowWorker(buildRedisConnectionOptions(redisUrl)),
    // FLOW-02/D-04 (06-08): the publish route's enroll-existing resumable
    // batch, fired once per publish when the marketer chooses to back-fill
    // current segment members.
    createFlowEnrollExistingWorker(buildRedisConnectionOptions(redisUrl)),
    // DB-01/DB-02 (09-02): keeps the rolling monthly partition horizon for
    // `events`/`send_events` self-maintaining (daily 03:00 UTC job-scheduler
    // tick plus one immediate run per boot) and writes the
    // `partition_maintenance_runs` health row the API-side watchdog
    // (`apps/api/src/modules/ops/partition-watchdog.ts`, started in a
    // DIFFERENT process by this plan's task 3) reads.
    createPartitionMaintenanceWorker(buildRedisConnectionOptions(redisUrl)),
    // DLV-03 (11-03): the classification-only reconciler -- discovers
    // `reconciling` rows across every tenant (cross-workspace scan role),
    // claims each one exclusively per-tenant, and resolves it to `sent`
    // from webhook evidence already on disk. Never calls SendGrid (D-01).
    createSendReconcilerWorker(buildRedisConnectionOptions(redisUrl)),
    // CMP-08 (D-06/D-07, 13-06): the recovery half of the webhook-ingress
    // durability journal (13-01) -- finds journal rows with no
    // ingestion-complete mark past the stuck threshold and re-enqueues them
    // onto webhook-events, then prunes/tombstones the journal at its
    // retention horizon in the same tick.
    createWebhookReplaySweepWorker(buildRedisConnectionOptions(redisUrl)),
  ];

  // Phase 12 (WRK-08/WRK-10): attach the shared error/failed listener,
  // wired to the dead-letter writer, over the FULL worker array immediately
  // after it is built -- see attachSharedListeners's own doc comment above
  // for why this happens over the array rather than per-factory.
  attachSharedListeners(workers);

  const close = (): Promise<void> => closeWorkerRuntime(workers, connection);

  return { connection, workers, close };
}

async function main(): Promise<void> {
  const runtime = await buildWorker();

  const shutdown = (signal: NodeJS.Signals) => {
    scrubbedConsole.log(`apps/worker received ${signal}, shutting down gracefully`);
    runtime
      .close()
      .then(() => process.exit(0))
      .catch((err) => {
        scrubbedConsole.error("apps/worker shutdown error", err);
        process.exit(1);
      });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  scrubbedConsole.log(
    `apps/worker started (${runtime.workers.length} BullMQ worker(s) registered: events:ingest, imports:csv, email-broadcast, email-triggered, campaign-kickoff, campaign-scheduler, webhook-events, analytics-reconciliation, flow-run-advance, flow-reconciliation, flow-trigger-evaluator, flow-segment-sweep, flow-segment-sweep-flow, flow-enroll-existing, partition-maintenance, send-reconciler, webhook-replay-sweep)`
  );
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch((err) => {
    scrubbedConsole.error(err);
    process.exitCode = 1;
  });
}
