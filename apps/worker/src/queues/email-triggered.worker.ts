import { Worker, type Job, type ConnectionOptions } from "bullmq";
import { EMAIL_TRIGGERED_QUEUE, type EmailTriggeredJob } from "@mega-crm/shared-schemas";
import { processSendJob } from "./send-dispatch.js";

/**
 * The triggered send queue's Worker (SEND-03): the reserved, always-on lane
 * for Phase 6's flow-triggered sends. Wraps the SAME shared `processSendJob`
 * that `email-broadcast.worker.ts` calls -- no separate dispatch
 * implementation, so this lane inherits the exact same pre-send gate,
 * throttling, and idempotency guarantees the broadcast lane already has.
 * Phase 6 is this queue's first real producer; registering the worker now
 * means the reserved-priority-lane architecture (two independent queues,
 * not one queue + BullMQ `priority`) is already in place before that
 * producer exists, so it simply drains an empty queue until then.
 */
export function createEmailTriggeredWorker(connection: ConnectionOptions): Worker<EmailTriggeredJob> {
  const worker = new Worker<EmailTriggeredJob>(
    EMAIL_TRIGGERED_QUEUE,
    async (job: Job<EmailTriggeredJob>) => {
      const result = await processSendJob(job.data);
      if (result.outcome === "rate_limited") {
        // SEND-07: same backoff signal as the broadcast worker -- does NOT
        // consume one of the job's `attempts` (Pattern 3).
        await worker.rateLimit(result.rateLimitMs);
        throw Worker.RateLimitError();
      }
    },
    // Higher, always-on concurrency (SEND-03) -- this lane must keep
    // draining even while a large broadcast is in flight on the other queue.
    { connection, concurrency: 20 }
  );
  return worker;
}
