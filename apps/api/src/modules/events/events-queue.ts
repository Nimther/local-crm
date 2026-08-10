import { Queue } from "bullmq";
import { EVENTS_INGEST_QUEUE, type EventsIngestJob } from "@mega-crm/shared-schemas";
import { buildJobOptions, buildRedisConnectionOptions, STANDARD_JOB_RETENTION } from "@mega-crm/queue-core";
import { env } from "../../env.js";

/**
 * Producer-side BullMQ Queue for EVENTS_INGEST_QUEUE (EVNT-03) -- the
 * consumer is apps/worker/src/queues/events-ingest.worker.ts's Worker.
 *
 * WR-01: `defaultJobOptions` retries a transient failure (DB restart, pool
 * exhaustion, deadlock) instead of dropping an already-accepted (202) job
 * on the first error -- the redelivery premise the ON CONFLICT idempotency
 * machinery (0010, events-ingest.worker.ts) was built for. Built through
 * the shared `@mega-crm/queue-core` factory (Phase 12, WRK-11, D-10).
 */
export const eventsIngestQueue = new Queue<EventsIngestJob>(EVENTS_INGEST_QUEUE, {
  connection: buildRedisConnectionOptions(env.REDIS_URL),
  defaultJobOptions: buildJobOptions(STANDARD_JOB_RETENTION),
});
