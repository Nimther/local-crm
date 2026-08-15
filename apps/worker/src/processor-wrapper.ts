import { DelayedError, UnrecoverableError, type Job } from "bullmq";
import { withCorrelation } from "@mega-crm/tenant-context";
import { logger } from "./logger.js";

/**
 * Phase 15 plan 08 (OPS-06): the SINGLE instrumentation point every
 * `create*Worker` factory in `apps/worker/src/queues/**` routes its
 * processor function through -- the same single-definition discipline
 * queue-core applied to Redis connection options in Phase 12. Opens the
 * correlation scope (`withCorrelation`) the pino mixin reads
 * (`getCorrelationContext()`, `apps/worker/src/logger.ts`), times the
 * handler, classifies any thrown value against a fixed control-flow
 * allowlist, and reports non-control-flow throws through an injectable
 * seam.
 *
 * NO SENTRY SDK IS IMPORTED OR INITIALIZED HERE. The error-reporter seam
 * below (`setErrorReporter`) defaults to a no-op -- plan 15-10 supplies the
 * real Sentry-backed reporter once the OPS-09 gate (Sentry SDK
 * init/beforeSend scrubbing) has landed. Wiring Sentry directly into this
 * module would initialize the SDK ahead of that gate, which this plan must
 * not do.
 *
 * Control-flow allowlist (built from what THIS repo actually throws, not
 * assumed from the pattern doc):
 *   - `DelayedError` -- thrown by `apps/worker/src/queues/tenant-deferral.ts`'s
 *     `deferForTenantBucket`, immediately after `job.moveToDelayed` resolves.
 *     A tenant's own RPS ceiling is not a failure (Phase 12, WRK-01); this
 *     wrapper does not interpose anything between BullMQ's own handling of
 *     that instance and its catch block above -- it only reads
 *     `instanceof`/re-throws, it never calls a job method.
 *   - `UnrecoverableError` -- BullMQ's own control-flow signal for "move to
 *     failed without consuming attempts"; not currently thrown anywhere in
 *     this repo's queues, but it is BullMQ's own documented mechanism for
 *     the same class of intentional-non-failure outcome as `DelayedError`,
 *     so it is allowlisted alongside it per this plan's threat register
 *     (T-15-22).
 * Both classes are re-exported by BullMQ's top-level `bullmq` package (the
 * same import path `tenant-deferral.ts` already uses).
 *
 * `send-dispatch.ts`'s rate-limit path (`processSendJob`'s `"rate_limited"`
 * outcome) does NOT throw at all -- it returns a discriminated-union outcome
 * value that `email-broadcast.worker.ts`/`email-triggered.worker.ts` inspect
 * and turn into either `deferForTenantBucket` (which throws `DelayedError`)
 * or a plain `Error` (the `provider_backoff` cause, a real bounded-retry
 * failure) -- so the allowlist above is already exhaustive against every
 * throw site this codebase has today.
 */

/**
 * Context passed to the injected error reporter alongside the thrown value.
 *
 * Phase 15 plan 10 (OPS-08, Rule 2 deviation -- see that plan's SUMMARY.md):
 * `requestId`/`workspaceId` were added here, explicit rather than left for
 * the reporter to read off `@mega-crm/tenant-context`'s ALS correlation
 * store itself. That would look like the more "central" choice, but it does
 * NOT work: `wrappedProcessor`'s catch block below runs as a continuation of
 * `wrappedProcessor` ITSELF awaiting `withCorrelation(...)`'s returned
 * promise from OUTSIDE that call -- Node's AsyncLocalStorage does not
 * propagate a `run()` call's bound store to a continuation registered by an
 * external awaiter once that call's own promise has settled (verified
 * empirically: a minimal `als.run(store, asyncFn)` whose caller does
 * `promise.catch(() => als.getStore())` sees `undefined`, not `store`, on
 * every tested Node 26 build). `queue`/`jobId` were already explicit for the
 * unrelated reason of being the two values `wrappedProcessor` already holds
 * as plain locals; `requestId`/`workspaceId` follow the same explicit-field
 * discipline for the same underlying reason, not two different reasons.
 */
export interface ProcessorErrorContext {
  queue: string;
  jobId: string | undefined;
  requestId: string | undefined;
  workspaceId: string | undefined;
}

/** The error-reporter seam's shape -- synchronous, side-effecting only (never awaited, never affects control flow). */
export type ProcessorErrorReporter = (err: unknown, context: ProcessorErrorContext) => void;

/** Default reporter: does nothing. Keeps this module Sentry-free until plan 15-10 injects the real one. */
const noopErrorReporter: ProcessorErrorReporter = () => {
  // Intentionally empty -- see module header. No Sentry SDK import here.
};

let errorReporter: ProcessorErrorReporter = noopErrorReporter;

/**
 * Injects the reporter every non-control-flow throw is forwarded to. Called
 * once at process composition time (plan 15-10, after the OPS-09 Sentry
 * gate) -- never imported/invoked from inside this module itself.
 */
export function setProcessorErrorReporter(reporter: ProcessorErrorReporter): void {
  errorReporter = reporter;
}

/** Test-only: restores the no-op default so one test's injected reporter cannot leak into another's assertions. */
export function resetProcessorErrorReporterForTests(): void {
  errorReporter = noopErrorReporter;
}

/**
 * The exhaustive control-flow allowlist (see module header for why each
 * entry is here). `instanceof` classification, not a name/message string
 * match -- both classes are checked against the exact instance BullMQ's own
 * `Worker` internals later re-check with the same `instanceof` test, so
 * re-throwing the identical instance (never a copy/wrap) is what keeps that
 * check working.
 */
