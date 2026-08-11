import { Queue } from "bullmq";
import {
  WEBHOOK_EVENTS_QUEUE,
  buildWebhookEventsJobPayload,
  type WebhookEventsJob,
} from "@mega-crm/shared-schemas";
import { buildJobOptions, buildRedisConnectionOptions, STANDARD_JOB_RETENTION } from "@mega-crm/queue-core";
import { env } from "../../env.js";

/**
 * Producer-side BullMQ Queue for WEBHOOK_EVENTS_QUEUE (WBHK-01/03) -- the
 * consumer is apps/worker/src/queues/webhook-events.worker.ts's Worker.
 * Module-singleton, lazily constructed at first import (mirrors
 * events-queue.ts's `eventsIngestQueue`). Retries a transient failure
 * (DB restart, pool exhaustion) instead of dropping an already-acked (200)
 * batch on the first error -- the redelivery premise the
 * `ON CONFLICT ... DO NOTHING` idempotency machinery
 * (webhook-events.worker.ts) is built for. Built through the shared
 * `@mega-crm/queue-core` factory (Phase 12, WRK-11, D-10).
 */
export const webhookEventsQueue = new Queue<WebhookEventsJob>(WEBHOOK_EVENTS_QUEUE, {
  connection: buildRedisConnectionOptions(env.REDIS_URL),
  defaultJobOptions: buildJobOptions(STANDARD_JOB_RETENTION),
});

/**
 * Enqueues the ENTIRE verified SendGrid event batch as one job (RESEARCH.md
 * Pattern 2: ack-fast via whole-batch enqueue, never per-event). Called
 * from webhooks.routes.ts only AFTER `verifyWebhookSignature` has already
 * returned true AND `writeIngressJournal` has committed -- `workspaceId` is
 * resolved by the route via `findWebhookEndpointByToken(pathToken)` BEFORE
 * the payload itself is trusted, never read from the payload (RESEARCH.md
 * Architecture Pattern 1).
 *
 * Phase 13 (CMP-08, D-05, plan 13-01): `journalId` is the `ingress_journal`
 * row id the route's own transaction just wrote -- forwarded so the worker's
 * `processWebhookEventBatch` can close the loop via `markIngestionComplete`.
 * The payload itself is built through the SAME `buildWebhookEventsJobPayload`
 * plan 13-06's replay-sweep producer uses, so the two producers cannot drift
 * on job shape.
 */
export async function enqueueWebhookBatch(
  workspaceId: string,
  events: unknown[],
  journalId?: string
): Promise<void> {
  await webhookEventsQueue.add("webhook-events", buildWebhookEventsJobPayload(workspaceId, events, journalId));
}
