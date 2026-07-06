import type { Worker } from "bullmq";
import { buildRedisConnectionOptions, createRedisConnection } from "./queues/connection.js";
import { createEventsIngestWorker } from "./queues/events-ingest.worker.js";
import { createImportsCsvWorker } from "./queues/imports-csv.worker.js";
import { createEmailBroadcastWorker } from "./queues/email-broadcast.worker.js";
import { createEmailTriggeredWorker } from "./queues/email-triggered.worker.js";
import { createCampaignKickoffWorker } from "./queues/campaign-kickoff.worker.js";
import { createCampaignSchedulerWorker } from "./queues/campaign-scheduler.worker.js";

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
export async function buildWorker(): Promise<WorkerRuntime> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL is required for apps/worker to start");
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
    // eslint-disable-next-line no-console
    console.log(`apps/worker received ${signal}, shutting down gracefully`);
    runtime
      .close()
      .then(() => process.exit(0))
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error("apps/worker shutdown error", err);
        process.exit(1);
      });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // eslint-disable-next-line no-console
  console.log(
    `apps/worker started (${runtime.workers.length} BullMQ worker(s) registered: events:ingest, imports:csv, email-broadcast, email-triggered, campaign-kickoff, campaign-scheduler)`
  );
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
  });
}
