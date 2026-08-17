import * as Sentry from "@sentry/node";
import type { Event, NodeOptions } from "@sentry/node";
import { sentryBeforeSend } from "@mega-crm/redaction";
import { getCorrelationContext } from "@mega-crm/tenant-context";
import { logger } from "./logger.js";
import { env } from "./env.js";

/**
 * Phase 15 plan 10 (OPS-08). This is the FIRST place in the codebase that
 * initializes a Sentry SDK against a live DSN -- it is safe to do so only
 * because plan 15-06's `sentryBeforeSend` (packages/redaction) already runs
 * as a blocking CI gate (`check:sentry-redaction`) before this plan's own
 * commit. See that package's own header comment (Pitfall 18: Sentry has no
 * retroactive redaction) for why `beforeSend`/`beforeSendTransaction` are the
 * actual safety mechanism here, not Sentry's own built-in scrubber.
 *
 * `dsn`/`environment`/`release` are all read from `apps/api/src/env.ts` by
 * default, but accept an `options` override so tests can exercise the real
 * SDK (real `beforeSend`, real correlation-tagging event processor) against
 * an injected transport instead of a live DSN -- see
 * `apps/api/src/__tests__/sentry.test.ts`'s "SDK transport" seam.
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
 * Attaches `workspace_id`/`request_id`/`send_id` to every captured event from
 * the CURRENT correlation context (`@mega-crm/tenant-context`) -- never
 * threaded explicitly by a capture call site. Only ever sets ids, never a
 * contact's email/phone or any freeform payload (T-15's tag-scope
 * prohibition) -- omits a field entirely when it is not bound, rather than
 * writing an empty string, so an unset field is simply absent from the
 * event's tags.
 *
 * Registered ONCE via `Sentry.addEventProcessor` (global event processors are
 * NOT cleared by a later `Sentry.init()` call) -- `initSentry` guards
 * against re-registering this on a second call in the same process (e.g. a
 * test file that calls `initSentry()` more than once).
 *
 * KNOWN RESIDUAL (verified, see `__tests__/sentry.test.ts`'s "REAL PATH"
 * test): `request_id` is bound once at `server.ts`'s outermost onRequest
 * hook and reliably reaches every exception `setupFastifyErrorHandler`
 * captures for that request. `workspace_id`, however, is bound per-route by
 * a NESTED `withTenant(workspace.id, () => ...)` call inside each route
 * handler, awaited from OUTSIDE that call -- Node's AsyncLocalStorage does
 * not propagate that nested binding to Fastify's onError capture once the
 * route handler's own promise has settled (same underlying mechanism as
 * `apps/worker/src/processor-wrapper.ts`'s `ProcessorErrorContext` header
 * comment). An exception thrown from inside a route handler's `withTenant`
 * scope therefore reaches Sentry WITHOUT `workspace_id`. See this plan's
 * SUMMARY.md "Known limitations" for why this is documented rather than
 * fixed here (fixing it touches ~10 route modules, out of this plan's scope).
 */
export function attachCorrelationTags(event: Event): Event {
  const ctx = getCorrelationContext();
  const tags: Record<string, string> = { ...(event.tags as Record<string, string> | undefined) };
  if (ctx.workspaceId !== undefined) tags.workspace_id = ctx.workspaceId;
  if (ctx.requestId !== undefined) tags.request_id = ctx.requestId;
  if (ctx.sendId !== undefined) tags.send_id = ctx.sendId;
  event.tags = tags;
  return event;
}

/**
 * Initializes the API's Sentry SDK. A missing DSN is a no-op: returns
 * `false`, logs the absence exactly once, and never throws -- a Sentry
 * outage or a deployment with no DSN configured must never block boot
 * (D-07/T-15-33). Tracing and profiling stay off (`tracesSampleRate: 0`,
 * no profiling integration configured) -- D-07: sampling would miss the
 * individual send being debugged and open a second, unscrubbed data channel
 * the redaction fixtures were not written against.
 */
export function initSentry(options: InitSentryOptions = {}): boolean {
  const dsn = options.dsn ?? env.SENTRY_DSN_API;
  if (!dsn) {
    logger.info(
      "Sentry DSN not configured (SENTRY_DSN_API unset) -- error tracking disabled for apps/api"
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
    environment: options.environment || env.SENTRY_ENVIRONMENT || env.NODE_ENV,
    release: options.release ?? env.IMAGE_TAG,
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
 * Thin, stable indirection over `Sentry.captureException` for any future
 * manual capture site outside the Fastify error handler -- kept separate
 * from `initSentry` so a call site never needs to import `@sentry/node`
 * directly (mirrors `apps/worker/src/sentry.ts`'s own capture helper).
 */
export function captureException(err: unknown): string | undefined {
  return Sentry.captureException(err);
}
