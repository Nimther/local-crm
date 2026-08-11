import type { Queue } from "bullmq";
import { scrubbedConsole } from "@mega-crm/redaction";

/**
 * Phase 12 (WRK-07): a process-wide registry of every long-lived BullMQ
 * `Queue` handle `apps/worker` constructs outside `server.ts`'s own
 * `workers: Worker[]` array.
 *
 * This registry exists because a `Queue` constructed inside a factory
 * module -- `flow-queues.ts`'s module-scope producer singletons, this file's
 * sibling `campaign-broadcast-producer.ts`, `campaign-scheduler.worker.ts`'s
 * long-lived kickoff producer -- is otherwise unreachable from
 * `server.ts`'s shutdown path: closing only `workers: Worker[]` (the
 * pre-Phase-12 shape) leaves every one of those handles' Redis connections
 * open past `SIGTERM`.
 *
 * Every module-scope `Queue` singleton in this process MUST wrap its
 * construction in `registerTrackedQueue(...)` at the exact call site. A
 * registration-time `Queue` that already closes itself in a `finally`
 * shortly after boot (`partition-maintenance.worker.ts`,
 * `send-reconciler.worker.ts`, `flow-segment-sweep.worker.ts`,
 * `analytics-reconciliation.worker.ts`, `flow-reconciliation.worker.ts`,
 * `campaign-scheduler.worker.ts`'s OWN tick-registration queue) must **NOT**
 * be registered here -- it is already closed before shutdown ever runs, and
 * registering it would double-close an already-closed handle.
 *
 * Phase 13 (CMP-08, D-06, plan 13-06): `webhook-replay-sweep.worker.ts`
 * follows this same split -- its own `webhook-replay-sweep` tick-registration
 * `Queue` self-closes in its `finally` (not tracked here), while its
 * lazily-created producer `Queue` for `WEBHOOK_EVENTS_QUEUE` (the queue
 * `webhook-events` -- the same one `apps/api/src/modules/webhooks/enqueue.ts`
 * produces onto) IS a genuinely long-lived producer used on every tick, and
 * IS registered here via `registerTrackedQueue` on first construction, same
 * as `campaign-broadcast-producer.ts`'s/`flow-queues.ts`'s producers.
 */

const trackedQueues: Queue[] = [];

/**
 * Registers a long-lived `Queue` handle for shutdown and returns the SAME
 * instance, so a module-scope singleton can be declared and registered in
 * one expression:
 *
 * ```ts
 * export const emailTriggeredQueue = registerTrackedQueue(
 *   new Queue<EmailTriggeredJob>(EMAIL_TRIGGERED_QUEUE, { connection, defaultJobOptions })
 * );
 * ```
 */
export function registerTrackedQueue<T extends Queue>(queue: T): T {
  trackedQueues.push(queue);
  return queue;
}

/**
 * The number of tracked handles that have not yet been closed. Test-only
 * (asserts the shutdown behavior below) -- production code never reads
 * this.
 */
export function trackedQueueCount(): number {
  return trackedQueues.length;
}

/**
 * Closes every tracked handle. An individual queue's `close()` rejecting is
 * caught and logged so one bad handle can never abort the rest -- mirrors
 * every other fire-and-forget registration `catch` in this codebase
 * (`partition-maintenance.worker.ts`'s CR-04 precedent).
 *
 * Idempotent: the tracked list is drained (spliced to empty) BEFORE the
 * closes are awaited, so a second concurrent or sequential call sees zero
 * tracked handles and resolves immediately without attempting to close an
 * already-closed (or already-closing) handle a second time.
 */
export async function closeTrackedQueues(): Promise<void> {
  const queues = trackedQueues.splice(0, trackedQueues.length);

  await Promise.all(
    queues.map(async (queue) => {
      try {
        await queue.close();
      } catch (err) {
        scrubbedConsole.error("queue-registry: failed to close a tracked queue", err);
      }
    })
  );
}
