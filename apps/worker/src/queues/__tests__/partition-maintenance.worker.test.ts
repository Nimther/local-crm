import { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pool as tenantContextPool } from "@mega-crm/tenant-context";
import { startTempRedis, type TempRedis } from "@mega-crm/test-support";
import type { PartitionClient } from "@mega-crm/db/src/partitions/ensure-partitions.js";
import type { MaintenanceRunSnapshot } from "@mega-crm/db/src/partitions/maintenance-run.js";

import { buildRedisConnectionOptions } from "@mega-crm/queue-core";
import {
  createPartitionMaintenanceWorker,
  processPartitionMaintenance,
  waitForPartitionMaintenanceRegistration,
  PARTITION_MAINTENANCE_QUEUE,
} from "../partition-maintenance.worker.js";

/**
 * 09-02 (DB-01/DB-02): the daily cron-scheduled partition-maintenance
 * worker. Tests 1-3 exercise real registration behaviour against a
 * throwaway Redis (scheduler shape, idempotent re-registration, the
 * boot-time immediate run); tests 4-5 exercise the exported processor
 * function directly, with an injected client/clock/`runPartitionMaintenance`,
 * so they need no live queue or database at all.
 */
describe("partition maintenance worker (09-02, DB-01/DB-02)", () => {
  let redis: TempRedis;

  beforeAll(async () => {
    redis = await startTempRedis({});
  });

  afterAll(async () => {
    await redis?.stop();
  });

  it("test 1: registers exactly one job scheduler with the stable daily id/pattern/UTC tz", async () => {
    const connection = buildRedisConnectionOptions(redis.url);
    // autorun: false -- this test asserts what gets REGISTERED, not what a
    // real processor run does against the pooled client (tests 4/5 cover
    // the processor directly, injected).
    const worker = createPartitionMaintenanceWorker(connection, { autorun: false });
    const queue = new Queue(PARTITION_MAINTENANCE_QUEUE, { connection });

    try {
      await vi.waitFor(async () => {
        expect(await queue.getJobSchedulersCount()).toBe(1);
      });

      const schedulers = await queue.getJobSchedulers();
      expect(schedulers).toHaveLength(1);
      // BullMQ's JobSchedulerJson identifies a scheduler by `key` (the
      // scheduler id passed to upsertJobScheduler/getJobScheduler), not by
      // an `id` field on the returned record.
      expect(schedulers[0].key).toBe("partition-maintenance-daily");
      expect(schedulers[0].pattern).toBe("0 3 * * *");
      expect(schedulers[0].tz).toBe("UTC");

      // Deterministically wait for this worker's own fire-and-forget
      // registration (and its internal Queue handle) to fully settle
      // before this test's cleanup runs -- otherwise that background
      // close() can race the temp Redis teardown in a later test/afterAll.
      await waitForPartitionMaintenanceRegistration(worker);
    } finally {
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  it("test 2: constructing the worker twice still leaves exactly one scheduler with that id", async () => {
    const connection = buildRedisConnectionOptions(redis.url);
    const queue = new Queue(PARTITION_MAINTENANCE_QUEUE, { connection });
    const workerA = createPartitionMaintenanceWorker(connection, { autorun: false });

    try {
      await vi.waitFor(async () => {
        expect(await queue.getJobSchedulersCount()).toBe(1);
      });

      const workerB = createPartitionMaintenanceWorker(connection, { autorun: false });
      try {
        // Give the second upsert a moment to land against the same Redis,
        // then assert it never created a second competing schedule.
        await vi.waitFor(async () => {
          expect(await queue.getJobSchedulersCount()).toBe(1);
        });

        const schedulers = await queue.getJobSchedulers();
        expect(schedulers).toHaveLength(1);
        expect(schedulers[0].key).toBe("partition-maintenance-daily");

        await waitForPartitionMaintenanceRegistration(workerB);
      } finally {
        await workerB.close();
      }

      await waitForPartitionMaintenanceRegistration(workerA);
    } finally {
      await workerA.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  it("test 3: boot enqueues one immediate job with a per-boot jobId, not owned by the scheduler", async () => {
    const connection = buildRedisConnectionOptions(redis.url);
    const worker = createPartitionMaintenanceWorker(connection, { autorun: false });
    const queue = new Queue(PARTITION_MAINTENANCE_QUEUE, { connection });

    try {
      await vi.waitFor(async () => {
        const jobs = await queue.getJobs(["waiting", "delayed"]);
        expect(jobs.some((job) => job.id?.startsWith("boot-"))).toBe(true);
      });

      const jobs = await queue.getJobs(["waiting", "delayed"]);
      const bootJobs = jobs.filter((job) => job.id?.startsWith("boot-"));
      expect(bootJobs).toHaveLength(1);

      await waitForPartitionMaintenanceRegistration(worker);
    } finally {
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  it("test 4: the processor delegates to runPartitionMaintenance once with the injected client and instant", async () => {
    const fakeClient = {} as PartitionClient;
    const fakeNow = new Date("2026-09-01T03:00:00.000Z");
    const fakeSnapshot: MaintenanceRunSnapshot = {
      lastRunAt: fakeNow,
      lookaheadMonths: 3,
      bufferAlertThresholdMonths: 2,
      eventsBufferMonths: 3,
      sendEventsBufferMonths: 3,
      bufferMonthsRemaining: 3,
      eventsDefaultCount: 0,
      sendEventsDefaultCount: 0,
      partitionsCreated: [],
    };
    const runMaintenance = vi.fn().mockResolvedValue(fakeSnapshot);

    const result = await processPartitionMaintenance({
      client: fakeClient,
      now: () => fakeNow,
      runMaintenance,
    });

    expect(runMaintenance).toHaveBeenCalledTimes(1);
    expect(runMaintenance).toHaveBeenCalledWith(fakeClient, fakeNow, {
      lookaheadMonths: 3,
      bufferAlertThresholdMonths: 2,
    });
    expect(result).toBe(fakeSnapshot);
  });

  it("test 5: a rejecting runPartitionMaintenance causes the processor to reject, never swallowed", async () => {
    const err = new Error("ddl failure: could not attach partition");
    const runMaintenance = vi.fn().mockRejectedValue(err);

    await expect(
      processPartitionMaintenance({
        client: {} as PartitionClient,
        now: () => new Date(),
        runMaintenance,
      }),
    ).rejects.toThrow("ddl failure: could not attach partition");
  });

  it("test 6 (09-REVIEW CR-03): the default client is NOT @mega-crm/tenant-context's shared, tenant-scoped pool", async () => {
    // No `client` override -- this exercises the SAME default-wiring line
    // production hits (`deps.client ?? <default>`), unlike tests 4/5 which
    // always inject an explicit client. attachPartitionCheckFirst's
    // admin-scan invariant (ensure-partitions.ts / migration 0039) requires
    // this worker's connection to have NEVER run a tenant-scoped
    // `SET LOCAL app.current_workspace_id` -- handing it
    // @mega-crm/tenant-context's own shared `pool` (which every
    // withTenantTransaction call in this same process checks connections
    // out of) would violate that by construction, not merely by accident.
    const fakeNow = new Date("2026-09-01T03:00:00.000Z");
    const fakeSnapshot: MaintenanceRunSnapshot = {
      lastRunAt: fakeNow,
      lookaheadMonths: 3,
      bufferAlertThresholdMonths: 2,
      eventsBufferMonths: 3,
      sendEventsBufferMonths: 3,
      bufferMonthsRemaining: 3,
      eventsDefaultCount: 0,
      sendEventsDefaultCount: 0,
      partitionsCreated: [],
    };
    const runMaintenance = vi.fn().mockResolvedValue(fakeSnapshot);

    await processPartitionMaintenance({ now: () => fakeNow, runMaintenance });

    expect(runMaintenance).toHaveBeenCalledTimes(1);
    const usedClient = runMaintenance.mock.calls[0]?.[0] as unknown;
    expect(usedClient).not.toBe(tenantContextPool);
  });

  it("test 7 (09-REVIEW CR-04): a scheduler-registration failure is caught (never surfaces as a rejection) and still closes the internal queue", async () => {
    const connection = buildRedisConnectionOptions(redis.url);
    const err = new Error("simulated redis hiccup at boot");
    // Intercepts before any Redis I/O -- deterministic, no dependency on
    // actually breaking the throwaway Redis connection.
    const upsertSpy = vi.spyOn(Queue.prototype, "upsertJobScheduler").mockRejectedValueOnce(err);
    const closeSpy = vi.spyOn(Queue.prototype, "close");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const worker = createPartitionMaintenanceWorker(connection, { autorun: false });

    try {
      // Before the fix this rejects (the async IIFE has no catch, so the
      // stored `registration` promise itself rejects with `err`) -- in
      // production nobody ever awaits/catches it, which is precisely what
      // makes that an unhandled rejection. After the fix the promise
      // resolves cleanly: the failure was logged and swallowed instead.
      await expect(waitForPartitionMaintenanceRegistration(worker)).resolves.toBeUndefined();

      expect(closeSpy).toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();
      // queue.add must never be reached on this path -- the failure happened
      // on the prior await.
      expect(upsertSpy).toHaveBeenCalledTimes(1);
    } finally {
      upsertSpy.mockRestore();
      closeSpy.mockRestore();
      errorSpy.mockRestore();
      await worker.close();
    }
  });
});