const CONTROL_FLOW_ERROR_CLASSES = [DelayedError, UnrecoverableError] as const;

function isControlFlowError(err: unknown): boolean {
  return CONTROL_FLOW_ERROR_CLASSES.some((errorClass) => err instanceof errorClass);
}

/**
 * Reads an optional `requestId` off a job's payload without assuming every
 * job schema declares one -- only `emailBroadcastJobSchema` (plan 15-02)
 * currently does; every other queue's payload has no such field, and a
 * repeatable tick / webhook-originated job has no originating HTTP request
 * to derive one from at all. Returns `undefined` rather than throwing for
 * any shape that doesn't carry a string `requestId`.
 */
function extractRequestId(data: unknown): string | undefined {
  if (data !== null && typeof data === "object" && "requestId" in data) {
    const value = (data as { requestId?: unknown }).requestId;
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

/**
 * Reads an optional `workspaceId` off a job's payload -- the same defensive,
 * never-throwing shape as `extractRequestId` above. Phase 15 plan 10
 * (OPS-08): unlike `requestId`, `workspaceId` is declared on nearly every
 * job schema in `packages/shared-schemas/src/queues.ts` (it is the "SOLE
 * context the worker trusts" per that file's own comment), but a handful of
 * platform-wide/cross-tenant jobs (partition maintenance, the send
 * reconciler's own tick, ...) genuinely have none -- `undefined` for those
 * is correct, not a bug.
 */
function extractWorkspaceId(data: unknown): string | undefined {
  if (data !== null && typeof data === "object" && "workspaceId" in data) {
    const value = (data as { workspaceId?: unknown }).workspaceId;
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

/**
 * Wraps a BullMQ processor function with instrumentation, returning a
 * processor with the IDENTICAL signature BullMQ expects -- a factory's call
 * site changes only by wrapping its existing handler in this function, no
 * other change to `new Worker(...)`'s construction.
 *
 * Behavior:
 *   - Resolves: returns the handler's value unchanged. Logs a completion
 *     line carrying queue/jobId/requestId/durationMs.
 *   - Throws `DelayedError`/`UnrecoverableError` (control flow): re-throws
 *     the SAME instance unchanged, does NOT call the error reporter, logs a
 *     line explicitly marked `controlFlow: true` rather than as a failure.
 *   - Throws anything else (an `Error`, a string, an object, ...): re-throws
 *     the SAME value unchanged, calls the error reporter exactly once with
 *     that value plus `{ queue, jobId, requestId, workspaceId }` (the latter
 *     two read directly off the job, per `ProcessorErrorContext`'s own
 *     header comment -- NOT off the ALS correlation store, which the
 *     reporter cannot see from here), logs a failure line.
 *   - Every path re-throws the original thrown value unchanged -- this
 *     wrapper never swallows an error, or BullMQ's own retry/delay/stall
 *     handling breaks (T-15-23).
 *
 * The handler runs inside a `withCorrelation({ jobId, requestId }, ...)`
 * scope (merge-forward per RESEARCH.md Pitfall 7, `@mega-crm/tenant-context`)
 * so every log line the handler itself emits -- and everything it calls,
 * including a nested `withTenant`/`withTenantTransaction` -- carries the
 * same correlation identity, via the pino `mixin()` in `./logger.js`.
 */
export function wrapProcessor<DataType, ResultType = void>(
  queueName: string,
  handler: (job: Job<DataType>, token?: string) => Promise<ResultType>
): (job: Job<DataType>, token?: string) => Promise<ResultType> {
  return async function wrappedProcessor(job: Job<DataType>, token?: string): Promise<ResultType> {
    const requestId = extractRequestId(job.data) ?? job.id;
    const workspaceId = extractWorkspaceId(job.data);
    const child = logger.child({ queue: queueName, jobId: job.id, requestId });
    const start = Date.now();

    try {
      const result = await withCorrelation({ jobId: job.id, requestId }, () => handler(job, token));
      child.info({ durationMs: Date.now() - start }, "job completed");
      return result;
    } catch (err) {
      const durationMs = Date.now() - start;
      const controlFlow = isControlFlowError(err);
      if (controlFlow) {
        // Not a failure -- an intentional BullMQ control-flow signal
        // (tenant-bucket deferral or an unrecoverable-but-expected stop).
        // Never reported: reporting these would flood the tracker with
        // routine rate-limit backpressure and corrupt the failed-send-share
        // denominator (T-15-22).
        child.info({ durationMs, controlFlow: true }, "job control flow (not reported)");
      } else {
        // The reporter runs inside its OWN try/catch: a future reporter
        // (plan 15-10's Sentry-backed one) that itself throws must never
        // replace `err` as the value this function re-throws -- the
        // wrapper's "same value re-thrown on every path" guarantee (T-15-23)
        // has to hold even when the injected reporter is misbehaving.
        try {
          errorReporter(err, { queue: queueName, jobId: job.id, requestId, workspaceId });
        } catch (reporterErr) {
          child.error({ err: reporterErr, durationMs }, "error reporter itself threw -- ignored, original error still re-thrown");
        }
        child.error({ err, durationMs, controlFlow: false }, "job failed");
      }
      // ALWAYS re-throw the original value, unchanged, on every path --
      // BullMQ's retry, delay and stall handling all depend on the exact
      // thrown value (and, for DelayedError/UnrecoverableError, the exact
      // instance) reaching it.
      throw err;
    }
  };
}
