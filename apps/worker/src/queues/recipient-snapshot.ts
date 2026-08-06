import type { PoolClient } from "pg";
import { compileSegmentDefinition, type SegmentDefinition } from "@mega-crm/segments-core";
import { getWorkspaceId, withTenantTransaction } from "@mega-crm/tenant-context";

/**
 * RESEARCH.md Pattern 1: a background materialization job has more time
 * budget than the segments engine's own interactive 15s save-eval timeout,
 * but must still be bounded -- a scoped `statement_timeout` per batch is
 * the same escape-hatch discipline, applied to a much larger (background)
 * job.
 */
export const SNAPSHOT_BATCH_SIZE = 10_000;
export const SNAPSHOT_STATEMENT_TIMEOUT_MS = 60_000;

export interface MaterializeBatchResult {
  /** Rows actually inserted this batch (RETURNING count -- excludes ON CONFLICT DO NOTHING skips). */
  inserted: number;
  /** The last contact id considered this batch (SELECTed, not just inserted) -- the next resume cursor. */
  lastContactId: string | null;
}

/**
 * One page of the recipient snapshot's batched `INSERT...SELECT` (D-02,
 * RESEARCH.md Pattern 1): reuses `compileSegmentDefinition` (the SAME
 * engine segment preview/save use, SEGM-03's single-engine guarantee) to
 * compile the segment's WHERE fragment, then keyset-paginates on
 * `contacts.id` (`c.id > $cursor ORDER BY c.id ASC LIMIT`) -- NEVER
 * skip-ahead pagination, which degrades to O(n^2) at 100k-1M-contact scale (Pitfall 3).
 * `ON CONFLICT (campaign_id, contact_id) DO NOTHING` is the idempotency
 * backstop for a redelivered kickoff job resuming from the SAME persisted
 * cursor. The batch's `statement_timeout` is scoped via `SET LOCAL` (via
 * `set_config(..., true)`) so a pathological segment definition can never
 * hold this transaction open indefinitely (T-04-06-02).
 *
 * The persisted `campaigns.snapshot_cursor` is written in the SAME
 * transaction as the batch's INSERT, so a batch commit and its cursor
 * advance are atomic -- a crash between them is impossible, which is what
 * makes the outer loop's "stop when a batch inserts 0 rows" termination
 * condition safe (a batch can never be silently re-fetched after its
 * cursor already advanced past it).
 */
export async function materializeBatch(
  client: PoolClient,
  campaignId: string,
  workspaceId: string,
  def: SegmentDefinition,
  afterContactId: string | null
): Promise<MaterializeBatchResult> {
  await client.query(`SELECT set_config('statement_timeout', $1, true)`, [String(SNAPSHOT_STATEMENT_TIMEOUT_MS)]);

  const { whereSql, params } = compileSegmentDefinition(def, workspaceId);
  const cursorClause = afterContactId ? `AND c.id > $${params.length + 1}` : "";
  const cursorParams = afterContactId ? [...params, afterContactId, SNAPSHOT_BATCH_SIZE] : [...params, SNAPSHOT_BATCH_SIZE];
  const limitIdx = cursorParams.length;

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO campaign_recipients (campaign_id, workspace_id, contact_id)
     SELECT $${limitIdx + 1}, c.workspace_id, c.id
     FROM contacts c
     WHERE ${whereSql} ${cursorClause}
     ORDER BY c.id ASC
     LIMIT $${limitIdx}
     ON CONFLICT (campaign_id, contact_id) DO NOTHING
     RETURNING contact_id as id`,
    [...cursorParams, campaignId]
  );

  const lastContactId = rows.at(-1)?.id ?? afterContactId;

  await client.query(`UPDATE campaigns SET snapshot_cursor = $2, updated_at = now() WHERE id = $1`, [
    campaignId,
    lastContactId,
  ]);

  return { inserted: rows.length, lastContactId };
}

interface SnapshotStateRow {
  definition: SegmentDefinition;
  cursor: string | null;
}

/** Reads the campaign's segment definition + persisted resume cursor in one round-trip. */
async function loadSnapshotState(client: PoolClient, campaignId: string): Promise<SnapshotStateRow> {
  const { rows } = await client.query<SnapshotStateRow>(
    `SELECT s.definition as definition, c.snapshot_cursor as cursor
     FROM campaigns c
     JOIN segments s ON s.id = c.segment_id
     WHERE c.id = $1`,
    [campaignId]
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`materializeCampaignSnapshot: campaign ${campaignId} (or its segment) not found`);
  }
  return row;
}

/**
 * D-02: freezes a campaign's segment membership into `campaign_recipients`
 * at send-start time -- contacts joining the segment mid-send are NOT
 * added, so the campaign's progress denominator stays stable for the
 * entire send. Loops `materializeBatch` on the `contacts.id` keyset cursor
 * until a batch inserts 0 rows.
 *
 * Resumable (T-04-06-03): a redelivered kickoff job re-enters this function,
 * re-reads the persisted `snapshot_cursor`, and continues from there --
 * already-snapshotted contacts are excluded by the `c.id > $cursor` filter
 * itself (never re-fetched), with `ON CONFLICT DO NOTHING` as a second,
 * defense-in-depth idempotency layer.
 *
 * Requires an ambient tenant context already established by the caller
 * (`campaign-kickoff.worker.ts`'s `withTenant(workspaceId, ...)`) --
 * `workspaceId` is read via `getWorkspaceId()`, never passed in, matching
 * this codebase's re-derive-from-context convention for worker jobs.
 */
export async function materializeCampaignSnapshot(campaignId: string): Promise<void> {
  const workspaceId = getWorkspaceId();

  const initial = await withTenantTransaction((client) => loadSnapshotState(client, campaignId));
  const { definition } = initial;
  let cursor = initial.cursor;

  while (true) {
    const { inserted, lastContactId } = await withTenantTransaction((client) =>
      materializeBatch(client, campaignId, workspaceId, definition, cursor)
    );
    if (inserted === 0) break;
    cursor = lastContactId;
  }
}
