import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Queue, Worker, type Job } from "bullmq";
import { startTempRedis, type TempRedis } from "@mega-crm/test-support";
import { attachSharedErrorListeners, buildRedisConnectionOptions } from "@mega-crm/queue-core";
import { wrapProcessor } from "../processor-wrapper.js";

/**
 * Phase 15 plan 08 (OPS-06), Task 2: proves every `create*Worker` factory
 * routes its processor through `wrapProcessor` -- enumerated from the
 * FILESYSTEM (`apps/worker/src/queues/**\/*.worker.ts`), never a hard-coded
 * module list or count (the plan's own objective flags the ROADMAP's stale
 * "13 processors" claim as exactly the failure mode a fixed list/count
 * reproduces). Mirrors `packages/redaction/src/__tests__/logger-uniformity.test.ts`'s
 * Test 3 and `graceful-shutdown.test.ts`'s "source invariants" describe
 * block: a regex assertion against real file source, not an AST parse.
 */

const QUEUES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "queues");

/** Recursively finds every `*.worker.ts` file under `apps/worker/src/queues` (including `flows/`). */
function findWorkerFactoryFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findWorkerFactoryFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".worker.ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Strips block and line comments before pattern-matching construction
 * sites -- several factory files have a doc comment that itself CONTAINS the
 * literal text `new Worker(...)` (e.g. `erasure-scrub.worker.ts`'s own
 * header, describing why a constant is "NOT passed to `new Worker(...)`
 * below"), which would otherwise inflate the raw occurrence count above the
 * real number of constructions and make the two counts compared below
 * disagree for a file that is actually fully wrapped.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** Every `new Worker(...)`/`new Worker<T>(...)` construction site, comments excluded. */
const NEW_WORKER_PATTERN = /new Worker(?:<[^>]*>)?\(/g;

/**
 * A construction site whose SECOND `new Worker(...)` argument is a
 * `wrapProcessor(...)` call passed the SAME queue-name identifier the
 * `Worker` itself was constructed with -- the backreference (`\1`) is what
 * proves the queue name isn't just "some string", closing the drift this
 * plan's single-definition intent cares about (a factory that wraps with
 * the WRONG queue name's log/correlation fields would still match a looser
 * "wrapProcessor appears somewhere after new Worker" check).
 */
const WRAPPED_WORKER_PATTERN = /new Worker(?:<[^>]*>)?\(\s*([A-Za-z0-9_]+),\s*wrapProcessor\(\s*\1\s*,/g;

describe("processor-wrapper coverage: every create*Worker factory routes through wrapProcessor", () => {
  const factoryFiles = findWorkerFactoryFiles(QUEUES_DIR);

  it("the filesystem enumeration itself is not vacuous", () => {
    expect(factoryFiles.length).toBeGreaterThan(0);
    // Proves the recursive walk actually reaches queues/flows/ -- a broken
    // recursion (e.g. one that only reads the top-level directory) would
    // silently pass every per-file assertion below by finding fewer files.
    expect(factoryFiles.some((f) => f.includes(`${join("queues", "flows")}`))).toBe(true);
    // Matches this plan's own objective note: "20 factories today", not the
    // stale ROADMAP count of 13 -- asserted as a floor, not an exact count,
    // so a future factory addition does not require editing this test.
    expect(factoryFiles.length).toBeGreaterThanOrEqual(20);
  });

  it.each(factoryFiles.map((filePath) => [filePath.replace(`${QUEUES_DIR}${"/"}`, ""), filePath] as const))(
    "%s: every new Worker(...) construction's processor argument is wrapProcessor(<same queue name>, ...)",
    (_relativePath, filePath) => {
      const source = stripComments(readFileSync(filePath, "utf-8"));

      const constructionCount = source.match(NEW_WORKER_PATTERN)?.length ?? 0;
      const wrappedCount = source.match(WRAPPED_WORKER_PATTERN)?.length ?? 0;

      expect(
        wrappedCount,
        `${filePath}: found ${constructionCount} new Worker(...) construction(s) but only ${wrappedCount} routed through wrapProcessor(<same queue name>, ...)`,
      ).toBe(constructionCount);
      // Every file this enumeration finds is, by this codebase's own
      // convention, a factory file that constructs at least one Worker --
      // a file with zero constructions would trivially "pass" (0 === 0)
      // without proving anything, so guard against that silently-vacuous case.
      expect(constructionCount, `${filePath}: expected at least one new Worker(...) construction`).toBeGreaterThan(0);
    },
  );
});

/**
 * Live-Redis proof (no Postgres needed): a job whose wrapped processor
 * throws still reaches BullMQ's own `failed` event and the composed
 * `onTerminalFailure` hook (`attachSharedErrorListeners`,
 * `apps/worker/src/server.ts`'s `attachSharedListeners`) -- i.e. wrapping a
 * processor in `wrapProcessor` does not change what BullMQ, and this
 * repo's shared listener/dead-letter wiring, observe about a failing job.
 * Uses the injectable `onTerminalFailure` hook directly (the same seam
 * `error-listeners.test.ts` exercises) rather than a real Postgres
 * dead-letter write, since only the WIRING (not the write itself, already
 * covered by that file's own suite) is this test's concern.
 */
describe("processor-wrapper coverage: a failing wrapped job still reaches the shared error listeners and dead-letter hook", () => {
  let redis: TempRedis;

  beforeAll(async () => {
    redis = await startTempRedis({});
  });

  afterAll(async () => {
    await redis?.stop();
  });

  it("emits BullMQ's failed event and invokes onTerminalFailure exactly once for a job whose wrapped processor throws", async () => {
    const connection = buildRedisConnectionOptions(redis.url);
    const QUEUE_NAME = "processor-wrapper-coverage-failing-queue";
    const queue = new Queue(QUEUE_NAME, { connection });

    const thrownError = new Error("wrapped processor failure");
    const onTerminalFailure = vi.fn().mockResolvedValue(undefined);
    const failedEvents: Array<{ jobId: string | undefined; err: Error }> = [];

    const worker = new Worker(
      QUEUE_NAME,
      wrapProcessor(QUEUE_NAME, (_job: Job): Promise<never> => Promise.reject(thrownError)),
      { connection },
    );
    attachSharedErrorListeners(worker, QUEUE_NAME, { onTerminalFailure });
    worker.on("failed", (job, err) => {
      failedEvents.push({ jobId: job?.id, err });
    });

    try {
      // Default job options (no `attempts` override) -- BullMQ's own
      // default of 1 attempt means this job's first failure IS its
      // terminal failure, so `isTerminalJobFailure` (queue-core) requires
      // no retry-exhaustion setup here.
      await queue.add("fail-me", { workspaceId: "ws-coverage" });

      await vi.waitFor(
        () => {
          expect(failedEvents).toHaveLength(1);
        },
        { timeout: 5_000 },
      );
      await vi.waitFor(
        () => {
          expect(onTerminalFailure).toHaveBeenCalledTimes(1);
        },
        { timeout: 5_000 },
      );

      // Re-thrown unchanged -- the SAME instance BullMQ's `failed` event
      // reports is the one the wrapped processor threw.
      expect(failedEvents[0]?.err).toBe(thrownError);
      expect(onTerminalFailure).toHaveBeenCalledWith(
        expect.objectContaining({ id: failedEvents[0]?.jobId }),
        thrownError,
        QUEUE_NAME,
      );
    } finally {
      await worker.close();
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
    }
  });
});
