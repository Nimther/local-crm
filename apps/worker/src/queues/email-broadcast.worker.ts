import { Worker, type Job, type ConnectionOptions } from "bullmq";
import { EMAIL_BROADCAST_QUEUE, type EmailBroadcastJob } from "@mega-crm/shared-schemas";
import { processSendJob } from "./send-dispatch.js";

/**
 * The broadcast send queue's Worker (SEND-01/02/07): wraps the SAME shared
 * `processSendJob` that `email-triggered.worker.ts` calls, so pre-send
 * gating, throttling, and dispatch logic can never drift between the two
 * send sources (ARCHITECTURE.md Pitfall 6/7). Bounded concurrency (SEND-03)
 * is the actual isolation mechanism that keeps a large broadcast fan-out
 * from starving the triggered lane -- NOT BullMQ job `priority` (which only
 * resolves contention within one queue's worker pool) and NOT a BullMQ
 * `limiter` option (per-tenant throttling is the rate-limiter-flexible
 * token bucket inside `processSendJob`, never BullMQ's global-per-worker
 * limiter).
 */
export function createEmailBroadcastWorker(connection: ConnectionOptions): Worker<EmailBroadcastJob> {
  const worker = new Worker<EmailBroadcastJob>(
    EMAIL_BROADCAST_QUEUE,
    async (job: Job<EmailBroadcastJob>) => {
      const result = await processSendJob(job.data);
      if (result.outcome === "rate_limited") {
        // SEND-07: does NOT consume one of the job's `attempts` -- BullMQ
        // moves the job back to `waiting` and pauses THIS worker's draining
        // for `rateLimitMs` (Pattern 3), whether the signal came from the
        // per-tenant token bucket or a real SendGrid 429/5xx.
        await worker.rateLimit(result.rateLimitMs);
        throw Worker.RateLimitError();
      }
    },
    // Bounded, not always-on -- broadcast fan-out must never monopolise the
    // process while the triggered lane (Phase 6) needs to keep draining.
    { connection, concurrency: 5 }
  );
  return worker;
}
