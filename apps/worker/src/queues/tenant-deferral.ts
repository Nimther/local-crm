import { DelayedError, type Job } from "bullmq";

/**
 * Phase 12 (WRK-01): a zero/negative suggested delay from an ALREADY
 * exhausted token bucket must still buy the lane a real gap before BullMQ
 * redelivers the job -- otherwise a `rateLimitMs` of 0 would move the job
 * back to `delayed` with an immediate-eligible timestamp, defeating the
 * point of deferring it at all. 250ms is a versioned floor, not derived from
 * any SendGrid-side value (the tenant bucket, not the provider, produced
 * this rejection).
 */
export const TENANT_DEFERRAL_MIN_DELAY_MS = 250;

/**
 * The single tenant-scoped deferral primitive for BOTH send lanes
 * (`email-broadcast.worker.ts` / `email-triggered.worker.ts`). Replaces the
 * previous `worker.rateLimit()` + `Worker.RateLimitError()` pair for the
 * `tenant_bucket` cause: that mechanism is documented as global-per-worker,
 * so using it for a tenant-scoped condition paused draining for every
 * tenant, not just the one that hit its own ceiling (RESEARCH.md Pattern 1).
 *
 * `job.moveToDelayed` returns the job to BullMQ's delayed set WITHOUT
 * consuming one of `attemptsMade` -- the tenant's own RPS ceiling is not a
 * failure (SEND-07's existing invariant, preserved).
 *
 * Return type `Promise<never>`: every path either throws before touching the
 * job (missing token) or throws `DelayedError` immediately after
 * `moveToDelayed` resolves (Pitfall 1 -- the throw MUST be the very next
 * statement; BullMQ's own docs warn that continuing past a successful
 * `moveToDelayed` races the job's own lock/token). Declaring `never` makes
 * an accidentally-reachable continuation after this call a compile error in
 * every caller, rather than a runtime double-resolution race.
 */
export async function deferForTenantBucket(job: Job, rateLimitMs: number, token: string | undefined): Promise<never> {
  if (!token) {
    // BullMQ supplies the token as the processor callback's own second
    // argument -- it is never derived or reconstructed. A missing token here
    // means a caller invoked this helper outside a real BullMQ processor
    // invocation (e.g. a test that forgot to pass one), so fail loudly
    // before touching the job rather than calling moveToDelayed with an
    // invalid lock credential.
    throw new Error("deferForTenantBucket requires the processor's job token (BullMQ's second processor argument) -- it must never be derived");
  }
  await job.moveToDelayed(Date.now() + Math.max(rateLimitMs, TENANT_DEFERRAL_MIN_DELAY_MS), token);
  throw new DelayedError();
}
