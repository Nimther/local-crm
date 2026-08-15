import { Worker, type Job, type ConnectionOptions } from "bullmq";
import { EMAIL_BROADCAST_QUEUE, type EmailBroadcastJob } from "@mega-crm/shared-schemas";
import { withCorrelation } from "@mega-crm/tenant-context";
import { processSendJob, type ProcessSendJobDeps } from "./send-dispatch.js";
import { SEND_LOCK_DURATION_MS } from "@mega-crm/queue-core";
import { deferForTenantBucket } from "./tenant-deferral.js";
import { logger } from "../logger.js";

/**
 * The broadcast Worker's per-job handler, factored out of the `Worker`
 * constructor call below (Phase 11, D-11, plan 11-10) so
 * `test-send-outcome.test.ts` can invoke it directly with a fake job and a
 * fake `sendMail` (the SAME `ProcessSendJobDeps` seam `processSendJob` has
 * exposed since Phase 4 -- no new seam), without a live BullMQ Queue/Redis
 * round trip. `deps` defaults to `{}` so every existing call site
 * (`createEmailBroadcastWorker(connection)`, unchanged) behaves identically
 * to before this export existed.
 *
 * Phase 15 plan 02 (OPS-11/OPS-12): the ENTIRE body runs inside a
 * `withCorrelation` scope bound to this job's `jobId` and the payload's
 * (optional -- pre-Phase-15 jobs carry none) `requestId`, so every log line
 * emitted by `processSendJob`/`withTenantTransaction` beneath this call --
 * and the transaction's own `application_name` -- carries the same
 * correlation identity the enqueuing HTTP request bound. This is a targeted
 * fix for THIS ONE queue's processor (the phase's tracer path) -- plan 15-05
 * owns building the general-purpose wrapper every other `create*Worker`
 * factory will route through; do not generalize this call site here.
 */
export async function handleEmailBroadcastJob(
  job: Job<EmailBroadcastJob>,
  worker: Worker<EmailBroadcastJob>,
  deps: ProcessSendJobDeps = {},
  token?: string
): Promise<void> {
  return withCorrelation({ jobId: job.id, requestId: job.data.requestId }, async () => {
    logger.info(
      { queue: EMAIL_BROADCAST_QUEUE, kind: job.data.kind, campaignId: job.data.campaignId },
      "email-broadcast job processing",
    );
    const result = await processSendJob(job.data, deps);
    // Phase 11 (D-11, plan 11-10): a test-send's `{ outcome: "unknown" }`
    // (and every other non-`rate_limited` outcome) falls through this `if`
    // untouched -- the processor resolves and the job completes. This is
    // load-bearing for D-11's no-automatic-retry guarantee: DO NOT add a
    // catch-all `else { throw ... }` below without checking whether it would
    // reintroduce test-send retries.
    if (result.outcome === "rate_limited") {
      if (result.cause === "tenant_bucket") {
        // Phase 12 (WRK-01): a tenant's own RPS ceiling is not a failure --
        // does NOT consume one of the job's `attempts`. Deferred through the
        // shared `deferForTenantBucket` helper (job.moveToDelayed), NOT
        // `worker.rateLimit()` -- that mechanism is global-per-worker and
        // would pause draining for every OTHER tenant's jobs too, not just
        // this one's. Both send lanes reach this through the same helper so
        // they cannot drift.
        await deferForTenantBucket(job, result.rateLimitMs, token);
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
  });
}

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
  const worker: Worker<EmailBroadcastJob> = new Worker<EmailBroadcastJob>(
    EMAIL_BROADCAST_QUEUE,
    (job: Job<EmailBroadcastJob>, token) => handleEmailBroadcastJob(job, worker, {}, token),
    // Bounded, not always-on -- broadcast fan-out must never monopolise the
    // process while the triggered lane (Phase 6) needs to keep draining.
    { connection, concurrency: 5, lockDuration: SEND_LOCK_DURATION_MS }
  );
  return worker;
}
