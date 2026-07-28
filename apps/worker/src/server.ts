import type { Worker } from "bullmq";
import { buildRedisConnectionOptions, createRedisConnection } from "./queues/connection.js";
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
import { createFlowEnrollExistingWorker } from "./queues/flows/flow-enroll-existing.worker.js";

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
    // safety net).
    createFlowSegmentSweepWorker(buildRedisConnectionOptions(redisUrl)),
    // FLOW-02/D-04 (06-08): the publish route's enroll-existing resumable
    // batch, fired once per publish when the marketer chooses to back-fill
    // current segment members.
    createFlowEnrollExistingWorker(buildRedisConnectionOptions(redisUrl)),
  ];

  const close = async (): Promise<void> => {
    await Promise.all(workers.map((worker) => worker.close()));
    connection.disconnect();
  };

  return { connection, workers, close };
}

async function main(): Promise<void> {
  const runtime = await buildWorker();

  const shutdown = (signal: NodeJS.Signals) => {
    console.log(`apps/worker received ${signal}, shutting down gracefully`);
    runtime
      .close()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error("apps/worker shutdown error", err);
        process.exit(1);
      });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(
    `apps/worker started (${runtime.workers.length} BullMQ worker(s) registered: events:ingest, imports:csv, email-broadcast, email-triggered, campaign-kickoff, campaign-scheduler, webhook-events, analytics-reconciliation, flow-run-advance, flow-reconciliation, flow-trigger-evaluator, flow-segment-sweep, flow-enroll-existing)`
  );
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
