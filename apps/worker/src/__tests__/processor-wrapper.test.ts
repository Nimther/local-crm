import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DelayedError, UnrecoverableError, type Job } from "bullmq";

/**
 * Phase 15 plan 08 (OPS-06), Task 1: proves `wrapProcessor` in isolation --
 * no BullMQ Worker, no Redis, no Postgres. Every case in the plan's
 * `<behavior>` block is exercised here.
 *
 * The logger singleton (`../logger.js`) is imported dynamically inside
 * `beforeAll`, AFTER `process.stdout.write` is tampered -- same convention
 * `correlation-tracer.test.ts` established (Phase 15 plan 02): pino's
 * `hasBeenTampered` check picks `process.stdout` as its destination once the
 * stream is detected as patched, instead of a raw-fd SonicBoom writer a
 * static top-level import would already have constructed against (ES module
 * imports are hoisted, so a static import would run before any tampering in
 * this file's own body could take effect).
 */
describe("wrapProcessor", () => {
  let stdoutChunks: string[];
  let workerLogger: typeof import("../logger.js")["logger"];
  let wrapProcessor: typeof import("../processor-wrapper.js")["wrapProcessor"];
  let setProcessorErrorReporter: typeof import("../processor-wrapper.js")["setProcessorErrorReporter"];
  let resetProcessorErrorReporterForTests: typeof import("../processor-wrapper.js")["resetProcessorErrorReporterForTests"];

  beforeAll(async () => {
    stdoutChunks = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });

    ({ logger: workerLogger } = await import("../logger.js"));
    // Constructed "silent" under NODE_ENV=test (logger.ts) -- bumped here so
    // this file's log assertions actually see output.
    workerLogger.level = "info";

    ({ wrapProcessor, setProcessorErrorReporter, resetProcessorErrorReporterForTests } = await import(
      "../processor-wrapper.js"
    ));
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    stdoutChunks = [];
    resetProcessorErrorReporterForTests();
  });

  afterEach(() => {
    resetProcessorErrorReporterForTests();
  });

  function fakeJob<T>(data: T, id: string): Job<T> {
    return { id, data } as Job<T>;
  }

  function capturedLogLines(): Record<string, unknown>[] {
    return stdoutChunks
      .join("")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("returns the handler's resolved value unchanged, and logs a completion line with duration", async () => {
    const job = fakeJob({ workspaceId: "ws-1" }, "job-1");
    const handler = vi.fn((): Promise<string> => Promise.resolve("handler-result"));

    const wrapped = wrapProcessor("test-queue", handler);
    const result = await wrapped(job);

    expect(result).toBe("handler-result");
    const completionLine = capturedLogLines().find((line) => line.msg === "job completed");
    expect(completionLine).toBeDefined();
    expect(completionLine?.queue).toBe("test-queue");
    expect(completionLine?.jobId).toBe("job-1");
    expect(typeof completionLine?.durationMs).toBe("number");
  });

  it("re-throws the identical DelayedError instance, never calls the reporter, and logs it as control flow", async () => {
    const job = fakeJob({ workspaceId: "ws-1" }, "job-2");
    const delayedError = new DelayedError();
    const handler = vi.fn((): Promise<never> => Promise.reject(delayedError));
    const reporter = vi.fn();
    setProcessorErrorReporter(reporter);

    const wrapped = wrapProcessor("test-queue", handler);
    let caught: unknown;
    try {
      await wrapped(job);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(delayedError);
    expect(reporter).not.toHaveBeenCalled();
    const controlFlowLine = capturedLogLines().find((line) => line.controlFlow === true);
    expect(controlFlowLine).toBeDefined();
    expect(controlFlowLine?.jobId).toBe("job-2");
    expect(typeof controlFlowLine?.durationMs).toBe("number");
  });

  it("re-throws the identical UnrecoverableError instance and never calls the reporter", async () => {
    const job = fakeJob({ workspaceId: "ws-1" }, "job-3");
    const unrecoverableError = new UnrecoverableError("stop retrying");
    const handler = vi.fn((): Promise<never> => Promise.reject(unrecoverableError));
    const reporter = vi.fn();
    setProcessorErrorReporter(reporter);

    const wrapped = wrapProcessor("test-queue", handler);
    let caught: unknown;
    try {
      await wrapped(job);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(unrecoverableError);
    expect(reporter).not.toHaveBeenCalled();
  });

  it("re-throws a plain Error unchanged and calls the reporter exactly once with the error, queue name and job id", async () => {
    const job = fakeJob({ workspaceId: "ws-1" }, "job-4");
    const plainError = new Error("boom");
    const handler = vi.fn((): Promise<never> => Promise.reject(plainError));
    const reporter = vi.fn();
    setProcessorErrorReporter(reporter);

    const wrapped = wrapProcessor("test-queue", handler);
    let caught: unknown;
    try {
      await wrapped(job);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(plainError);
    expect(reporter).toHaveBeenCalledTimes(1);
    expect(reporter).toHaveBeenCalledWith(plainError, { queue: "test-queue", jobId: "job-4" });
    const failureLine = capturedLogLines().find((line) => line.msg === "job failed");
    expect(failureLine).toBeDefined();
    expect(failureLine?.controlFlow).toBe(false);
    expect(typeof failureLine?.durationMs).toBe("number");
  });

  it("re-throws a thrown non-Error value (a string) unchanged and still calls the reporter exactly once", async () => {
    const job = fakeJob({ workspaceId: "ws-1" }, "job-5");
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- intentionally exercising a non-Error throw (behavior spec case)
    const handler = vi.fn((): Promise<never> => Promise.reject("a thrown string"));
    const reporter = vi.fn();
    setProcessorErrorReporter(reporter);

    const wrapped = wrapProcessor("test-queue", handler);
    let caught: unknown;
    try {
      await wrapped(job);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe("a thrown string");
    expect(reporter).toHaveBeenCalledTimes(1);
    expect(reporter).toHaveBeenCalledWith("a thrown string", { queue: "test-queue", jobId: "job-5" });
  });

  it("wraps the handler in a correlation scope: a log line emitted from inside the handler carries the job id", async () => {
    const job = fakeJob({ workspaceId: "ws-1" }, "job-6");
    const handler = vi.fn((): Promise<undefined> => {
      workerLogger.info("log line emitted from inside the handler");
      return Promise.resolve(undefined);
    });

    const wrapped = wrapProcessor("test-queue", handler);
    await wrapped(job);

    const innerLine = capturedLogLines().find(
      (line) => line.msg === "log line emitted from inside the handler",
    );
    expect(innerLine).toBeDefined();
    expect(innerLine?.jobId).toBe("job-6");
  });

  it("binds the payload's requestId when present", async () => {
    const job = fakeJob({ workspaceId: "ws-1", requestId: "req-abc" }, "job-7");
    const handler = vi.fn((): Promise<undefined> => {
      workerLogger.info("inner log with requestId");
      return Promise.resolve(undefined);
    });

    const wrapped = wrapProcessor("test-queue", handler);
    await wrapped(job);

    const innerLine = capturedLogLines().find((line) => line.msg === "inner log with requestId");
    expect(innerLine?.requestId).toBe("req-abc");

    const completionLine = capturedLogLines().find((line) => line.msg === "job completed");
    expect(completionLine?.requestId).toBe("req-abc");
  });

  it("falls back to the job id for requestId when the payload has none", async () => {
    const job = fakeJob({ workspaceId: "ws-1" }, "job-8");
    const handler = vi.fn((): Promise<undefined> => {
      workerLogger.info("inner log without payload requestId");
      return Promise.resolve(undefined);
    });

    const wrapped = wrapProcessor("test-queue", handler);
    await wrapped(job);

    const innerLine = capturedLogLines().find(
      (line) => line.msg === "inner log without payload requestId",
    );
    expect(innerLine?.requestId).toBe("job-8");
  });
});
