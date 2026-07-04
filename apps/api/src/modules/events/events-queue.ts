import { Queue, type ConnectionOptions } from "bullmq";
import { EVENTS_INGEST_QUEUE, type EventsIngestJob } from "@mega-crm/shared-schemas";
import { env } from "../../env.js";

/**
 * Builds plain ioredis connection options from REDIS_URL -- NOT a
 * constructed `Redis`/`ioredis` client instance. BullMQ bundles its OWN
 * internal `ioredis` copy at a version pinned independently of this
 * workspace's `ioredis` dependency (bullmq@5.79.1 pins ioredis@5.10.1
 * exactly vs. this workspace's ioredis@5.11.0), which TypeScript treats as
 * a structurally distinct class -- passing a constructed client instance
 * across that boundary is a nominal-type mismatch. A plain options object
 * has no such class identity and satisfies BullMQ's `ConnectionOptions`
 * regardless of which `ioredis` copy "built" the shape (mirrors
 * apps/worker/src/queues/connection.ts's `buildRedisConnectionOptions`,
 * duplicated here since apps/api has no dependency path to apps/worker's
 * source -- this is connection-config parsing, not business logic prone to
 * drift).
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
 * Producer-side BullMQ Queue for EVENTS_INGEST_QUEUE (EVNT-03) -- the
 * consumer is apps/worker/src/queues/events-ingest.worker.ts's Worker.
 */
export const eventsIngestQueue = new Queue<EventsIngestJob>(EVENTS_INGEST_QUEUE, {
  connection: buildRedisConnectionOptions(env.REDIS_URL),
});
