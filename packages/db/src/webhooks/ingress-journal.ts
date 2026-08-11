import type { PoolClient } from "pg";

/**
 * Phase 13 (CMP-08, D-05, plan 13-01): transaction-scoped read/write helpers
 * for `ingress_journal` (migration 0055) -- the durable pre-enqueue record of
 * a verified SendGrid webhook batch.
 *
 * This placement is the phase-wide decision recorded in 13-01-PLAN.md's
 * "Cross-app shared-module placement" section, not a choice left to
 * execution: `apps/worker` cannot import `@mega-crm/api` in production code
 * (its own devDependency-only constraint), and `apps/api`'s
 * `webhooks.routes.ts` needs the SAME write path the worker's
 * `markIngestionComplete` call needs to read/close. `packages/db` is where
 * every other `PoolClient`-first helper module BOTH apps consume already
 * lives (`packages/db/src/reconciler/reconciler-run.ts`,
 * `packages/db/src/partitions/maintenance-run.ts`), imported as
 * `@mega-crm/db/src/<domain>/<module>.js`.
 *
 * Every function here takes a `PoolClient` as its first argument and never
 * opens its own connection -- every call site is expected to ALREADY be
 * inside `withTenant`/`withTenantTransaction` (or, for the scan-role reads
 * added in a later task of this same plan, `withCrossWorkspaceScan`). A
 * query against `ingress_journal` from a connection with no tenant scope set
 * raises rather than returning zero rows, by construction of the
 * fail-closed `workspace_isolation` policy migration 0055 carries -- not
 * anything this file does itself.
 */

/**
 * Writes the verified batch's raw events array as one `ingress_journal` row
 * and returns its id. Called from `webhooks.routes.ts` strictly AFTER
 * `verifyWebhookSignature`/`isWebhookTimestampFresh` both pass and the raw
 * body has been `JSON.parse`d -- an unverified payload must never reach this
 * function (T-13-01-01).
 *
 * `rawBatch` is passed through `JSON.stringify` before binding: node-postgres
 * serializes a bare JS array parameter as a Postgres ARRAY literal, not a
 * JSON value, which would fail against a `jsonb` column with a malformed
 * literal error -- there is no existing call site in this codebase that
 * binds an array directly to a `jsonb` column to copy from, so this is
 * spelled out explicitly rather than left implicit.
 */
