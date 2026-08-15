import { Worker, type Job, type ConnectionOptions } from "bullmq";
import { EMAIL_TRIGGERED_QUEUE, type EmailTriggeredJob } from "@mega-crm/shared-schemas";
import { processSendJob, type ProcessSendJobDeps } from "./send-dispatch.js";
import { SEND_LOCK_DURATION_MS } from "@mega-crm/queue-core";
import { deferForTenantBucket } from "./tenant-deferral.js";
import { wrapProcessor } from "../processor-wrapper.js";

/**
 * The triggered Worker's per-job handler, factored out of the `Worker`
 * constructor call below (Phase 11, D-11, plan 11-10) -- see
 * `email-broadcast.worker.ts`'s `handleEmailBroadcastJob` doc comment for
 * the full rationale (same seam, same test convention, same default-`{}`
 * backward-compatibility guarantee).
 */
export async function handleEmailTriggeredJob(
  job: Job<EmailTriggeredJob>,
  worker: Worker<EmailTriggeredJob>,
  deps: ProcessSendJobDeps = {},
  token?: string
): Promise<void> {
  const result = await processSendJob(job.data, deps);
  // Phase 11 (D-11, plan 11-10): a test-send's `{ outcome: "unknown" }`
  // (and every other non-`rate_limited` outcome) falls through this `if`
  // untouched -- the processor resolves and the job completes. This is
  // load-bearing for D-11's no-automatic-retry guarantee: DO NOT add a
  // catch-all `else { throw ... }` below without checking whether it would
  // reintroduce test-send retries.
  if (result.outcome === "rate_limited") {
    if (result.cause === "tenant_bucket") {
      // Phase 12 (WRK-01): same shared-helper deferral as the broadcast
      // worker's tenant_bucket branch -- see that file's doc comment for
      // the full rationale. Both lanes reach `deferForTenantBucket` so they
      // cannot drift.
      await deferForTenantBucket(job, result.rateLimitMs, token);
    }
    // Phase 11 (D-10, plan 11-05): same bounded-retry change as the
    // broadcast worker's provider_backoff branch -- see that file's
    // doc comment for the rationale.
    throw new Error(`SendGrid provider backoff (suggested retry in ~${result.rateLimitMs}ms)`);
  }
}

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
 *
 * `lockDuration: SEND_LOCK_DURATION_MS` (Phase 11, D-15) -- explicit, no
 * longer riding BullMQ's implicit 30s default. Same value as the broadcast
 * worker (see that file's doc comment for the invariant this must satisfy).
 */
export function createEmailTriggeredWorker(connection: ConnectionOptions): Worker<EmailTriggeredJob> {
  const worker: Worker<EmailTriggeredJob> = new Worker<EmailTriggeredJob>(
    EMAIL_TRIGGERED_QUEUE,
    wrapProcessor(EMAIL_TRIGGERED_QUEUE, (job: Job<EmailTriggeredJob>, token) =>
      handleEmailTriggeredJob(job, worker, {}, token)
    ),
    // Higher, always-on concurrency (SEND-03) -- this lane must keep
    // draining even while a large broadcast is in flight on the other queue.
    { connection, concurrency: 20, lockDuration: SEND_LOCK_DURATION_MS }
  );
  return worker;
}
