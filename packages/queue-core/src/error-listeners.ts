import type { Job, Worker } from "bullmq";
import { scrubbedConsole } from "@mega-crm/redaction";

/**
 * Phase 12 (WRK-08/WRK-10, D-10): the ONE shared worker error/failed
 * listener attach helper. Before this file, there was no `worker.on("error")`
 * / `worker.on("failed")` listener anywhere in `apps/worker` -- an
 * unattended `error` event, or a rejecting callback inside a `failed`
 * listener, is an unhandled rejection that under this project's Node
 * configuration terminates the WHOLE `apps/worker` process and every one of
 * its registered workers, not just the one that emitted it (a failure mode
 * this repository has already been bitten by once, see
 * `partition-maintenance.worker.ts`'s CR-04 comment for the sibling fix at
 * the scheduler-registration call site).
 *
 * The terminal-versus-mid-retry decision deliberately stays OUTSIDE this
 * helper, in the injected `onTerminalFailure` hook: `packages/queue-core`
 * must never import from an app (`apps/worker/src/queues/dead-letter/
 * dead-letter-writer.ts` supplies the real hook), so this file's own tier
 * boundary is enforced by construction, not by convention.
 */

export interface ErrorListenerDeps {
  /**
   * Invoked once per `failed` event, regardless of whether the job that
   * failed was terminal or mid-retry -- the CALLER's hook (the dead-letter
   * writer) is what decides that via `isTerminalJobFailure`, not this
   * helper. A rejecting hook is caught and logged here; it never escapes to
   * become an unhandled rejection.
   */
  onTerminalFailure?: (job: Job | undefined, err: Error, queueName: string) => Promise<void> | void;
}

/**
 * Guards against double-registering both listeners on the same `Worker` --
 * calling this helper twice for the same worker (e.g. a future refactor that
 * calls it from two code paths) must not leave two error listeners logging
 * the same event twice.
 */
const attachedWorkers = new WeakSet<object>();

export function attachSharedErrorListeners(worker: Worker, queueName: string, deps: ErrorListenerDeps = {}): void {
  if (attachedWorkers.has(worker)) {
    return;
  }
  attachedWorkers.add(worker);

  worker.on("error", (err: Error) => {
    scrubbedConsole.error(`${queueName}: worker error`, err);
  });

  worker.on("failed", (job: Job | undefined, err: Error) => {
    scrubbedConsole.error(`${queueName}: job failed`, { jobId: job?.id, err: err.message });

    if (!deps.onTerminalFailure) {
      return;
    }

    void Promise.resolve()
      .then(() => deps.onTerminalFailure?.(job, err, queueName))
      .catch((hookErr: unknown) => {
        scrubbedConsole.error(`${queueName}: onTerminalFailure hook rejected`, hookErr);
      });
  });
}
