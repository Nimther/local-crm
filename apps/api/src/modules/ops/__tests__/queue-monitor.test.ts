import { describe, expect, it } from "vitest";

import {
  readAllQueueMetrics,
  readQueueMetrics,
  type QueueMonitorQueueLike,
} from "../queue-monitor.js";

/**
 * Phase 15 (OPS-13, plan 15-13, Task 1): `readQueueMetrics`/`readAllQueueMetrics`
 * against plain fake `QueueMonitorQueueLike` objects -- no real Redis, no
 * real BullMQ `Queue` -- mirroring `send-reconciler-watchdog.test.ts`'s own
 * "pure, no DB" describe block for the parts of this module that need no
 * live connection at all. The module's own real `emailTriggeredQueue` handle
 * is exercised implicitly by every OTHER apps/api test that imports this
 * module transitively; this file never touches it directly.
 */

function fakeQueue(overrides: Partial<QueueMonitorQueueLike> = {}): QueueMonitorQueueLike {
  return {
    getJobCounts: async () => ({ waiting: 0, delayed: 0, active: 0, failed: 0 }),
    getWaiting: async () => [],
    getDelayed: async () => [],
    ...overrides,
  };
}

describe("readQueueMetrics", () => {
  it("test 1: a queue with no jobs reports zero counts and a null oldest-pending timestamp", async () => {
    const result = await readQueueMetrics(fakeQueue());
    expect(result).toEqual({
      readable: true,
      waiting: 0,
      delayed: 0,
      active: 0,
      failed: 0,
      oldestPendingAt: null,
    });
  });

  it("test 2: counts pass through from getJobCounts verbatim", async () => {
    const result = await readQueueMetrics(
      fakeQueue({
        getJobCounts: async () => ({ waiting: 12, delayed: 3, active: 1, failed: 2 }),
      }),
    );
    expect(result).toMatchObject({ readable: true, waiting: 12, delayed: 3, active: 1, failed: 2 });
  });

  it("test 3: the oldest pending timestamp is the min across waiting and delayed jobs", async () => {
    const older = 1_000;
    const newer = 5_000;
    const result = await readQueueMetrics(
      fakeQueue({
        getWaiting: async () => [{ timestamp: newer }],
        getDelayed: async () => [{ timestamp: older }],
      }),
    );
    expect(result.readable).toBe(true);
    if (result.readable) {
      expect(result.oldestPendingAt?.getTime()).toBe(older);
    }
  });

  it("test 4: a Redis failure surfaces as unreadable, never as zero counts", async () => {
    const result = await readQueueMetrics(
      fakeQueue({
        getJobCounts: () => Promise.reject(new Error("ECONNREFUSED")),
      }),
    );
    expect(result.readable).toBe(false);
    if (!result.readable) {
      expect(result.error).toContain("ECONNREFUSED");
    }
  });

  it("test 5: a failure in getWaiting alone (counts still resolve) still surfaces as unreadable, not partial zero counts", async () => {
    const result = await readQueueMetrics(
      fakeQueue({
        getWaiting: () => Promise.reject(new Error("connection lost")),
      }),
    );
    expect(result.readable).toBe(false);
  });
});

describe("readAllQueueMetrics", () => {
  it("test 6: every monitored queue name is covered exactly once, and one queue's failure never masks another's result", async () => {
    const queues: Record<string, QueueMonitorQueueLike> = {
      "queue-a": fakeQueue(),
      "queue-b": fakeQueue({ getJobCounts: () => Promise.reject(new Error("down")) }),
      "queue-c": fakeQueue({ getJobCounts: async () => ({ waiting: 5, delayed: 0, active: 0, failed: 0 }) }),
    };

    const results = await readAllQueueMetrics(queues);

    expect(Object.keys(results).sort()).toEqual(["queue-a", "queue-b", "queue-c"]);
    expect(results["queue-a"]).toMatchObject({ readable: true, waiting: 0 });
    expect(results["queue-b"]).toMatchObject({ readable: false });
    expect(results["queue-c"]).toMatchObject({ readable: true, waiting: 5 });
  });
});
