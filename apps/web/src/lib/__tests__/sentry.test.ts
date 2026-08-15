import { describe, expect, it } from "vitest";
import * as Sentry from "@sentry/react";
import type { Event } from "@sentry/react";
import { attachRouteTags, buildSentryOptions, initSentry, isSentryConfigured, tagsForPath } from "../sentry.js";

/**
 * Phase 15 plan 11 (OPS-08 frontend half). No network access anywhere in
 * this file -- every DSN below is a syntactically-valid placeholder
 * (`Sentry.init()` validates the DSN shape but never dials out until
 * something is actually flushed against it), and every test that captures
 * an event supplies its OWN injected transport, the same "assert on what
 * would have been sent" pattern `apps/api/src/__tests__/sentry.test.ts` and
 * `apps/worker/src/__tests__/sentry.test.ts` already use. `apps/web`'s
 * vitest config runs in `environment: "node"` (no jsdom/happy-dom
 * installed) -- confirmed empirically (see this plan's own SUMMARY.md) that
 * the real `@sentry/react`/`@sentry/browser` SDK initializes and captures
 * cleanly under plain Node with no `window`/`document` present, so this
 * file exercises the REAL SDK throughout, never a mock of it.
 */

type EnvelopeItem = [{ type?: string }, unknown];
type FakeEnvelope = [unknown, EnvelopeItem[]];

/** A `transport` factory that records every "event" envelope item instead of sending it anywhere. */
function makeCapturingTransport() {
  const events: Event[] = [];
  return {
    events,
    factory: () => ({
      send: (envelope: unknown) => {
        const [, items] = envelope as FakeEnvelope;
        for (const [header, payload] of items) {
          if (header.type === "event") {
            events.push(payload as Event);
          }
        }
        return Promise.resolve({});
      },
      flush: () => Promise.resolve(true),
    }),
  };
}

describe("apps/web Sentry initialization (OPS-08)", () => {
  it("with no DSN configured, does not throw and leaves the SDK uninitialized", () => {
    let result: boolean | undefined;
    expect(() => {
      result = initSentry({});
    }).not.toThrow();
    expect(result).toBe(false);
  });

  it("the built options object contains no integration whose name matches replay or browser tracing, with both tracing and replay sample rates at 0", () => {
    const { factory } = makeCapturingTransport();
    const initialized = initSentry({
      dsn: "https://public@o0.ingest.sentry.io/1",
      transport: factory,
    });
    expect(initialized).toBe(true);
    expect(isSentryConfigured()).toBe(true);

    // Sentry.getClient() is generic over ClientOptions<BaseTransportOptions>
    // -- the browser-only replay sample rate fields aren't on that base
    // type, so the options are re-read through the BrowserOptions shape
    // this SDK actually initializes with (this is a real client, not a
    // mock, so the runtime object genuinely carries these fields).
    const options = Sentry.getClient()?.getOptions() as Sentry.BrowserOptions | undefined;
    expect(options?.tracesSampleRate).toBe(0);
    expect(options?.replaysSessionSampleRate).toBe(0);
    expect(options?.replaysOnErrorSampleRate).toBe(0);

    // `integrations` on the Options type is `Integration[] | (fn)` -- this
    // SDK is initialized with the default (array) form, never a function
    // override, so the array branch is what a real client actually holds.
    const configuredIntegrations = options?.integrations;
    const integrationNames = Array.isArray(configuredIntegrations)
      ? configuredIntegrations.map((integration) => integration.name)
      : [];
    expect(integrationNames.some((name) => /replay/i.test(name))).toBe(false);
    expect(integrationNames.some((name) => /tracing/i.test(name))).toBe(false);
  });

  it("buildSentryOptions's own return value never sets an `integrations` list -- nothing to filter a replay/tracing entry out of", () => {
    const options = buildSentryOptions("https://public@o0.ingest.sentry.io/1", {});
    expect(options.integrations).toBeUndefined();
    expect(options.tracesSampleRate).toBe(0);
    expect(options.replaysSessionSampleRate).toBe(0);
    expect(options.replaysOnErrorSampleRate).toBe(0);
  });

  it("wires beforeSend/beforeSendTransaction to the shared sentryBeforeSend and scrubs a captured exception", async () => {
    const { events, factory } = makeCapturingTransport();
    const initialized = initSentry({
      dsn: "https://public@o0.ingest.sentry.io/1",
      transport: factory,
    });
    expect(initialized).toBe(true);

    const plantedEmail = "leaked-contact@example.com";
    Sentry.captureException(new Error(`boom -- contact email ${plantedEmail}`));
    await Sentry.flush(2000);

    expect(events.length).toBeGreaterThan(0);
    const event = events[events.length - 1];
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(plantedEmail);
  });
});

describe("tagsForPath (route/workspace tagging, pure function)", () => {
  it("tags a workspace-scoped path with both route and workspace_slug", () => {
    expect(tagsForPath("/w/acme/contacts/42")).toEqual({
      route: "/w/acme/contacts/42",
      workspace_slug: "acme",
    });
  });

  it("tags a non-workspace path with route only", () => {
    expect(tagsForPath("/login")).toEqual({ route: "/login" });
  });
});

describe("attachRouteTags (source-level export shape)", () => {
  it("is exported and is a function usable as a Sentry.addEventProcessor callback", () => {
    expect(typeof attachRouteTags).toBe("function");
    expect(attachRouteTags.length).toBe(1);
  });
});
