import { Queue, type ConnectionOptions } from "bullmq";
import { IMPORTS_CSV_QUEUE, type ImportsCsvJob } from "@mega-crm/shared-schemas";
import { env } from "../../env.js";

/**
 * Builds plain ioredis connection options from REDIS_URL -- NOT a
 * constructed `Redis`/`ioredis` client instance. Duplicated from
 * apps/api/src/modules/events/events-queue.ts (which itself documents why:
 * BullMQ bundles its OWN internal `ioredis` copy at a version pinned
 * independently of this workspace's `ioredis` dependency, so passing a
 * constructed client instance across that boundary is a TypeScript
 * nominal-type mismatch -- a plain options object has no such class
 * identity). This is connection-config parsing, not business logic prone to
 * drift, so duplicating it here (rather than importing across modules)
 * matches the established convention.
 */
function buildRedisConnectionOptions(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  const db = url.pathname && url.pathname !== "/" ? Number(url.pathname.slice(1)) : undefined;

  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    username: url.username || undefined,
    password: url.password || undefined,
    db,
    maxRetriesPerRequest: null,
  };
}

/**
 * Producer-side BullMQ Queue for IMPORTS_CSV_QUEUE (CONT-02, D-16) -- the
 * consumer is apps/worker/src/queues/imports-csv.worker.ts's Worker.
 *
 * WR-01: `defaultJobOptions` retries a transient failure instead of
 * dropping an already-accepted import job on the first error -- same
 * durability fix applied to events-queue.ts.
 */
export const importsCsvQueue = new Queue<ImportsCsvJob>(IMPORTS_CSV_QUEUE, {
  connection: buildRedisConnectionOptions(env.REDIS_URL),
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: { age: 86400 },
    removeOnFail: false,
  },
});
