import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FAILED_JOB_RETENTION_SECONDS,
  FLOW_RUN_ADVANCE_RETENTION,
  STANDARD_JOB_RETENTION,
} from "@mega-crm/queue-core";

/**
 * WRK-09 (D-10, Pitfall 6/7) -- the invariant that no queue in either
 * application keeps failed jobs indefinitely, and that the per-queue
 * retention parameterisation (`flow-run-advance`'s deliberately different
 * policy) survives.
 *
 * CAUSAL ORDERING THIS FILE DEPENDS ON (read before touching retention
 * again): this bounded retention is only correct because terminal failures
 * are durably recorded FIRST. `attachSharedErrorListeners`
 * (`packages/queue-core/src/error-listeners.ts`, WRK-08) attaches the
 * dead-letter writer (`writeDeadLetterOnTerminalFailure`,
 * `dead_letter_jobs`) to every worker in `apps/worker/src/server.ts`'s
 * registry BEFORE 12-09 (this plan) shortened `STANDARD_JOB_RETENTION`'s
 * `removeOnFail` from `false` (keep forever) to an age bound. If the shared
 * error listener or the dead-letter writer is EVER removed from a queue,
 * this retention bound MUST be reverted to `false` for that queue FIRST --
 * not after -- or a terminal failure can age out of Redis's failed set
 * before it was ever durably recorded (Pitfall 7).
 */
describe("failed-job retention invariant (WRK-09)", () => {
  describe("the retention constants, at the value level", () => {
    it("STANDARD_JOB_RETENTION's failed-job retention is an age-bounded value, not an unbounded one", () => {
      expect(STANDARD_JOB_RETENTION.removeOnFail).not.toBe(false);
      expect(STANDARD_JOB_RETENTION.removeOnFail).toEqual({ age: FAILED_JOB_RETENTION_SECONDS });
      expect(typeof FAILED_JOB_RETENTION_SECONDS).toBe("number");
      expect(FAILED_JOB_RETENTION_SECONDS).toBeGreaterThan(0);
    });

    it("FLOW_RUN_ADVANCE_RETENTION's failed-job retention is already an age-bounded value", () => {
      expect(FLOW_RUN_ADVANCE_RETENTION.removeOnFail).not.toBe(false);
      expect(FLOW_RUN_ADVANCE_RETENTION.removeOnFail).toEqual({ age: 86_400 });
    });

    it("the differentiated policy survives: both retention fields differ between the two constants", () => {
      expect(STANDARD_JOB_RETENTION.removeOnComplete).not.toEqual(FLOW_RUN_ADVANCE_RETENTION.removeOnComplete);
      expect(STANDARD_JOB_RETENTION.removeOnFail).not.toEqual(FLOW_RUN_ADVANCE_RETENTION.removeOnFail);
    });
  });

  /**
   * The same guarded module set as `queue-core-single-definition.test.ts`
   * (WRK-11) -- every module in either process that constructs a BullMQ
   * `Queue` and therefore needs job options. Reusing this list (rather than
   * enumerating a new one) keeps the two invariants from silently diverging
   * about which modules are "every queue".
   */
  const GUARDED_MODULES = [
    "apps/worker/src/server.ts",
    "apps/worker/src/queues/campaign-broadcast-producer.ts",
    "apps/worker/src/queues/flows/flow-queues.ts",
    "apps/worker/src/queues/send-reconciler.worker.ts",
    "apps/worker/src/queues/campaign-scheduler.worker.ts",
    "apps/worker/src/queues/partition-maintenance.worker.ts",
    "apps/api/src/modules/campaigns/campaign-queues.ts",
    "apps/api/src/modules/contacts/imports-csv-queue.ts",
    "apps/api/src/modules/events/events-queue.ts",
    "apps/api/src/modules/webhooks/enqueue.ts",
    "apps/api/src/modules/flows/flow-queues.ts",
    "apps/worker/src/queues/flows/flow-segment-sweep.worker.ts",
  ] as const;

  const REPO_ROOT = path.resolve(import.meta.dirname, "../../../../..");

  const IMPORTS_BUILD_JOB_OPTIONS_PATTERN = /buildJobOptions/;
  const LOCAL_JOB_OPTION_LITERAL_PATTERN = /attempts\s*:\s*\d+/;

  describe.each(GUARDED_MODULES)("%s", (relativePath) => {
    const source = readFileSync(path.join(REPO_ROOT, relativePath), "utf8");

    it("builds its job options through the shared buildJobOptions factory, not a hand-rolled literal", () => {
      const usesBuildJobOptions = IMPORTS_BUILD_JOB_OPTIONS_PATTERN.test(source);
      const declaresLocalLiteral = LOCAL_JOB_OPTION_LITERAL_PATTERN.test(source);

      // apps/worker/src/server.ts only resolves connection options (it wires
      // up already-built Workers) -- it has no job-option literal of its own
      // to guard either way, so this assertion only binds modules that
      // declare a retry-attempt count somewhere in their source.
      if (declaresLocalLiteral) {
        expect(
          usesBuildJobOptions,
          `${relativePath} declares an "attempts: <number>" literal but does not call buildJobOptions -- the retention constants this suite just checked would not be the values this queue actually uses`
        ).toBe(true);
      }
    });
  });

  it("every guarded module that declares job options calls buildJobOptions with one of the two known retention constants", () => {
    const modulesWithJobOptions = GUARDED_MODULES.filter((relativePath) => {
      const source = readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
      return LOCAL_JOB_OPTION_LITERAL_PATTERN.test(source) === false && /buildJobOptions/.test(source);
    });

    // Every module in GUARDED_MODULES except server.ts (connection-options
    // only) declares job options -- this is the positive assertion that the
    // guarded set is not vacuously satisfied by modules with nothing to check.
    expect(modulesWithJobOptions.length).toBeGreaterThanOrEqual(GUARDED_MODULES.length - 1);

    for (const relativePath of modulesWithJobOptions) {
      const source = readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
      const referencesKnownRetention =
        /STANDARD_JOB_RETENTION/.test(source) || /FLOW_RUN_ADVANCE_RETENTION/.test(source);

      expect(
        referencesKnownRetention,
        `${relativePath} calls buildJobOptions but references neither STANDARD_JOB_RETENTION nor FLOW_RUN_ADVANCE_RETENTION`
      ).toBe(true);
    }
  });
});
