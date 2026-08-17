import * as Sentry from "@sentry/node";
import type { Event, NodeOptions } from "@sentry/node";
import { sentryBeforeSend } from "@mega-crm/redaction";
import { getCorrelationContext } from "@mega-crm/tenant-context";
import { logger } from "./logger.js";
import type { ProcessorErrorContext } from "./processor-wrapper.js";

/**
 * Phase 15 plan 10 (OPS-08). Mirrors `apps/api/src/sentry.ts`'s shape
 * exactly -- same `beforeSend`/`beforeSendTransaction` wiring, same
 * tracing-off discipline, same "missing DSN is a no-op, never a boot
 * failure" contract -- but with its OWN DSN (`SENTRY_DSN_WORKER`), per D-06:
 * two separate Sentry projects for two independently-deployed images is the
 * point, not duplication to consolidate into a shared package.
 *
 * `apps/worker` has no `env.ts` (unlike `apps/api`) -- it reads
 * `process.env` directly at every call site that needs it (see
 * `apps/worker/src/server.ts`), and this file follows that same convention
 * rather than inventing one.
 */
export interface InitSentryOptions {
  dsn?: string;
  environment?: string;
  release?: string;
  transport?: NodeOptions["transport"];
}

let tagProcessorRegistered = false;
let initialized = false;

/**
 * The bounded flush timeout `server.ts`'s shutdown sequence passes to
 * `flushSentry` (T-15-32) -- named and exported here rather than a magic
 * number at the call site, so it is documented in one place and reusable by
 * a test. Comfortably under `WORKER_STOP_GRACE_PERIOD_SECONDS`'s smallest
 * configured value (60s, see docker-compose.prod.yml) with headroom left for
 * the worker/queue/connection close steps that run before it.
 */
export const SENTRY_FLUSH_TIMEOUT_MS = 3_000;

/**
 * Attaches `workspace_id`/`request_id`/`job_id`/`send_id` to every captured
 * event from the CURRENT correlation context (`@mega-crm/tenant-context`) --
 * never threaded explicitly by a capture call site. `job_id` is the one
 * field apps/api's own version of this function does not carry (the API
 * process never binds a `jobId`); `queue` is deliberately NOT read from here
 * -- it is not part of `CorrelationStore`, and is attached by
 * `reportProcessorError` below instead, straight from the wrapper's own
 * `ProcessorErrorContext`. Only ever sets ids, never a contact's
 * email/phone or any freeform payload -- omits a field entirely when it is
 * not bound, rather than writing an empty string.
 */
export function attachCorrelationTags(event: Event): Event {
  const ctx = getCorrelationContext();
  const tags: Record<string, string> = { ...(event.tags as Record<string, string> | undefined) };
  if (ctx.workspaceId !== undefined) tags.workspace_id = ctx.workspaceId;
  if (ctx.requestId !== undefined) tags.request_id = ctx.requestId;
  if (ctx.jobId !== undefined) tags.job_id = ctx.jobId;
  if (ctx.sendId !== undefined) tags.send_id = ctx.sendId;
  event.tags = tags;
  return event;
}

/**
 * Initializes the worker's Sentry SDK. A missing DSN is a no-op: returns
 * `false`, logs the absence exactly once, and never throws -- the worker
 * must boot and process jobs normally with no DSN configured (D-07/T-15-33).
 * Tracing and profiling stay off (`tracesSampleRate: 0`, no profiling
 * integration configured), same discipline as `apps/api/src/sentry.ts`.
 */
export function initSentry(options: InitSentryOptions = {}): boolean {
  const dsn = options.dsn ?? process.env.SENTRY_DSN_WORKER;
  if (!dsn) {
    logger.info(
      "Sentry DSN not configured (SENTRY_DSN_WORKER unset) -- error tracking disabled for apps/worker"
    );
    return false;
  }

  Sentry.init({
    dsn,
    // CR-01 corollary: `||`, not `??` -- an exported-but-empty
    // SENTRY_ENVIRONMENT ("") must still fall back to NODE_ENV. `??` only
    // falls through on null/undefined, so `SENTRY_ENVIRONMENT=""` would
    // otherwise pin every event's environment tag to the empty string
    // instead of falling back.
    environment: options.environment || process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV,
    release: options.release ?? process.env.IMAGE_TAG,
    tracesSampleRate: 0,
    beforeSend: sentryBeforeSend,
    beforeSendTransaction: sentryBeforeSend,
    ...(options.transport ? { transport: options.transport } : {}),
  });

  if (!tagProcessorRegistered) {
    Sentry.addEventProcessor(attachCorrelationTags);
    tagProcessorRegistered = true;
  }

  initialized = true;
  return true;
}

/** Test/introspection only -- whether `initSentry` has successfully initialized the SDK in this process. */
export function isSentryConfigured(): boolean {
  return initialized;
}

/**
 * The real reporter injected into `processor-wrapper.ts`'s
 * `setProcessorErrorReporter` seam (see `server.ts`'s `buildWorker`). Only
 * ever invoked by the wrapper for a NON-control-flow throw (`DelayedError`/
 * `UnrecoverableError` are filtered out before this is called, T-15-22) --
 * this function does not, and must not, re-implement that allowlist.
 *
 * Every tag below is taken EXPLICITLY from `context` (`ProcessorErrorContext`
 * -- widened by this same plan, Rule 2 deviation) rather than from
 * `attachCorrelationTags`'s ALS read. This is deliberate, not redundant: this
 * function runs inside `wrappedProcessor`'s own catch block, which is a
 * continuation of `wrappedProcessor` awaiting `withCorrelation(...)`'s
 * returned promise from OUTSIDE that call -- Node's AsyncLocalStorage does
 * not propagate a `run()` call's bound store to a continuation registered by
 * an external awaiter once that call's own promise has settled (verified
 * empirically; see `ProcessorErrorContext`'s own header comment for the
 * repro). `attachCorrelationTags` stays registered as a global event
 * processor regardless -- harmless, and it still correctly tags any FUTURE
 * capture made from code that is genuinely still inside an active
 * `withCorrelation`/`withTenant` scope (e.g. a manual capture added later
 * from inside a handler itself, before it throws).
 */
export function reportProcessorError(err: unknown, context: ProcessorErrorContext): void {
  Sentry.captureException(err, {
    tags: {
      queue: context.queue,
      ...(context.jobId !== undefined ? { job_id: context.jobId } : {}),
      ...(context.requestId !== undefined ? { request_id: context.requestId } : {}),
      ...(context.workspaceId !== undefined ? { workspace_id: context.workspaceId } : {}),
    },
  });
}

/**
 * Bounded flush for the shutdown sequence (T-15-32): a hanging Sentry client
 * must never extend shutdown past the deploy script's readiness budget. A
 * timeout is REQUIRED (no default) -- the call site in `server.ts` supplies
 * one explicitly, so a future author cannot accidentally call this
 * unbounded. Returns `true` immediately, without calling into the SDK at
 * all, when Sentry was never initialized (no DSN) -- there is nothing to
 * flush.
 */
export async function flushSentry(timeoutMs: number): Promise<boolean> {
  if (!initialized) {
    return true;
  }
  return Sentry.flush(timeoutMs);
}
