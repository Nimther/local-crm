import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildJobOptions,
  buildRedisConnectionOptions,
  SEND_JOB_BACKOFF_DELAY_MS,
  SEND_JOB_MAX_ATTEMPTS,
  STANDARD_JOB_RETENTION,
} from "@mega-crm/queue-core";

/**
 * WRK-11 (D-10) -- the cross-application half of "connection options, the
 * send-lane retry and timing constants and the job-option retention shapes
 * have exactly one defining module". Plan 12-02 collapsed the six worker-side
 * declarations into `@mega-crm/queue-core`; plan 12-11 (this file) collapsed
 * the five application-side declarations into the same package. This suite
 * is the invariant that keeps both collapses collapsed.
 *
 * Retention pitfall (Pitfall 6, carried from 12-02/12-11): retention is a
 * PER-QUEUE choice, not a single global shape -- `flow-run-advance` uses
 * `FLOW_RUN_ADVANCE_RETENTION` on purpose (a completed advance job must be
 * removed immediately so a future wake can never be shadowed by a
 * still-retained completed job under a reused id). This suite does not
 * assert every guarded module uses the SAME retention constant -- it asserts
 * every guarded module builds its retention through `buildJobOptions`, which
 * one of the two known constants, rather than through a hand-rolled literal.
 *
 * Correct remedy on failure: import the missing symbol from
 * `@mega-crm/queue-core` (`buildRedisConnectionOptions`, `buildJobOptions`,
 * `STANDARD_JOB_RETENTION` or `FLOW_RUN_ADVANCE_RETENTION`). NEVER add a
 * second connection-builder function or a second job-options object
 * literal -- that is exactly the drift this requirement exists to prevent,
 * and it is what let the application and worker processes disagree about
 * queue configuration across a deploy in the first place.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../../..");

/**
 * The eleven guarded modules across both applications (12-02's duplication
 * inventory + this plan's application-side half): every module in either
 * process that constructs a BullMQ `Queue` and therefore needs connection
 * options and/or job options. Modules that only import a send-lane TIMING
 * constant (`SEND_LOCK_DURATION_MS`, `CLAIM_TX_MARGIN_MS`,
 * `RECORD_TX_MARGIN_MS`) -- e.g. `email-broadcast.worker.ts`,
 * `email-triggered.worker.ts`, `tenant-lane-semaphore.ts` -- never declared a
 * connection builder or a job-option literal of their own and are therefore
 * not part of THIS guarded set (they have nothing to duplicate).
 */
const GUARDED_MODULES = [
  // Worker-side (six) -- 12-02.
  "apps/worker/src/server.ts",
  "apps/worker/src/queues/campaign-broadcast-producer.ts",
  "apps/worker/src/queues/flows/flow-queues.ts",
  "apps/worker/src/queues/send-reconciler.worker.ts",
  "apps/worker/src/queues/campaign-scheduler.worker.ts",
  "apps/worker/src/queues/partition-maintenance.worker.ts",
  // Application-side (five) -- 12-11 (this plan).
  "apps/api/src/modules/campaigns/campaign-queues.ts",
  "apps/api/src/modules/contacts/imports-csv-queue.ts",
  "apps/api/src/modules/events/events-queue.ts",
  "apps/api/src/modules/webhooks/enqueue.ts",
  "apps/api/src/modules/flows/flow-queues.ts",
] as const;

/**
 * Strips `//` line comments and `/* ... *\/` block comments from TypeScript
 * source while leaving string/template literals untouched -- a small state
 * machine, not a single regex, because a naive `//`-strips-to-end-of-line
 * regex would also truncate a template literal containing `://` (this
 * repository has exactly one, `apps/worker/src/server.ts`'s
 * `` `file://${process.argv[1]}` `` direct-run guard) and a single regex
 * has no way to know it is inside a string when it sees the `//`.
 *
 * This exists so a future explanatory comment (e.g. one that talks ABOUT
 * `attempts: 5` in prose, as several of these files' rationale comments
 * already do) can never fail this gate on comment text alone -- only actual
 * declarations in code should be able to fail it.
 */
function stripComments(source: string): string {
  let result = "";
  let mode: "code" | "line-comment" | "block-comment" | "single" | "double" | "template" = "code";
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    const next = source[i + 1];

    if (mode === "line-comment") {
      if (c === "\n") {
        mode = "code";
        result += c;
      }
      continue;
    }

    if (mode === "block-comment") {
      if (c === "*" && next === "/") {
        mode = "code";
        i += 1;
      } else if (c === "\n") {
        result += c;
      }
      continue;
    }

    if (mode === "single" || mode === "double" || mode === "template") {
      const quote = mode === "single" ? "'" : mode === "double" ? '"' : "`";
      result += c;
      if (c === "\\") {
        result += next ?? "";
        i += 1;
      } else if (c === quote) {
        mode = "code";
      }
      continue;
    }

    // mode === "code"
    if (c === "/" && next === "/") {
      mode = "line-comment";
      i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      mode = "block-comment";
      i += 1;
      continue;
    }
    if (c === "'") {
      mode = "single";
      result += c;
      continue;
    }
    if (c === '"') {
      mode = "double";
      result += c;
      continue;
    }
    if (c === "`") {
      mode = "template";
      result += c;
      continue;
    }
    result += c;
  }
  return result;
}

