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
