import type { Job } from "bullmq";
import { Pool } from "pg";
import { scrub, scrubbedConsole } from "@mega-crm/redaction";

/**
 * Phase 12 (WRK-09/WRK-10, D-07): the terminal-failure gate and the
 * redacting insert into `dead_letter_jobs` (migration 0054). Wired into
 * `attachSharedErrorListeners`'s (`packages/queue-core/src/error-listeners.ts`,
 * WRK-08, this same plan) `worker.on("failed", ...)` callback via an
 * injected `onTerminalFailure` hook -- queue-core never imports from an app,
 * so this module stays entirely inside `apps/worker`.
 *
 * For send jobs the `sends` ledger (Phase 11) remains the terminal truth;
 * this table's chief value is the lanes without a ledger -- ingest,
 * webhooks, CSV import and flow ticks -- where a silently aged-out job is
 * lost data (12-CONTEXT.md D-07).
 */

/**
 * Dedicated pool for this writer's DB path, mirroring
 * `partition-maintenance.worker.ts`'s own dedicated pool (09-REVIEW CR-03):
 * platform-scoped write, entirely separate from `@mega-crm/tenant-context`'s
 * shared, tenant-scoped pool -- `dead_letter_jobs` has no `workspace_id`
 * column to scope by, and this writer is called from a plain worker event
 * listener, never from inside `withTenant`/`withTenantTransaction`.
 */
const deadLetterPool = new Pool({ connectionString: process.env.DATABASE_URL });

// Mirrors every other dedicated pool in this codebase (partition-maintenance's,
// @mega-crm/tenant-context's, @mega-crm/db's): without this listener, an idle-
// connection termination surfaces as an uncaught 'error' event and crashes the
// whole apps/worker process.
deadLetterPool.on("error", (err) => {
  scrubbedConsole.error("dead-letter-writer: idle pg pool client error (connection dropped)", err);
});

export interface DeadLetterWriterClient {
  query<T = Record<string, unknown>>(queryText: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface WriteDeadLetterDeps {
  pool?: DeadLetterWriterClient;
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
 */
export async function writeDeadLetterOnTerminalFailure(
  job: Job,
  err: Error,
  queueName: string,
  deps: WriteDeadLetterDeps = {},
): Promise<void> {
  if (!isTerminalJobFailure(job)) {
    return;
  }

  const client = deps.pool ?? deadLetterPool;

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
