import type { Job } from "bullmq";
import { Pool } from "pg";
import { scrubbedConsole } from "@mega-crm/redaction";
import {
  isTerminalJobFailure,
  writeDeadLetterOnTerminalFailure as writeDeadLetterOnTerminalFailureShared,
  type DeadLetterWriterClient,
} from "@mega-crm/queue-core";

/**
 * Phase 12 (WRK-09/WRK-10, D-07): the terminal-failure gate and the
 * redacting insert into `dead_letter_jobs` (migration 0054). Wired into
 * `attachSharedErrorListeners`'s (`packages/queue-core/src/error-listeners.ts`,
 * WRK-08, this same plan) `worker.on("failed", ...)` callback via an
 * injected `onTerminalFailure` hook.
 *
 * The actual gate/insert logic now lives in
 * `packages/queue-core/src/dead-letter-writer.ts` (relocated during plan
 * 12-10, deviation Rule 3 -- blocking: see that module's own header comment
 * for the full reasoning). This file is now a thin `apps/worker`-local shim
 * that re-exports the shared `isTerminalJobFailure` unchanged and wraps the
 * shared write function with this app's own dedicated connection pool as
 * the default client -- every existing import site in `apps/worker`
 * (`server.ts`, this module's own test) keeps working unchanged.
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

export type { DeadLetterWriterClient };
export { isTerminalJobFailure };

export interface WriteDeadLetterDeps {
  pool?: DeadLetterWriterClient;
}

export async function writeDeadLetterOnTerminalFailure(
  job: Job,
  err: Error,
  queueName: string,
  deps: WriteDeadLetterDeps = {},
): Promise<void> {
  const client = deps.pool ?? deadLetterPool;
  await writeDeadLetterOnTerminalFailureShared(job, err, queueName, client);
}
