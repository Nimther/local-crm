import type { Job } from "bullmq";
import { scrub, scrubbedConsole } from "@mega-crm/redaction";

/**
 * Phase 12 (WRK-09/WRK-10, D-07). The terminal-failure gate and the
 * redacting insert into `dead_letter_jobs` (migration 0054).
 *
 * Relocated here from `apps/worker/src/queues/dead-letter/dead-letter-writer.ts`
 * during plan 12-10 (deviation, Rule 3 -- blocking): 12-10's own dead-letter
 * watchdog test module lives in `apps/api` and needs to drive a real
 * terminal-job failure through this exact write path for its end-to-end
 * case, but `apps/api/tsconfig.json`'s `rootDir: "src"` makes a direct
 * relative import from `apps/worker/src/...` a hard `tsc` error (TS6059 --
 * proven empirically before this change) regardless of any app-level
 * dependency. `packages/queue-core` is already a dependency of BOTH
 * `apps/worker` and `apps/api`, and already hosts this exact writer's
 * composition partner (`error-listeners.ts`'s `attachSharedErrorListeners`,
 * whose own header comment states the import-direction rule this move
 * upholds: "packages/queue-core must never import from an app" -- moving
 * app-owned logic INTO a package apps already depend on is the sanctioned
 * direction, not a violation of it).
 *
 * `apps/worker/src/queues/dead-letter/dead-letter-writer.ts` remains the
 * canonical entry point for the worker process -- it re-exports
 * `isTerminalJobFailure` and wraps `writeDeadLetterOnTerminalFailure` with
 * its own dedicated pool default, so no import site in `apps/worker`
 * (including its own existing test) needed to change.
 */

export interface DeadLetterWriterClient {
  query<T = Record<string, unknown>>(queryText: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/**
 * A failure event raised while retries remain is NOT terminal and must not
 * be recorded, or the table would fill with rows for jobs that later
 * succeed. A job with no configured `attempts` (BullMQ's own default of 1)
 * is terminal on its very first failure.
 */
export function isTerminalJobFailure(job: Job): boolean {
  const maxAttempts = job.opts?.attempts ?? 1;
  return job.attemptsMade >= maxAttempts;
}

/**
 * Writes exactly one row per (queue, job id) on terminal failure -- a
 * redelivered terminal failure for the SAME job id (BullMQ's job-id-scoped
 * dedup does not prevent every redelivery from reaching this call site)
 * refreshes the existing row's attempts/payload/error/timestamp via the
 * unique-constraint conflict clause rather than duplicating it.
 *
 * The payload snapshot is ALWAYS passed through the redaction package's
 * `scrub` before serialising it -- this is the control that keeps personal
 * data and provider credentials out of the durable record (T-12-07-01).
 *
 * Wrapped so a database error is logged through the scrubbed console and
 * swallowed rather than rethrown: this function is called from a worker
 * event listener, and an escaping rejection there is an unhandled rejection
 * that terminates the whole worker process (T-12-07-02).
 *
 * Takes the client as a required, structural parameter (no module-level
 * default `Pool` here) -- keeping this package free of a live `pg`
 * connection at import time is what lets `apps/api`'s watchdog test import
 * this function directly without also opening (or needing to mock) a
 * dedicated worker-side connection pool.
 */
export async function writeDeadLetterOnTerminalFailure(
  job: Job,
  err: Error,
  queueName: string,
  client: DeadLetterWriterClient,
): Promise<void> {
  if (!isTerminalJobFailure(job)) {
    return;
  }

  try {
    const redactedPayload = scrub(job.data);
    await client.query(
      `INSERT INTO dead_letter_jobs (
         queue_name, job_id, job_name, attempts_made, payload, error_message, error_stack, failed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (queue_name, job_id) DO UPDATE SET
         attempts_made = EXCLUDED.attempts_made,
         payload = EXCLUDED.payload,
         error_message = EXCLUDED.error_message,
         error_stack = EXCLUDED.error_stack,
         failed_at = EXCLUDED.failed_at`,
      [
        queueName,
        String(job.id ?? ""),
        job.name,
        job.attemptsMade,
        JSON.stringify(redactedPayload),
        err.message,
        err.stack ?? null,
      ],
    );
  } catch (writeErr) {
    scrubbedConsole.error("dead-letter-writer: failed to write dead-letter row", writeErr);
  }
}
