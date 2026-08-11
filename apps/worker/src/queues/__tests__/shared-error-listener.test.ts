import { Worker } from "bullmq";
import type { Job } from "bullmq";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startTempRedis, type TempRedis } from "@mega-crm/test-support";
import { buildRedisConnectionOptions } from "@mega-crm/queue-core";

/**
 * Phase 12 (WRK-08/WRK-10), Task 3: `server.ts`'s `attachSharedListeners`
 * attaches the shared error/failed listener over the FULL worker array
 * this process runs, wired to the dead-letter writer through the
 * terminal-vs-mid-retry gate. `packages/queue-core/src/__tests__/error-listeners.test.ts`
 * (plan 12-07) already proves the helper's own standalone behavior; THIS
 * suite proves the EXHAUSTIVENESS claim specifically -- every worker in a
 * given registry gets both listener kinds, asserted by iterating the
 * registry rather than checking a fixed subset -- and the dead-letter
 * composition server.ts wires in.
 *
 * `writeDeadLetterOnTerminalFailure` is mocked (not the real DB-backed
 * writer already covered by `dead-letter-writer.test.ts`) so this suite
 * needs only a throwaway Redis, no database, and proves the WIRING: a
 * terminal failure reaches the writer, a mid-retry failure never does.
 * `isTerminalJobFailure` is the REAL function -- the terminal/mid-retry
 * distinction itself is not re-implemented here.
 */

const { writeDeadLetterOnTerminalFailure } = vi.hoisted(() => ({
  writeDeadLetterOnTerminalFailure: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../dead-letter/dead-letter-writer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../dead-letter/dead-letter-writer.js")>();
  return {
    ...actual,
    writeDeadLetterOnTerminalFailure,
  };
});

const { attachSharedListeners } = await import("../../server.js");

function fakeJob(id: string, attemptsMade: number, attempts: number): Job {
  return { id, attemptsMade, opts: { attempts } } as unknown as Job;
}

describe("attachSharedListeners exhaustiveness (Phase 12, WRK-08/WRK-10)", () => {
  let redis: TempRedis;

  beforeAll(async () => {
    redis = await startTempRedis({});
  });

  afterAll(async () => {
    await redis?.stop();
  });

  it("attaches both listener kinds to every worker in the registry, iterating rather than checking a fixed subset", async () => {
    const connection = buildRedisConnectionOptions(redis.url);
    const workers = [
      new Worker("shared-listener-test-a", () => Promise.resolve(undefined), { connection }),
      new Worker("shared-listener-test-b", () => Promise.resolve(undefined), { connection }),
      new Worker("shared-listener-test-c", () => Promise.resolve(undefined), { connection }),
    ];

    try {
      attachSharedListeners(workers);

      for (const worker of workers) {
        expect(worker.listenerCount("error"), `${worker.name} must have an error listener`).toBe(1);
        expect(worker.listenerCount("failed"), `${worker.name} must have a failed listener`).toBe(1);
      }
    } finally {
      await Promise.all(workers.map((worker) => worker.close()));
    }
  });

  it("attaching does not double-register listeners when called more than once over the same array (WeakSet guard)", async () => {
    const connection = buildRedisConnectionOptions(redis.url);
    const workers = [new Worker("shared-listener-test-idempotent", () => Promise.resolve(undefined), { connection })];

    try {
      attachSharedListeners(workers);
      attachSharedListeners(workers);

      expect(workers[0].listenerCount("error")).toBe(1);
      expect(workers[0].listenerCount("failed")).toBe(1);
    } finally {
      await Promise.all(workers.map((worker) => worker.close()));
    }
  });

  it("a terminal failure on any registered worker reaches the dead-letter writer", async () => {
    writeDeadLetterOnTerminalFailure.mockClear();
    const connection = buildRedisConnectionOptions(redis.url);
    const workers = [new Worker("shared-listener-test-terminal", () => Promise.resolve(undefined), { connection })];

    try {
      attachSharedListeners(workers);

      const terminalJob = fakeJob("job-terminal-1", 5, 5);
      const err = new Error("terminal failure");
      workers[0].emit("failed", terminalJob, err, "failed");

      await vi.waitFor(() => {
        expect(writeDeadLetterOnTerminalFailure).toHaveBeenCalledTimes(1);
      });

      expect(writeDeadLetterOnTerminalFailure).toHaveBeenCalledWith(terminalJob, err, "shared-listener-test-terminal");
    } finally {
      await Promise.all(workers.map((worker) => worker.close()));
    }
  });

  it("a mid-retry failure on any registered worker never reaches the dead-letter writer", async () => {
    writeDeadLetterOnTerminalFailure.mockClear();
    const connection = buildRedisConnectionOptions(redis.url);
    const workers = [new Worker("shared-listener-test-mid-retry", () => Promise.resolve(undefined), { connection })];

    try {
      attachSharedListeners(workers);

      const midRetryJob = fakeJob("job-mid-retry-1", 1, 5);
      workers[0].emit("failed", midRetryJob, new Error("transient failure, retries remain"), "failed");

      // Give the failed-listener's event loop a chance to run; there is no
      // async work to await on the non-terminal path, so a short settle is
      // enough to prove the writer was never reached.
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(writeDeadLetterOnTerminalFailure).not.toHaveBeenCalled();
    } finally {
      await Promise.all(workers.map((worker) => worker.close()));
    }
  });

  it("a failure event carrying no job never reaches the dead-letter writer", async () => {
    writeDeadLetterOnTerminalFailure.mockClear();
    const connection = buildRedisConnectionOptions(redis.url);
    const workers = [new Worker("shared-listener-test-no-job", () => Promise.resolve(undefined), { connection })];

    try {
      attachSharedListeners(workers);

      expect(() => workers[0].emit("failed", undefined, new Error("no job"), "failed")).not.toThrow();

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(writeDeadLetterOnTerminalFailure).not.toHaveBeenCalled();
    } finally {
      await Promise.all(workers.map((worker) => worker.close()));
    }
  });
});
