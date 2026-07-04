import type { Worker } from "bullmq";
import { createRedisConnection } from "./queues/connection.js";

/**
 * The worker process's runtime handle: the shared ioredis connection plus
 * every registered BullMQ Worker. 02-06 (event ingestion) and 02-07 (CSV
 * import) each push their Worker into `workers` here — this file stays the
 * single place that owns process-level startup/shutdown, so neither slice
 * plan needs to re-derive graceful-shutdown wiring.
 */
export interface WorkerRuntime {
  connection: ReturnType<typeof createRedisConnection>;
  workers: Worker[];
  close: () => Promise<void>;
}

/**
 * Assembles the worker runtime: one shared Redis connection, and (so far)
 * zero BullMQ Workers — 02-06/02-07 register the events:ingest and
 * imports:csv workers here once their job processors exist. No HTTP
 * listener; this is a long-running background process, not a server.
 */
export async function buildWorker(): Promise<WorkerRuntime> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL is required for apps/worker to start");
  }

  const connection = createRedisConnection(redisUrl);
  const workers: Worker[] = [];

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
  console.log("apps/worker started (no BullMQ workers registered yet — see 02-06/02-07)");
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
  });
}