/** A local re-implementation of connection-options parsing -- the thing every guarded module must NOT declare any more. */
const LOCAL_CONNECTION_BUILDER_PATTERN = /new URL\(|maxRetriesPerRequest\s*:/;

/** A local job-options object literal carrying its own numeric retry-attempt count -- the other thing every guarded module must NOT declare any more. */
const LOCAL_JOB_OPTION_LITERAL_PATTERN = /attempts\s*:\s*\d+/;

const IMPORTS_QUEUE_CORE_PATTERN = /from\s+["']@mega-crm\/queue-core["']/;

describe("queue-core single-definition invariant (WRK-11, D-10)", () => {
  describe.each(GUARDED_MODULES)("%s", (relativePath) => {
    const source = readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
    const stripped = stripComments(source);

    it("imports from the shared @mega-crm/queue-core package", () => {
      expect(
        IMPORTS_QUEUE_CORE_PATTERN.test(stripped),
        `${relativePath} must import from "@mega-crm/queue-core" -- the correct remedy is to import the missing symbol, never to add a second definition`
      ).toBe(true);
    });

    it("declares no local Redis-URL connection builder", () => {
      expect(
        LOCAL_CONNECTION_BUILDER_PATTERN.test(stripped),
        `${relativePath} appears to declare its own connection-options parsing (a "new URL(" call or a "maxRetriesPerRequest:" field) instead of importing buildRedisConnectionOptions from @mega-crm/queue-core`
      ).toBe(false);
    });

    it("declares no local job-option literal carrying its own retry-attempt count", () => {
      expect(
        LOCAL_JOB_OPTION_LITERAL_PATTERN.test(stripped),
        `${relativePath} appears to declare its own job-options object literal (an "attempts: <number>" field) instead of importing buildJobOptions from @mega-crm/queue-core`
      ).toBe(false);
    });
  });

  /**
   * Explicit exclusion: apps/api/src/server.ts constructs a Redis client for
   * the distributed rate limiter (SEC-11) with a DELIBERATELY different
   * retry policy (`maxRetriesPerRequest: 1`, fail-fast) -- it is NOT a
   * BullMQ connection (BullMQ requires `maxRetriesPerRequest: null`, the
   * opposite policy) and its own comment in server.ts explains the
   * divergence. It must stay OUTSIDE the guarded set above. A future reader
   * seeing this file import nothing from `@mega-crm/queue-core` must not
   * "fix" that by collapsing it into the shared BullMQ builder -- doing so
   * would change behavior the shared builder was never meant to govern.
   */
  it("excludes apps/api/src/server.ts's non-BullMQ rate-limit Redis client on purpose", () => {
    const source = readFileSync(path.join(REPO_ROOT, "apps/api/src/server.ts"), "utf8");

    expect(
      source,
      "server.ts's rate-limit client must keep its own deliberately different maxRetriesPerRequest"
    ).toContain("maxRetriesPerRequest: 1");
    expect(
      source,
      "server.ts's non-BullMQ Redis client must stay excluded from the @mega-crm/queue-core consolidation"
    ).not.toContain("@mega-crm/queue-core");
  });

  /**
   * Positive case: the cross-process claim itself. Both processes resolve
   * their connection options and job options by calling these SAME
   * `@mega-crm/queue-core` functions -- not two independently-maintained
   * functions that happen to agree today. Calling them twice, simulating one
   * call from "the application process" and one from "the worker process",
   * produces byte-identical results, because there is exactly one function
   * body being executed either way.
   */
  describe("both processes resolve identical queue configuration from one module", () => {
    it("buildJobOptions(STANDARD_JOB_RETENTION) is identical whichever process calls it", () => {
      const applicationProcessCall = buildJobOptions(STANDARD_JOB_RETENTION);
      const workerProcessCall = buildJobOptions(STANDARD_JOB_RETENTION);

      expect(applicationProcessCall).toEqual(workerProcessCall);
      expect(applicationProcessCall.attempts).toBe(SEND_JOB_MAX_ATTEMPTS);
      expect(applicationProcessCall.backoff).toEqual({
        type: "exponential",
        delay: SEND_JOB_BACKOFF_DELAY_MS,
      });
    });

    it("buildRedisConnectionOptions(url) is identical whichever process calls it", () => {
      const redisUrl = "redis://user:pass@example.com:6380/2";
      const applicationProcessCall = buildRedisConnectionOptions(redisUrl);
      const workerProcessCall = buildRedisConnectionOptions(redisUrl);

      expect(applicationProcessCall).toEqual(workerProcessCall);
      expect(applicationProcessCall.maxRetriesPerRequest).toBeNull();
    });
  });
});
