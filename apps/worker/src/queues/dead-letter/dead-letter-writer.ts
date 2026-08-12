import type { Job } from "bullmq";
import { createPgPool } from "@mega-crm/db/src/pool.js";
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
// Phase 14 plan 03 (DB-14, D-11): built through the shared createPgPool
// factory, named "worker-dead-letter" in PG_POOL_SIZES -- the error handler
// this comment used to wire by hand now lives in the factory,
// unconditionally, for every pool in the codebase.
const deadLetterPool = createPgPool({
  connectionString: process.env.DATABASE_URL ?? "",
  name: "worker-dead-letter",
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
