/**
 * Phase 15 (OPS-13, plan 15-13, Task 1): a read-only queue-metrics reader for
 * `apps/api`. Both new watchdogs this plan builds (`queue-depth-watchdog.ts`,
 * `oldest-job-age-watchdog.ts`) need the same underlying signal -- per-lane
 * waiting/delayed/active/failed counts plus the age of the oldest pending
 * job -- so this module reads it once, in one shape, instead of each
 * watchdog rolling its own BullMQ calls.
 *
 * This module performs NO evaluation and sends NO alerts -- it only reads.
 * Every dependency a caller needs to inject (which queues to read) is a
 * plain parameter, mirroring `send-reconciler-watchdog.ts`'s `deps`
 * discipline; the pure evaluation happens one layer up, in each watchdog's
 * own `evaluate*Health` function.
 *
 * Reuses the SEVEN `Queue` handles `apps/api` already constructs elsewhere
 * (never a duplicate `new Queue(...)` for a name another module already
 * owns): `erasureScrubQueue` (contact.repository.ts, exported for this
 * reason -- see that export's own comment), `importsCsvQueue`,
 * `campaignKickoffQueue`, `emailBroadcastQueue`, `eventsIngestQueue`,
 * `webhookEventsQueue`, `flowEnrollExistingQueue`. Adds exactly ONE new
 * handle: `emailTriggeredQueue` (`EMAIL_TRIGGERED_QUEUE`) -- `apps/api`
 * never produces onto this lane (only `apps/worker`'s flow-run-advance
 * pipeline does, see `apps/worker/src/queues/flows/handlers/send-node.ts`),
 * but it is the more failure-prone of this system's two send lanes (STACK.md
 * Queue & Send Pipeline: triggered sends must never starve behind a flooded
 * broadcast queue) and so must be monitored regardless of who produces onto
 * it. Built through `@mega-crm/queue-core`'s `buildRedisConnectionOptions`
 * like every other queue in this codebase -- never a hand-rolled connection
 * literal -- and is READ-ONLY: this module never calls `.add()` on it.
 *
 * `closeQueueMonitorQueues()` closes ONLY this new handle on API shutdown
 * (task 1's own acceptance criterion) -- the six REUSED handles are each
 * already owned by their own producer module and are not this module's to
 * close.
 */

import { Queue } from "bullmq";
import {
  CAMPAIGN_KICKOFF_QUEUE,
  EMAIL_BROADCAST_QUEUE,
  EMAIL_TRIGGERED_QUEUE,
  ERASURE_SCRUB_QUEUE,
  EVENTS_INGEST_QUEUE,
  FLOW_ENROLL_EXISTING_QUEUE,
  IMPORTS_CSV_QUEUE,
  WEBHOOK_EVENTS_QUEUE,
  type EmailTriggeredJob,
} from "@mega-crm/shared-schemas";
import { buildRedisConnectionOptions } from "@mega-crm/queue-core";
import { scrubbedConsole } from "@mega-crm/redaction";
import { env } from "../../env.js";
import { erasureScrubQueue } from "../contacts/contact.repository.js";
import { importsCsvQueue } from "../contacts/imports-csv-queue.js";
import { campaignKickoffQueue, emailBroadcastQueue } from "../campaigns/campaign-queues.js";
import { eventsIngestQueue } from "../events/events-queue.js";
import { webhookEventsQueue } from "../webhooks/enqueue.js";
import { flowEnrollExistingQueue } from "../flows/flow-queues.js";

/**
 * The one new handle this module constructs. Read-only (no `defaultJobOptions`
 * -- this module never enqueues), same connection-building discipline as
 * every producer queue in this codebase.
 */
export const emailTriggeredQueue = new Queue<EmailTriggeredJob>(EMAIL_TRIGGERED_QUEUE, {
  connection: buildRedisConnectionOptions(env.REDIS_URL),
});
emailTriggeredQueue.on("error", (err) => {
  scrubbedConsole.error("queue-monitor: emailTriggeredQueue Redis connection error", err);
});

/**
 * Closes the one handle this module owns. Called from `apps/api/src/server.ts`'s
 * existing `onClose` hook (this plan's Task 1) so `npx vitest run --root
 * apps/api` never hangs on an open ioredis handle after the suite finishes --
 * the same concern `rateLimitRedis.disconnect()` already addresses for the
 * distributed rate limiter's own connection, immediately above that hook.
 */
export async function closeQueueMonitorQueues(): Promise<void> {
  await emailTriggeredQueue.close();
}

/**
 * Structural (not `bullmq`'s own `Queue` class) so a test can inject a plain
 * fake object satisfying this shape without touching Redis at all -- exactly
 * the seam `send-reconciler-watchdog.ts`'s `ReconcilerRunClient` gives its
 * own Postgres dependency, applied here to BullMQ instead.
 */
