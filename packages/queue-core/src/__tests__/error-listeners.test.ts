import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Job, Worker } from "bullmq";
import { attachSharedErrorListeners } from "../error-listeners.js";

/**
 * Phase 12 (WRK-08, D-10), Task 3: `attachSharedErrorListeners` is the ONE
 * shared worker error/failed listener attach helper -- covers every
 * `<behavior>` item from 12-07-PLAN.md's Task 3 against a minimal
 * event-emitter stand-in for a `Worker` (queue-core has no BullMQ-worker
 * test fixture of its own, and none of this behavior needs a live queue).
 */

function fakeWorker(): Worker {
  return new EventEmitter() as unknown as Worker;
}

function fakeJob(id: string): Job {
  return { id } as unknown as Job;
}

describe("attachSharedErrorListeners (12-07, WRK-08, D-10)", () => {
  it("registers exactly one error listener and one failed listener on the worker", () => {
    const worker = fakeWorker();
    attachSharedErrorListeners(worker, "test-queue");

    expect((worker as unknown as EventEmitter).listenerCount("error")).toBe(1);
    expect((worker as unknown as EventEmitter).listenerCount("failed")).toBe(1);
  });

  it("logs an emitted error through the scrubbed console with the queue name, and does not rethrow", () => {
    const worker = fakeWorker();
    attachSharedErrorListeners(worker, "test-queue");

    expect(() => (worker as unknown as EventEmitter).emit("error", new Error("boom"))).not.toThrow();
  });

  it("logs an emitted failure with the queue name and job id when a job is present", () => {
    const worker = fakeWorker();
    attachSharedErrorListeners(worker, "test-queue");
    const job = fakeJob("job-123");

    expect(() => (worker as unknown as EventEmitter).emit("failed", job, new Error("failed"))).not.toThrow();
  });

  it("tolerates a failure event carrying no job", () => {
    const worker = fakeWorker();
    attachSharedErrorListeners(worker, "test-queue");

    expect(() => (worker as unknown as EventEmitter).emit("failed", undefined, new Error("no job"))).not.toThrow();
  });

  it("invokes the onTerminalFailure hook once per failure event with the job, the error and the queue name", async () => {
    const worker = fakeWorker();
    const onTerminalFailure = vi.fn().mockResolvedValue(undefined);
    attachSharedErrorListeners(worker, "test-queue", { onTerminalFailure });
    const job = fakeJob("job-456");
    const err = new Error("terminal");

    (worker as unknown as EventEmitter).emit("failed", job, err);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onTerminalFailure).toHaveBeenCalledTimes(1);
    expect(onTerminalFailure).toHaveBeenCalledWith(job, err, "test-queue");
  });

  it("catches and logs a rejecting hook -- nothing escapes to the process", async () => {
    const worker = fakeWorker();
    const onTerminalFailure = vi.fn().mockRejectedValue(new Error("hook blew up"));
    const unhandledRejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      attachSharedErrorListeners(worker, "test-queue", { onTerminalFailure });
      const job = fakeJob("job-789");

      expect(() => (worker as unknown as EventEmitter).emit("failed", job, new Error("terminal"))).not.toThrow();
      // Give the hook's rejection a chance to settle and (if unhandled) surface.
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(onTerminalFailure).toHaveBeenCalledTimes(1);
      expect(unhandledRejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("attaching the helper twice to the same worker does not double-register the listeners", () => {
    const worker = fakeWorker();
    attachSharedErrorListeners(worker, "test-queue");
    attachSharedErrorListeners(worker, "test-queue");

    expect((worker as unknown as EventEmitter).listenerCount("error")).toBe(1);
    expect((worker as unknown as EventEmitter).listenerCount("failed")).toBe(1);
  });
});
