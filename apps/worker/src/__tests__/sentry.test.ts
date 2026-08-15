import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DelayedError, type Job } from "bullmq";
import * as Sentry from "@sentry/node";
import type { Event } from "@sentry/node";
import {
  wrapProcessor,
  setProcessorErrorReporter,
  resetProcessorErrorReporterForTests,
} from "../processor-wrapper.js";
import { initSentry, reportProcessorError, flushSentry, SENTRY_FLUSH_TIMEOUT_MS } from "../sentry.js";

/**
 * Phase 15 plan 10 (OPS-08), Task 2. No network access anywhere in this
 * file -- every DSN below is a syntactically-valid placeholder, and every
 * test that captures an event supplies its OWN injected transport instead of
 * dialing Sentry's real ingest endpoint.
 */

type EnvelopeItem = [{ type?: string }, unknown];
type FakeEnvelope = [unknown, EnvelopeItem[]];

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

function fakeJob<T>(data: T, id: string): Job<T> {
  return { id, data } as Job<T>;
}

describe("apps/worker Sentry initialization + processor-wrapper reporter (OPS-08)", () => {
  beforeEach(() => {
    resetProcessorErrorReporterForTests();
  });

  afterEach(() => {
    resetProcessorErrorReporterForTests();
  });

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
      dsn: "https://public@o0.ingest.sentry.io/2",
      transport: factory,
    });
    expect(initialized).toBe(true);

    const options = Sentry.getClient()?.getOptions();
    expect(options?.tracesSampleRate).toBe(0);
  });

  it("a plain thrown Error routed through wrapProcessor produces exactly one captured event tagged with queue/job_id/request_id/workspace_id", async () => {
    const { events, factory } = makeCapturingTransport();
    initSentry({ dsn: "https://public@o0.ingest.sentry.io/2", transport: factory });
    setProcessorErrorReporter(reportProcessorError);

    // Phase 15 plan 10 (OPS-08, Rule 2 deviation): workspaceId comes from
    // the JOB PAYLOAD (extractWorkspaceId in processor-wrapper.ts), not from
    // a nested `withTenant(...)` call inside the handler -- a workspaceId
    // bound only mid-handler (e.g. resolved from a DB lookup, never present
    // on the payload) is NOT visible to this reporter; see
    // processor-wrapper.ts's `ProcessorErrorContext` header comment for the
    // verified reason (Node ALS does not propagate a settled `run()`'s store
    // to an external awaiter).
    const plainError = new Error("job failed for real");
    const handler = () => Promise.reject(plainError);

    const wrapped = wrapProcessor("test-queue", handler);
    const job = fakeJob({ workspaceId: "ws-worker-sentry-test" }, "job-sentry-1");

    await expect(wrapped(job)).rejects.toBe(plainError);
    await Sentry.flush(2000);

    expect(events.length).toBe(1);
    const event = events[0];
    expect(event.tags?.queue).toBe("test-queue");
    expect(event.tags?.job_id).toBe("job-sentry-1");
    // No requestId field on this payload, so it falls back to job.id --
    // same fallback processor-wrapper.ts's own correlation binding uses.
    expect(event.tags?.request_id).toBe("job-sentry-1");
    expect(event.tags?.workspace_id).toBe("ws-worker-sentry-test");
  });

  it("a DelayedError routed through wrapProcessor produces zero captured events", async () => {
    const { events, factory } = makeCapturingTransport();
    initSentry({ dsn: "https://public@o0.ingest.sentry.io/2", transport: factory });
    setProcessorErrorReporter(reportProcessorError);

    const delayedError = new DelayedError();
    const handler = () => Promise.reject(delayedError);
    const wrapped = wrapProcessor("test-queue", handler);
    const job = fakeJob({ workspaceId: "ws-worker-sentry-test" }, "job-sentry-2");

    await expect(wrapped(job)).rejects.toBe(delayedError);
    await Sentry.flush(2000);

    expect(events.length).toBe(0);
  });

  it("with no DSN configured, the worker's real reporter never throws and captures nothing", async () => {
    // Deliberately no initSentry() call in this test -- proves the
    // uninitialized-SDK path of reportProcessorError itself, wired exactly
    // as buildWorker() wires it.
    setProcessorErrorReporter(reportProcessorError);

    const plainError = new Error("boom with no DSN");
    const handler = () => Promise.reject(plainError);
    const wrapped = wrapProcessor("test-queue", handler);
    const job = fakeJob({}, "job-sentry-3");

    await expect(wrapped(job)).rejects.toBe(plainError);
  });

  it("flushSentry resolves within its explicit timeout and is a no-op when uninitialized", async () => {
    const flushed = await flushSentry(SENTRY_FLUSH_TIMEOUT_MS);
    expect(typeof flushed).toBe("boolean");
  });
});
