import { describe, expect, it } from "vitest";
import * as Sentry from "@sentry/node";
import type { Event } from "@sentry/node";
import { withCorrelation } from "@mega-crm/tenant-context";
import { initSentry } from "../sentry.js";

/**
 * Phase 15 plan 10 (OPS-08). No network access anywhere in this file --
 * every DSN below is a syntactically-valid placeholder (Sentry.init()
 * validates the DSN shape but never dials out until something is actually
 * flushed against it), and every test that captures an event supplies its
 * OWN injected transport (the SDK's own extension point for exactly this
 * "assert on what would have been sent" use case) so nothing here reaches
 * Sentry's real ingest endpoint.
 */

type EnvelopeItem = [{ type?: string }, unknown];
type FakeEnvelope = [unknown, EnvelopeItem[]];

/** A `transport` factory that records every "event" envelope item instead of sending it anywhere. */
function makeCapturingTransport() {
  const events: Event[] = [];
  return {
    events,
    factory: () => ({
      send: async (envelope: unknown) => {
        const [, items] = envelope as FakeEnvelope;
        for (const [header, payload] of items) {
          if (header.type === "event") {
            events.push(payload as Event);
          }
        }
        return {};
      },
      flush: async () => true,
    }),
  };
}

describe("apps/api Sentry initialization (OPS-08)", () => {
  it("with no DSN configured, does not throw and leaves the SDK uninitialized", () => {
    let result: boolean | undefined;
    expect(() => {
      result = initSentry({});
    }).not.toThrow();
    expect(result).toBe(false);
  });

  it("initializes with tracing disabled and the shared beforeSend/beforeSendTransaction", () => {
    const { factory } = makeCapturingTransport();
    const initialized = initSentry({
      dsn: "https://public@o0.ingest.sentry.io/1",
      transport: factory,
    });
    expect(initialized).toBe(true);

    const options = Sentry.getClient()?.getOptions();
    expect(options?.tracesSampleRate).toBe(0);
  });

  it("captures an exception tagged with workspace_id/request_id from the bound correlation context, scrubbed, with send_id omitted when unbound", async () => {
    const { events, factory } = makeCapturingTransport();
    const initialized = initSentry({
      dsn: "https://public@o0.ingest.sentry.io/1",
      transport: factory,
    });
    expect(initialized).toBe(true);

    const plantedEmail = "leaked-contact@example.com";

    await withCorrelation({ workspaceId: "ws-sentry-test", requestId: "req-sentry-test" }, async () => {
      Sentry.captureException(new Error(`boom -- contact email ${plantedEmail}`));
    });
    await Sentry.flush(2000);

    expect(events.length).toBeGreaterThan(0);
    const event = events[events.length - 1];

    expect(event.tags?.workspace_id).toBe("ws-sentry-test");
    expect(event.tags?.request_id).toBe("req-sentry-test");
    expect(event.tags?.send_id).toBeUndefined();

    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(plantedEmail);
    for (const value of Object.values(event.tags ?? {})) {
      expect(value).not.toBe(plantedEmail);
    }
  });
});
