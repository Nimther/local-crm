import { Queue, type ConnectionOptions } from "bullmq";
import { WEBHOOK_EVENTS_QUEUE, type WebhookEventsJob } from "@mega-crm/shared-schemas";
import { env } from "../../env.js";

/**
 * Builds plain ioredis connection options from REDIS_URL -- NOT a
 * constructed `Redis`/`ioredis` client instance. BullMQ bundles its OWN
 * internal `ioredis` copy at a version pinned independently of this
 * workspace's `ioredis` dependency, which TypeScript treats as a
 * structurally distinct class -- passing a constructed client instance
 * across that boundary is a nominal-type mismatch. A plain options object
 * has no such class identity (mirrors apps/api/src/modules/events/events-queue.ts
 * and apps/worker/src/queues/connection.ts's `buildRedisConnectionOptions`,
 * duplicated here for the same reason events-queue.ts duplicates it:
 * connection-config parsing, not business logic prone to drift).
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
 * Producer-side BullMQ Queue for WEBHOOK_EVENTS_QUEUE (WBHK-01/03) -- the
 * consumer is apps/worker/src/queues/webhook-events.worker.ts's Worker.
 * Module-singleton, lazily constructed at first import (mirrors
 * events-queue.ts's `eventsIngestQueue`). Retries a transient failure
 * (DB restart, pool exhaustion) instead of dropping an already-acked (200)
 * batch on the first error -- the redelivery premise the
 * `ON CONFLICT ... DO NOTHING` idempotency machinery
 * (webhook-events.worker.ts) is built for.
 */
export const webhookEventsQueue = new Queue<WebhookEventsJob>(WEBHOOK_EVENTS_QUEUE, {
  connection: buildRedisConnectionOptions(env.REDIS_URL),
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: { age: 86400 },
    removeOnFail: false,
  },
});

/**
 * Enqueues the ENTIRE verified SendGrid event batch as one job (RESEARCH.md
 * Pattern 2: ack-fast via whole-batch enqueue, never per-event). Called
 * from webhooks.routes.ts only AFTER `verifyWebhookSignature` has already
 * returned true -- `workspaceId` is resolved by the route via
 * `findWebhookEndpointByToken(pathToken)` BEFORE the payload itself is
 * trusted, never read from the payload (RESEARCH.md Architecture Pattern 1).
 */
export async function enqueueWebhookBatch(workspaceId: string, events: unknown[]): Promise<void> {
  await webhookEventsQueue.add("webhook-events", { workspaceId, events });
}
