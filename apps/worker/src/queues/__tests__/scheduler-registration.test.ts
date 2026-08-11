import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { Queue, type ConnectionOptions, type Worker } from "bullmq";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startTempRedis, type TempRedis } from "@mega-crm/test-support";
import { buildRedisConnectionOptions } from "@mega-crm/queue-core";
import {
  createCampaignSchedulerWorker,
  waitForCampaignSchedulerRegistration,
  getCampaignSchedulerKickoffQueueForTest,
} from "../campaign-scheduler.worker.js";
import {
  createAnalyticsReconciliationWorker,
  waitForAnalyticsReconciliationRegistration,
} from "../analytics-reconciliation.worker.js";
import {
  createFlowReconciliationWorker,
  waitForFlowReconciliationRegistration,
} from "../flows/flow-reconciliation.worker.js";

/**
 * Phase 12 (WRK-13), Task 1: `campaign-scheduler.worker.ts`,
 * `analytics-reconciliation.worker.ts` and `flows/flow-reconciliation.worker.ts`
 * migrated from the older `tickQueue.add({repeat})` registration form to
 * `queue.upsertJobScheduler(...)` -- the SAME shape
 * `partition-maintenance.worker.ts`/`send-reconciler.worker.ts`/
 * `flow-segment-sweep.worker.ts` already use (mirrors
 * `partition-maintenance.worker.test.ts`'s own registration-behavior test
 * shape, extended with the legacy-coexistence and rejecting-registration
 * cases these three migrations specifically need to prove).
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../../..");
const QUEUES_DIR = path.resolve(import.meta.dirname, "..");

interface Fixture {
  label: string;
  queueName: string;
  schedulerId: string;
  jobName: string;
  legacyEveryMs: number;
  legacyJobId: string;
  sourceFile: string;
  createWorker: (connection: ConnectionOptions, options: { autorun?: boolean }) => Worker;
  waitForRegistration: (worker: Worker) => Promise<void>;
}

const FIXTURES: Fixture[] = [
  {
    label: "campaign-scheduler",
    queueName: "campaign-scheduler",
    schedulerId: "campaign-scheduler-tick",
    jobName: "scan-due-campaigns",
    legacyEveryMs: 60_000,
    legacyJobId: "scan-due-campaigns",
    sourceFile: "apps/worker/src/queues/campaign-scheduler.worker.ts",
    createWorker: (connection, options) => createCampaignSchedulerWorker(connection, options),
    waitForRegistration: waitForCampaignSchedulerRegistration,
  },
  {
    label: "analytics-reconciliation",
    queueName: "analytics-reconcile",
    schedulerId: "analytics-reconcile-tick",
    jobName: "reconcile-rollups",
    legacyEveryMs: 3 * 60_000,
    legacyJobId: "reconcile-rollups",
    sourceFile: "apps/worker/src/queues/analytics-reconciliation.worker.ts",
    createWorker: (connection, options) => createAnalyticsReconciliationWorker(connection, options),
    waitForRegistration: waitForAnalyticsReconciliationRegistration,
  },
  {
    label: "flow-reconciliation",
    queueName: "flow-reconciliation",
    schedulerId: "flow-reconciliation-tick",
    jobName: "scan-due-flow-runs",
    legacyEveryMs: 60_000,
    legacyJobId: "scan-due-flow-runs",
    sourceFile: "apps/worker/src/queues/flows/flow-reconciliation.worker.ts",
    createWorker: (connection, options) => createFlowReconciliationWorker(connection, options),
    waitForRegistration: waitForFlowReconciliationRegistration,
  },
];

describe("scheduler-registration migration (Phase 12, WRK-13)", () => {
  let redis: TempRedis;

  beforeAll(async () => {
    redis = await startTempRedis({});
  });

  afterAll(async () => {
    await redis?.stop();
  });

  describe.each(FIXTURES)("$label", (fixture) => {
    it("registers exactly one job scheduler with the stable id", async () => {
      const connection = buildRedisConnectionOptions(redis.url);
      const worker = fixture.createWorker(connection, { autorun: false });
      const queue = new Queue(fixture.queueName, { connection });

      try {
        await vi.waitFor(async () => {
          expect(await queue.getJobSchedulersCount()).toBe(1);
        });

        const schedulers = await queue.getJobSchedulers();
        expect(schedulers).toHaveLength(1);
        expect(schedulers[0].key).toBe(fixture.schedulerId);

        await fixture.waitForRegistration(worker);
      } finally {
        await worker.close();
        await queue.obliterate({ force: true });
        await queue.close();
      }
    });

    it("constructing the worker twice still leaves exactly one scheduler with that id", async () => {
      const connection = buildRedisConnectionOptions(redis.url);
      const queue = new Queue(fixture.queueName, { connection });
      const workerA = fixture.createWorker(connection, { autorun: false });

      try {
        await vi.waitFor(async () => {
          expect(await queue.getJobSchedulersCount()).toBe(1);
        });

        const workerB = fixture.createWorker(connection, { autorun: false });
        try {
          await vi.waitFor(async () => {
            expect(await queue.getJobSchedulersCount()).toBe(1);
          });

          const schedulers = await queue.getJobSchedulers();
          expect(schedulers).toHaveLength(1);
          expect(schedulers[0].key).toBe(fixture.schedulerId);

          await fixture.waitForRegistration(workerB);
        } finally {
          await workerB.close();
        }

        await fixture.waitForRegistration(workerA);
      } finally {
        await workerA.close();
        await queue.obliterate({ force: true });
        await queue.close();
      }
    });

    it("boot enqueues one immediate job with a per-boot jobId, not owned by the scheduler", async () => {
      const connection = buildRedisConnectionOptions(redis.url);
      const worker = fixture.createWorker(connection, { autorun: false });
      const queue = new Queue(fixture.queueName, { connection });

      try {
        await vi.waitFor(async () => {
          const jobs = await queue.getJobs(["waiting", "delayed"]);
          expect(jobs.some((job) => job.id?.startsWith("boot-"))).toBe(true);
        });

        const jobs = await queue.getJobs(["waiting", "delayed"]);
        const bootJobs = jobs.filter((job) => job.id?.startsWith("boot-"));
        expect(bootJobs).toHaveLength(1);

        await fixture.waitForRegistration(worker);
      } finally {
        await worker.close();
        await queue.obliterate({ force: true });
        await queue.close();
      }
    });

    it("starting from a Redis holding the legacy repeatable entry, the migrated factory leaves exactly one schedule and removes the legacy repeatable", async () => {
      const connection = buildRedisConnectionOptions(redis.url);
      const queue = new Queue(fixture.queueName, { connection });

      // Seed the legacy tickQueue.add({repeat}) entry this migration replaces.
      await queue.add(fixture.jobName, {}, { repeat: { every: fixture.legacyEveryMs }, jobId: fixture.legacyJobId });
      const legacyBefore = await queue.getRepeatableJobs();
      expect(legacyBefore).toHaveLength(1);

      const worker = fixture.createWorker(connection, { autorun: false });

      try {
        await fixture.waitForRegistration(worker);

        // getRepeatableJobs() also surfaces job-scheduler-backed entries
        // (keyed by the scheduler id) alongside legacy tickQueue.add({repeat})
        // entries (keyed by a repeat-config hash) -- filter those out so this
        // assertion is specifically about the LEGACY entry having been
        // removed, not merely about the total count.
        const repeatablesAfter = await queue.getRepeatableJobs();
        const legacyEntriesAfter = repeatablesAfter.filter((entry) => entry.key !== fixture.schedulerId);
        expect(
          legacyEntriesAfter,
          "the legacy repeatable entry must be removed, not left running alongside the new schedule"
        ).toHaveLength(0);

        const schedulers = await queue.getJobSchedulers();
        expect(schedulers).toHaveLength(1);
        expect(schedulers[0].key).toBe(fixture.schedulerId);
      } finally {
        await worker.close();
        await queue.obliterate({ force: true });
        await queue.close();
      }
    });

    it("a rejecting registration is logged and swallowed -- the factory call resolves and never surfaces as an unhandled rejection", async () => {
      const connection = buildRedisConnectionOptions(redis.url);
      const err = new Error("simulated redis hiccup at boot");
      const upsertSpy = vi.spyOn(Queue.prototype, "upsertJobScheduler").mockRejectedValueOnce(err);
      const closeSpy = vi.spyOn(Queue.prototype, "close");
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const unhandledRejections: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandledRejections.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);

      const worker = fixture.createWorker(connection, { autorun: false });

      try {
        await expect(fixture.waitForRegistration(worker)).resolves.toBeUndefined();

        expect(closeSpy).toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalled();
        expect(upsertSpy).toHaveBeenCalledTimes(1);
        expect(unhandledRejections).toHaveLength(0);
      } finally {
        process.off("unhandledRejection", onUnhandled);
        upsertSpy.mockRestore();
        closeSpy.mockRestore();
        errorSpy.mockRestore();
        await worker.close();
        const queue = new Queue(fixture.queueName, { connection });
        await queue.obliterate({ force: true }).catch(() => undefined);
        await queue.close();
      }
    });

    it("the worker file registers through upsertJobScheduler behind a guard that logs (never rethrows) and always closes the registration queue", () => {
      const source = readFileSync(path.join(REPO_ROOT, fixture.sourceFile), "utf8");

      expect(source, `${fixture.sourceFile} must call upsertJobScheduler`).toContain("upsertJobScheduler");
      expect(source, `${fixture.sourceFile} must have a finally block closing the registration queue`).toMatch(
        /finally\s*\{[\s\S]*?queue\.close\(\)/
      );
      expect(source, `${fixture.sourceFile} must catch a rejecting registration and log it rather than rethrow`).toMatch(
        /catch\s*\(err\)\s*\{\s*scrubbedConsole\.error/
      );
    });
  });

  it("the campaign scheduler's kickoff producer queue is not closed after registration and remains usable on every tick", async () => {
    const connection = buildRedisConnectionOptions(redis.url);
    const worker = createCampaignSchedulerWorker(connection, { autorun: false });
    const tickQueue = new Queue("campaign-scheduler", { connection });

    try {
      await waitForCampaignSchedulerRegistration(worker);

      const kickoffQueue = getCampaignSchedulerKickoffQueueForTest(worker);
      expect(kickoffQueue).toBeDefined();

      const job = await kickoffQueue?.add(
        "kickoff",
        { workspaceId: "ws-1", campaignId: "camp-1" },
        { jobId: "camp-1" }
      );
      expect(job?.id).toBe("camp-1");

      await kickoffQueue?.obliterate({ force: true });
      await kickoffQueue?.close();
    } finally {
      await worker.close();
      await tickQueue.obliterate({ force: true }).catch(() => undefined);
      await tickQueue.close();
    }
  });

  it("no worker file under apps/worker/src/queues still registers a repeat schedule through the older repeat-configuration argument form", () => {
    const offenders: string[] = [];
    const OLD_FORM_PATTERN = /repeat\s*:\s*\{/;

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === "__tests__") continue;
        const full = path.join(dir, entry);
        const stats = statSync(full);
        if (stats.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.endsWith(".ts")) continue;
        const source = readFileSync(full, "utf8");
        if (OLD_FORM_PATTERN.test(source)) {
          offenders.push(path.relative(REPO_ROOT, full));
        }
      }
    };

    walk(QUEUES_DIR);

    expect(offenders, `these files still contain a "repeat: {" registration argument: ${offenders.join(", ")}`).toEqual(
      []
    );
  });
});
