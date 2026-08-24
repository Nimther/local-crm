import type { Pool, PoolClient } from "pg";

/**
 * Gap-closure plan 22-12 (PRG-02): closes verification gap 1 --
 * `dead_letter_jobs.payload` could hold raw contact PII from any
 * terminally-failed job (migration 0054, `packages/queue-core/src/dead-letter-writer.ts`),
 * the table was outside every purge list, and there was no delete against it
 * anywhere in the repository except a test teardown. Rows accumulated
 * forever for EVERY workspace, live or purged.
 *
 * The recorded decision is option (b): a retention timer on the table's own
 * `failed_at` column, boot-validated (`apps/worker/src/env.ts`'s
 * `DEAD_LETTER_RETENTION_DAYS`, at most `WORKSPACE_PURGE_RETENTION_DAYS`) to
 * always expire before a soft-deleted workspace's own purge becomes
 * eligible -- NOT a `workspace_id` backfill column (option (a), declined:
 * structurally incomplete for payloads without a `workspaceId` key, and
 * contradicts migration 0054's own deliberate platform-scoped, no-RLS
 * design). See `.planning/phases/22-workspace-quiesce-physical-purge/22-12-PLAN.md`
 * for the full rationale.
 */

type DeadLetterRetentionClient = Pool | PoolClient;

/**
 * Matches `PURGE_BATCH_SIZE`'s own discipline (`packages/db/src/workspace-purge-tables.ts`)
 * -- one bounded DELETE per statement, never an unbounded single-statement
 * sweep against a table that (unlike the tenant-scoped purge tables) has no
 * per-workspace boundary to page by.
 */
export const DEAD_LETTER_SWEEP_BATCH_SIZE = 500;

/**
 * Deletes every `dead_letter_jobs` row whose `failed_at` is older than
 * `cutoff`, in bounded batches, looping until a batch deletes zero rows.
 * Returns the total number of rows deleted.
 *
 * The batch selector is the PRIMARY KEY (`id`), never `ctid` -- this table
 * is not partitioned, but `id` sidesteps the entire `ctid`-uniqueness class
 * this phase's own review already flagged on `events`/`send_events`, and
 * keeps each statement bounded rather than an unbounded destructive sweep.
 *
 * `cutoff` is passed as a JavaScript `Date` bound directly to `$1`, so `pg`
 * sends it as a `timestamptz` -- deliberately no `::timestamp` cast on the
 * placeholder. This phase's own verification report already flagged a bare
 * `::timestamp` cast elsewhere in the purge code as a session-`TimeZone`-
 * dependent defect class; this statement does not reintroduce it.
 *
 * Each batch is its own standalone statement -- never a transaction spanning
 * multiple batches -- mirroring the purge walk's own one-commit-per-batch
 * shape (`walkPurgeTable`, `workspace-purge.worker.ts`). This makes the
 * sweep interruption-safe by construction: a kill mid-sweep leaves already-
 * committed batches deleted and the rest for the next tick, and two
 * overlapping ticks are safe because the second `SELECT id ... LIMIT`
 * simply returns fewer rows.
 *
 * Touches `dead_letter_jobs` only -- never `dead_letter_alert_state`, the
 * watchdog's own singleton alert-dedup row (migration 0054).
 */
export async function sweepExpiredDeadLetterJobs(
  client: DeadLetterRetentionClient,
  cutoff: Date,
  batchSize: number = DEAD_LETTER_SWEEP_BATCH_SIZE,
): Promise<number> {
  let total = 0;
  for (;;) {
    const result = await client.query(
      `DELETE FROM dead_letter_jobs
        WHERE id IN (
          SELECT id FROM dead_letter_jobs
           WHERE failed_at < $1
           LIMIT $2
        )`,
      [cutoff, batchSize],
    );
    const deletedInBatch = result.rowCount ?? 0;
    total += deletedInBatch;
    if (deletedInBatch === 0) break;
  }
  return total;
}
