import { Worker, type Job, type ConnectionOptions } from "bullmq";
import { EMAIL_BROADCAST_QUEUE, type EmailBroadcastJob } from "@mega-crm/shared-schemas";
import { processSendJob } from "./send-dispatch.js";
import { SEND_LOCK_DURATION_MS } from "./queue-options.js";

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
 *
 * `lockDuration: SEND_LOCK_DURATION_MS` (Phase 11, D-15) -- explicit, no
 * longer riding BullMQ's implicit 30s default. See `queue-options.ts` and
 * `send-timing-invariant.test.ts` for the invariant this value must satisfy
 * against `SENDGRID_TIMEOUT_MS`.
 */
export function createEmailBroadcastWorker(connection: ConnectionOptions): Worker<EmailBroadcastJob> {
  const worker = new Worker<EmailBroadcastJob>(
    EMAIL_BROADCAST_QUEUE,
    async (job: Job<EmailBroadcastJob>) => {
      const result = await processSendJob(job.data);
      if (result.outcome === "rate_limited") {
        if (result.cause === "tenant_bucket") {
          // SEND-07: a tenant's own RPS ceiling is not a failure -- does NOT
          // consume one of the job's `attempts`. BullMQ moves the job back
          // to `waiting` and pauses THIS worker's draining for `rateLimitMs`
          // (Pattern 3).
          await worker.rateLimit(result.rateLimitMs);
          throw Worker.RateLimitError();
        }
        // Phase 11 (D-10, plan 11-05): `cause === "provider_backoff"` --
        // SendGrid itself returned 429/5xx. This now consumes ONE of the
        // job's BOUNDED `attempts`, with BullMQ's exponential backoff
        // applying between redeliveries -- the previous unbounded
        // Retry-After-driven `worker.rateLimit()` loop for this case is
        // deliberately gone. A provider that keeps failing lands the job in
        // the failed set, where it is visible, instead of retrying forever.
        throw new Error(`SendGrid provider backoff (suggested retry in ~${result.rateLimitMs}ms)`);
      }
    },
    // Bounded, not always-on -- broadcast fan-out must never monopolise the
    // process while the triggered lane (Phase 6) needs to keep draining.
    { connection, concurrency: 5, lockDuration: SEND_LOCK_DURATION_MS }
  );
  return worker;
}