export async function writeIngressJournal(
  client: PoolClient,
  workspaceId: string,
  rawBatch: unknown[]
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO ingress_journal (workspace_id, raw_batch) VALUES ($1, $2) RETURNING id`,
    [workspaceId, JSON.stringify(rawBatch)]
  );
  return rows[0].id;
}

/**
 * Marks a journaled batch's ingestion complete. Called from
 * `processWebhookEventBatch` on EVERY terminal-success path, including the
 * two zero-row early returns (a sibling-only batch, a batch with no
 * extractable events) -- a journaled batch that reached a terminal outcome
 * is marked ingested, including when the correct outcome was to insert
 * nothing (T-13-01-08). Never called for a legacy payload with no
 * `journalId` at all.
 */
export async function markIngestionComplete(client: PoolClient, journalId: string): Promise<void> {
  await client.query(`UPDATE ingress_journal SET ingestion_completed_at = now() WHERE id = $1`, [journalId]);
}

/**
 * Phase 13 (CMP-08, D-05, plan 13-01, Task 3): retention constants, in the
 * Phase 9 house style (`analytics-reconciliation.worker.ts`'s versioned
 * constant + rationale comment) -- both are read by plan 13-06's retention
 * tick, not by anything in this plan.
 *
 * `INGRESS_JOURNAL_RETENTION_DAYS = 7`: strictly outlives SendGrid's ~24h
 * webhook retry window and the Phase 11 reconciler's own 24h resolution /
 * 72h re-scan horizons, while keeping the persisted-PII surface small per
 * D-07. The CMP-04 erasure scrub deliberately does NOT reach into this
 * table -- this horizon expires faster than an erasure request's own SLA,
 * so a row carrying an erasure-requested contact's data is gone from here
 * on its own before CMP-04 would ever need to touch it.
 */
export const INGRESS_JOURNAL_RETENTION_DAYS = 7;

/**
 * `INGRESS_JOURNAL_STUCK_THRESHOLD_MINUTES = 15`: an order of magnitude
 * above normal queue latency, so a row `findStuckIngressJournalRows`
 * returns means real ingestion loss, not ordinary backlog.
 */
export const INGRESS_JOURNAL_STUCK_THRESHOLD_MINUTES = 15;

export interface StuckIngressJournalRow {
  id: string;
  workspaceId: string;
  receivedAt: Date;
  replayCount: number;
  payloadPurgedAt: Date | null;
}

interface RawStuckIngressJournalRow {
  id: string;
  workspace_id: string;
  received_at: Date;
  replay_count: number;
  payload_purged_at: Date | null;
}

/**
 * Returns incomplete (`ingestion_completed_at IS NULL`) rows older than
 * `olderThanMinutes`, oldest first, bounded by `limit` so a sweep stays
 * bounded. Written to the same structural query shape
 * `dead-letter-watchdog.ts`'s `readDeadLetterHealth` uses, so plan 13-11's
 * ingestion-health watchdog can consume it unchanged -- called either
 * inside a tenant transaction (a single workspace's own incomplete rows)
 * or, for the platform-wide health question, via `withCrossWorkspaceScan`.
 *
 * Deliberately does NOT filter on `replay_count` or `payload_purged_at` --
 * this is a decision this function makes, not an open question left for a
 * caller to close. Plan 13-06's replay sweep applies the attempt cap
 * itself and skips purged rows itself when choosing what to re-enqueue;
 * plan 13-11's watchdog needs attempt-capped rows AND purged tombstones to
 * stay visible so it can report each as its own number. A cap that hides
 * its own casualties from the read the watchdog uses converts an infinite
 * retry into a silent drop, which is strictly worse than the loop it
 * replaced -- and a purge that hides its own tombstones does the same
 * thing to a confirmed data loss. Returning both `replayCount` and
 * `payloadPurgedAt` on every row is what lets both consumers make their
 * own decision from this one query -- do not narrow this predicate later
 * without re-reading this comment.
 */
export async function findStuckIngressJournalRows(
  client: PoolClient,
  olderThanMinutes: number,
  limit: number
): Promise<StuckIngressJournalRow[]> {
  const { rows } = await client.query<RawStuckIngressJournalRow>(
    `SELECT id, workspace_id, received_at, replay_count, payload_purged_at
       FROM ingress_journal
      WHERE ingestion_completed_at IS NULL
        AND received_at < now() - make_interval(mins => $1)
      ORDER BY received_at ASC
      LIMIT $2`,
    [olderThanMinutes, limit]
  );
  return rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    receivedAt: row.received_at,
    replayCount: row.replay_count,
    payloadPurgedAt: row.payload_purged_at,
  }));
}

/**
 * Deletes COMPLETED rows (`ingestion_completed_at IS NOT NULL`) older than
 * `retentionDays`, returning the deleted count. This is the whole change
 * from a single unconditional retention delete: a batch that was
 * successfully ingested has nothing left to prove, so deleting it outright
 * disposes of its payload and its (uninteresting) history in one step.
 *
 * Deliberately does NOT touch an incomplete row, however old --
 * `purgeExpiredIngressJournalPayloads` below is the only function that
 * disposes of an incomplete row's payload, and it never deletes the row
 * itself. A row that reached the retention horizon without ever being
 * ingested is the record of an ingestion loss the platform never
 * recovered from; deleting it here would dispose of that evidence along
 * with the PII, and after it is gone nothing in the system knows a batch
 * was ever lost -- plan 13-11's watchdog would stop alerting not because
 * the problem was fixed but because the last trace of it aged out. Do not
 * merge this back into one unconditional DELETE.
 */
export async function pruneIngressJournal(client: PoolClient, retentionDays: number): Promise<number> {
  const result = await client.query(
    `DELETE FROM ingress_journal
      WHERE received_at < now() - make_interval(days => $1)
        AND ingestion_completed_at IS NOT NULL`,
    [retentionDays]
  );
  return result.rowCount ?? 0;
}

/**
 * Nulls `raw_batch` and sets `payload_purged_at` on an INCOMPLETE row older
 * than `retentionDays`, leaving the row itself present -- the PII-disposal
 * half of retention, kept deliberately separate from `pruneIngressJournal`
 * (which only ever deletes completed rows). The row that results is a
 * tombstone: `raw_batch IS NULL`, `payload_purged_at IS NOT NULL`, no
 * recipient PII anywhere else on the row, and it is retained indefinitely
 * by this phase (see this module's own retention note below) so an
 * unrecovered ingestion loss stays visible to the operator.
 *
 * The trailing `payload_purged_at IS NULL` predicate is what makes this
 * function idempotent: a second call over an already-purged row matches
 * zero rows and returns `0`, never re-stamping `payload_purged_at` with a
 * later time than the batch's actual purge.
 *
 * Retention consequence, stated plainly rather than left implicit:
 * tombstone rows are retained indefinitely by this phase. They are small
 * and non-PII (`raw_batch` null, no recipient data in any other column),
 * and their volume tracks the ingestion-failure rate rather than traffic,
 * so unbounded growth is not a practical concern at this phase's scale --
 * but it IS an accepted trade (threat T-13-01-10, disposition: accept),
 * not an oversight. A later phase adding an operator acknowledge-and-delete
 * path is the right place to close it, not an unconditional delete here
 * that would reinstate T-13-01-09.
 */
export async function purgeExpiredIngressJournalPayloads(client: PoolClient, retentionDays: number): Promise<number> {
  const result = await client.query(
    `UPDATE ingress_journal
        SET raw_batch = NULL, payload_purged_at = now()
      WHERE received_at < now() - make_interval(days => $1)
        AND ingestion_completed_at IS NULL
        AND payload_purged_at IS NULL`,
    [retentionDays]
  );
  return result.rowCount ?? 0;
}
