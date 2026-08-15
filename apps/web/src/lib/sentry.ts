import * as Sentry from "@sentry/react";
import type { BrowserOptions, Event } from "@sentry/react";
import { sentryBeforeSend } from "@mega-crm/redaction";

/**
 * Phase 15 plan 11 (OPS-08 frontend half, OPS-17/D-11 boundary half). The
 * THIRD of D-06's three Sentry projects (web/api/worker) -- the backend two
 * were wired by plan 15-10 under the same `proceed-live-dsn` checkpoint
 * decision (see that plan's SUMMARY.md), which explicitly also governs this
 * plan: the DSN question is already answered, this file just executes it.
 *
 * Mirrors `apps/api/src/sentry.ts`/`apps/worker/src/sentry.ts`'s shape
 * (DSN-optional, shared `sentryBeforeSend`, tracing/profiling off), but with
 * two frontend-specific differences:
 *
 * 1. The DSN is a Vite BUILD-TIME value (`import.meta.env.VITE_SENTRY_DSN`),
 *    not a runtime env var read at process boot -- `apps/web` ships as a
 *    static bundle served by Caddy with no server-side runtime environment
 *    injection point (docker/Dockerfile.web, this plan's Task 3).
 * 2. Session Replay and browser performance tracing are STRUCTURALLY
 *    absent, not merely configured off (D-08). The replay/tracing
 *    integrations are never imported, added, or referenced anywhere in this
 *    file -- there is no "disabled" state for a future default flip to
 *    silently re-enable, because the integration itself is never
 *    instantiated. `tracesSampleRate`/`replaysSessionSampleRate`/
 *    `replaysOnErrorSampleRate` are ALSO pinned to `0` as a second,
 *    independent layer of the same guarantee (verified empirically against
 *    the real `@sentry/react@10.70.0` default integration set: neither
 *    "Replay" nor "BrowserTracing" appears among the SDK's own default
 *    integrations when `integrations` is left unset, so leaving it unset
 *    here is not an oversight -- it is the deliberate absence). Replay
 *    would record tenant screens containing contact emails and segment
 *    data (T-15-34) -- exactly the channel OPS-09's redaction gate exists
 *    to close for every OTHER capture path -- and no masking story has
 *    been tested for it, so it stays out entirely rather than configured
 *    to zero.
 */
export interface InitSentryOptions {
  dsn?: string;
  environment?: string;
  release?: string;
  transport?: BrowserOptions["transport"];
}

let tagProcessorRegistered = false;
let initialized = false;

/**
 * Derives the tags a captured event should carry from a route pathname,
 * pure and DOM-free so it is testable without a browser/jsdom environment
 * (`apps/web`'s vitest config runs in `environment: "node"`, T-15-11-web).
 * `workspace_slug` is read directly out of the `/w/:slug/...` path shape
 * (see `App.tsx`'s route tree) rather than through a React Router hook --
 * the event processor below runs at Sentry capture time, outside any
 * component's render, so it has no router context to read from; the URL
 * itself is the one thing that is always current, everywhere, without
 * threading state through a separate synced variable.
 */
export function tagsForPath(pathname: string): Record<string, string> {
  const tags: Record<string, string> = { route: pathname };
  const match = /^\/w\/([^/]+)/.exec(pathname);
  if (match) {
    tags.workspace_slug = match[1];
  }
  return tags;
}

/**
 * Attaches `route`/`workspace_slug` tags to every captured event by reading
 * `window.location.pathname` at CAPTURE time (mirrors `apps/web/src/lib/
 * authClient.ts`'s existing convention of reading `window.location`
 * directly -- this module only ever runs in a real browser, never under
 * `apps/web`'s Node-environment test config). Registered once via
 * `Sentry.addEventProcessor` -- never threaded explicitly by a capture call
 * site, same discipline as `apps/api/src/sentry.ts`'s `attachCorrelationTags`
 * and `apps/worker/src/sentry.ts`'s counterpart.
 */
export function attachRouteTags(event: Event): Event {
  const tags: Record<string, string> = {
    ...(event.tags as Record<string, string> | undefined),
    ...tagsForPath(window.location.pathname),
  };
  event.tags = tags;
  return event;
}

/**
 * Pure options builder -- separated from `initSentry` so a test can assert
 * on the built options object directly (source-independent: the absence of
 * replay/tracing is a property of the returned object, not a code-review
 * claim about this file's imports). `dsn` is a required parameter here
 * (never itself defaulted) -- `initSentry` below is the one place that
 * decides whether a DSN is present at all.
 */
export function buildSentryOptions(dsn: string, options: InitSentryOptions = {}): BrowserOptions {
  return {
    dsn,
    environment: options.environment ?? import.meta.env.MODE,
    release: options.release ?? (import.meta.env.VITE_SENTRY_RELEASE as string | undefined),
    beforeSend: sentryBeforeSend,
    beforeSendTransaction: sentryBeforeSend,
    // D-07/D-08: tracing and profiling stay off, same discipline as both
    // backend SDKs. Replay's own two sample rates are pinned to 0 as a
    // second, independent layer on top of the integration's structural
    // absence (see this file's header comment).
    tracesSampleRate: 0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    ...(options.transport ? { transport: options.transport } : {}),
  };
}

/**
 * Initializes the web SDK. A missing DSN is a no-op: returns `false`, logs
 * the absence exactly once, and never throws -- a fork or a local build with
 * no build-time DSN supplied must still build and run normally with error
 * tracking simply disabled (same D-07/T-15-33 contract as both backend
 * SDKs). Call this before the root render (see `main.tsx`).
 */
export function initSentry(options: InitSentryOptions = {}): boolean {
  const dsn = options.dsn ?? (import.meta.env.VITE_SENTRY_DSN as string | undefined);
  if (!dsn) {
    console.info(
      "Sentry DSN not configured (VITE_SENTRY_DSN unset at build time) -- error tracking disabled for apps/web"
    );
    return false;
  }

  Sentry.init(buildSentryOptions(dsn, options));

  if (!tagProcessorRegistered) {
    Sentry.addEventProcessor(attachRouteTags);
    tagProcessorRegistered = true;
  }

  initialized = true;
  return true;
}

/** Test/introspection only -- whether `initSentry` has successfully initialized the SDK in this process. */
export function isSentryConfigured(): boolean {
  return initialized;
}