export interface QueueMonitorQueueLike {
  getJobCounts(...types: string[]): Promise<Record<string, number>>;
  getWaiting(start: number, end: number): Promise<Array<{ timestamp: number }>>;
  getDelayed(start: number, end: number): Promise<Array<{ timestamp: number }>>;
}

export interface QueueMetricsOk {
  readable: true;
  waiting: number;
  delayed: number;
  active: number;
  failed: number;
  /** `null` when neither list holds a job -- a genuinely empty, healthy queue. */
  oldestPendingAt: Date | null;
}

/**
 * A Redis read failure surfaces as THIS shape, never as `QueueMetricsOk`
 * with zero counts (T-15-43: a blind monitor must never look identical to a
 * healthy empty one). The caller (each watchdog's own `evaluate*Health`)
 * treats this as unhealthy with its own distinct reason.
 */
export interface QueueMetricsUnreadable {
  readable: false;
  error: string;
}

export type QueueMetricsResult = QueueMetricsOk | QueueMetricsUnreadable;

/**
 * Every monitored queue, keyed by its BullMQ queue name (the same string
 * constants producers/consumers already share via `@mega-crm/shared-schemas`)
 * -- covers each of the eight lanes exactly once. Exported as the default
 * argument to `readAllQueueMetrics` so production callers never have to
 * assemble this map themselves, while a test can still pass its own map of
 * fakes.
 */
export const MONITORED_QUEUES: Record<string, QueueMonitorQueueLike> = {
  [ERASURE_SCRUB_QUEUE]: erasureScrubQueue,
  [IMPORTS_CSV_QUEUE]: importsCsvQueue,
  [CAMPAIGN_KICKOFF_QUEUE]: campaignKickoffQueue,
  [EMAIL_BROADCAST_QUEUE]: emailBroadcastQueue,
  [EMAIL_TRIGGERED_QUEUE]: emailTriggeredQueue,
  [EVENTS_INGEST_QUEUE]: eventsIngestQueue,
  [WEBHOOK_EVENTS_QUEUE]: webhookEventsQueue,
  [FLOW_ENROLL_EXISTING_QUEUE]: flowEnrollExistingQueue,
};

/**
 * Reads ONE queue's metrics. `getWaiting(0, 0)`/`getDelayed(0, 0)` each fetch
 * only the single job at rank 0 -- for `waiting` this is genuinely the
 * OLDEST job (BullMQ's waiting list is FIFO by insertion, absent a job
 * `priority` override no queue in `MONITORED_QUEUES` uses today); for
 * `delayed` this is the job soonest due to move to `waiting` (that sorted
 * set's score), which is usually but not provably the oldest-BY-CREATION
 * delayed job -- a documented, deliberate approximation (this is an
 * operator alert, not a scheduling decision) rather than paying for a full
 * page scan across every delayed job to find a provably-oldest one.
 *
 * A thrown error (a real Redis failure, or the queue's own connection being
 * down) is caught HERE and turned into `QueueMetricsUnreadable` -- this is
 * the one and only place that distinction gets made, so neither watchdog's
 * own evaluation function needs its own try/catch around a BullMQ call.
 */
export async function readQueueMetrics(queue: QueueMonitorQueueLike): Promise<QueueMetricsResult> {
  try {
    const [counts, waitingJobs, delayedJobs] = await Promise.all([
      queue.getJobCounts("waiting", "delayed", "active", "failed"),
      queue.getWaiting(0, 0),
      queue.getDelayed(0, 0),
    ]);

    const timestamps = [...waitingJobs, ...delayedJobs].map((job) => job.timestamp);
    const oldestPendingAt = timestamps.length > 0 ? new Date(Math.min(...timestamps)) : null;

    return {
      readable: true,
      waiting: counts.waiting ?? 0,
      delayed: counts.delayed ?? 0,
      active: counts.active ?? 0,
      failed: counts.failed ?? 0,
      oldestPendingAt,
    };
  } catch (err) {
    return {
      readable: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Reads every monitored queue's metrics, keyed by queue name. Each queue is
 * read independently -- one queue throwing never prevents the others from
 * reporting (each call is wrapped inside `readQueueMetrics`'s own try/catch,
 * never a single `Promise.all` that would let one rejection abort every
 * result).
 */
export async function readAllQueueMetrics(
  queues: Record<string, QueueMonitorQueueLike> = MONITORED_QUEUES,
): Promise<Record<string, QueueMetricsResult>> {
  const entries = await Promise.all(
    Object.entries(queues).map(async ([name, queue]): Promise<[string, QueueMetricsResult]> => [
      name,
      await readQueueMetrics(queue),
    ]),
  );
  return Object.fromEntries(entries);
}
