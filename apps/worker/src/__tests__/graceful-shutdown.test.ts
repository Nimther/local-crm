import { readFileSync } from "node:fs";
import path from "node:path";
import { Queue, Worker } from "bullmq";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startTempRedis, type TempRedis } from "@mega-crm/test-support";
import { buildRedisConnectionOptions, createRedisConnection } from "@mega-crm/queue-core";
import { closeWorkerRuntime } from "../server.js";
import { closeTrackedQueues, registerTrackedQueue, trackedQueueCount } from "../queues/queue-registry.js";

/**
 * Phase 12 (WRK-07): shutdown must close every registered `Worker` AND
 * every long-lived `Queue` handle the process constructed -- not just the
 * `Worker[]` array `server.ts` tracked before this plan. `closeWorkerRuntime`
 * (exported from `server.ts` specifically so this suite does not have to
 * construct all sixteen production workers) is exercised directly against a
 * handful of real, test-scoped `Worker`s/`Queue`s driven by a throwaway
 * Redis.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");

describe("graceful shutdown (Phase 12, WRK-07)", () => {
  let redis: TempRedis;

  beforeAll(async () => {
    redis = await startTempRedis({});
  });

  afterAll(async () => {
    await redis?.stop();
  });

  it("closeTrackedQueues closes every registered handle and trackedQueueCount drops to zero", async () => {
    const connection = buildRedisConnectionOptions(redis.url);
    const q1 = registerTrackedQueue(new Queue("shutdown-test-q1", { connection }));
    const q2 = registerTrackedQueue(new Queue("shutdown-test-q2", { connection }));

    expect(trackedQueueCount()).toBeGreaterThanOrEqual(2);

    await closeTrackedQueues();

    expect(trackedQueueCount()).toBe(0);
    // Confirm both handles are actually closed, not merely forgotten.
    await expect(q1.add("noop", {})).rejects.toThrow();
    await expect(q2.add("noop", {})).rejects.toThrow();
  });

  it("closeTrackedQueues resolves even when one queue's close rejects, and is idempotent (no double-close)", async () => {
    const connection = buildRedisConnectionOptions(redis.url);
    const badQueue = registerTrackedQueue(new Queue("shutdown-test-bad", { connection }));
    const closeSpy = vi.spyOn(badQueue, "close").mockRejectedValueOnce(new Error("simulated close failure"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(closeTrackedQueues()).resolves.toBeUndefined();
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();

    // Second call: the registry was already drained by the first call, so
    // the mocked handle is never touched again.
    await expect(closeTrackedQueues()).resolves.toBeUndefined();
    expect(closeSpy).toHaveBeenCalledTimes(1);

    closeSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("closeWorkerRuntime awaits every worker close before closing tracked queues, and disconnects the shared connection only after both have settled", async () => {
    const connectionOptions = buildRedisConnectionOptions(redis.url);
    const order: string[] = [];

    const worker = new Worker("shutdown-order-worker-queue", async () => undefined, {
      connection: connectionOptions,
    });
    vi.spyOn(worker, "close").mockImplementation(async () => {
      order.push("worker-close");
    });

    const trackedQueue = registerTrackedQueue(new Queue("shutdown-order-tracked-queue", { connection: connectionOptions }));
    vi.spyOn(trackedQueue, "close").mockImplementation(async () => {
      order.push("tracked-queue-close");
    });

    const connection = createRedisConnection(redis.url);
    const disconnectSpy = vi.spyOn(connection, "disconnect").mockImplementation(() => {
      order.push("connection-disconnect");
    });

    await closeWorkerRuntime([worker], connection);

    expect(order).toEqual(["worker-close", "tracked-queue-close", "connection-disconnect"]);

    disconnectSpy.mockRestore();
  });

  it("a second closeWorkerRuntime call resolves without rejecting (idempotency)", async () => {
    const connectionOptions = buildRedisConnectionOptions(redis.url);
    const worker = new Worker("shutdown-idempotency-queue", async () => undefined, {
      connection: connectionOptions,
    });
    const connection = createRedisConnection(redis.url);

    await expect(closeWorkerRuntime([worker], connection)).resolves.toBeUndefined();
    await expect(closeWorkerRuntime([worker], connection)).resolves.toBeUndefined();
  });

  it("a job mid-processing when shutdown begins completes before shutdown resolves, and its effect is recorded", async () => {
    const connectionOptions = buildRedisConnectionOptions(redis.url);
    const QUEUE_NAME = "shutdown-inflight-queue";
    const queue = new Queue(QUEUE_NAME, { connection: connectionOptions });

    let releaseJob: (() => void) | undefined;
    const jobGate = new Promise<void>((resolve) => {
      releaseJob = resolve;
    });
    let started = false;
    let effectRecorded = false;

    const worker = new Worker(
      QUEUE_NAME,
      async () => {
        started = true;
        await jobGate;
        effectRecorded = true;
      },
      { connection: connectionOptions }
    );

    try {
      await queue.add("hold-me", {});

      await vi.waitFor(() => {
        expect(started).toBe(true);
      });

      const connection = createRedisConnection(redis.url);
      let shutdownResolved = false;
      const shutdownPromise = closeWorkerRuntime([worker], connection).then(() => {
        shutdownResolved = true;
      });

      // worker.close() (no `force`) drains the in-flight job before
      // resolving -- shutdown must NOT have resolved yet while the job is
      // still gated on jobGate.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(shutdownResolved).toBe(false);
      expect(effectRecorded).toBe(false);

      releaseJob?.();
      await shutdownPromise;

      expect(shutdownResolved).toBe(true);
      expect(effectRecorded).toBe(true);
    } finally {
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
    }
  });

  describe("source invariants", () => {
    it("every long-lived producer Queue singleton in flow-queues.ts wraps its construction in registerTrackedQueue", () => {
      const source = readFileSync(path.join(REPO_ROOT, "apps/worker/src/queues/flows/flow-queues.ts"), "utf8");
      const queueConstructions = source.match(/new Queue[<(]/g) ?? [];
      const trackedWraps = source.match(/registerTrackedQueue\(/g) ?? [];

      expect(queueConstructions.length).toBeGreaterThan(0);
      expect(
        trackedWraps.length,
        "every `new Queue(` construction in flow-queues.ts must be wrapped in registerTrackedQueue(...)"
      ).toBe(queueConstructions.length);
    });

    it("campaign-broadcast-producer.ts's emailBroadcastQueue singleton wraps its construction in registerTrackedQueue", () => {
      const source = readFileSync(path.join(REPO_ROOT, "apps/worker/src/queues/campaign-broadcast-producer.ts"), "utf8");

      expect(source).toMatch(/registerTrackedQueue\(\s*new Queue<EmailBroadcastJob>/);
    });

    it("campaign-scheduler.worker.ts's long-lived kickoff producer queue wraps its construction in registerTrackedQueue", () => {
      const source = readFileSync(path.join(REPO_ROOT, "apps/worker/src/queues/campaign-scheduler.worker.ts"), "utf8");

      expect(source).toMatch(/registerTrackedQueue\(\s*new Queue<CampaignKickoffJob>/);
    });

    it("registration-time queues that already self-close in a finally are NOT registered with the tracked-queue registry (no double-close)", () => {
      const selfClosingFiles = [
        "apps/worker/src/queues/partition-maintenance.worker.ts",
        "apps/worker/src/queues/send-reconciler.worker.ts",
        "apps/worker/src/queues/analytics-reconciliation.worker.ts",
        "apps/worker/src/queues/flows/flow-reconciliation.worker.ts",
        "apps/worker/src/queues/flows/flow-segment-sweep.worker.ts",
      ];

      for (const file of selfClosingFiles) {
        const source = readFileSync(path.join(REPO_ROOT, file), "utf8");
        expect(source, `${file} must not import registerTrackedQueue -- its registration queue already self-closes`).not.toMatch(
          /registerTrackedQueue/
        );
      }
    });

    it("server.ts's closeWorkerRuntime closes workers, then tracked queues, then disconnects the shared connection, in that order", () => {
      const source = readFileSync(path.join(REPO_ROOT, "apps/worker/src/server.ts"), "utf8");
      const closeWorkerRuntimeBody = source.slice(source.indexOf("export async function closeWorkerRuntime"));

      const workerCloseIdx = closeWorkerRuntimeBody.indexOf("workers.map((worker) => worker.close())");
      const trackedQueuesIdx = closeWorkerRuntimeBody.indexOf("closeTrackedQueues()");
      const disconnectIdx = closeWorkerRuntimeBody.indexOf("connection.disconnect()");

      expect(workerCloseIdx).toBeGreaterThan(-1);
      expect(trackedQueuesIdx).toBeGreaterThan(workerCloseIdx);
      expect(disconnectIdx).toBeGreaterThan(trackedQueuesIdx);
    });
  });
});
