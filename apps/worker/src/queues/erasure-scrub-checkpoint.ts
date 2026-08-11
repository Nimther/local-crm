import type { PoolClient } from "pg";

/**
 * Phase 13 (CMP-04, D-01/D-04, plan 13-13): transaction-scoped read/write for
 * the erasure scrub's per-table resume cursor, stored on the
 * `erasure_records` row itself (`sends_scrub_cursor`/`events_scrub_cursor`,
 * migration 0059). Mirrors `flow-segment-sweep-checkpoint.ts`'s shape
 * exactly -- every function here takes a `PoolClient` as its first argument
 * and never opens its own connection, so a caller can commit a checkpoint
 * advance on the SAME transaction as that page's JSONB UPDATE. This is the
 * Phase 12 D-09 rule, not a style preference: a checkpoint committed in a
 * SEPARATE transaction lets a kill between the two either re-scrub a page
 * (harmless -- the scrub is idempotent by construction) or silently skip one
 * (a permanent PII leak with no signal). Only the same-transaction form
 * makes the second outcome impossible.
 *
 * ONLY its STORAGE differs from `flow-segment-sweep-checkpoint.ts`
 * (REVIEWS.md MEDIUM finding, resolved during the cross-AI review pass): the
 * Phase 12 checkpoint table (`flow_segment_sweep_checkpoint`, migration
 * 0053) is keyed `(workspace_id, flow_id)` with `flow_id uuid NOT NULL
 * REFERENCES flows(id) ON DELETE CASCADE`, so an erasure-record id fails
 * that foreign key outright -- it is not a question of the table being
 * "generic enough". Plan 13-10's migration 0059 instead adds two `jsonb`
 * columns directly on `erasure_records`, one per table this scrub walks.
 *
 * Every call site is expected to already be inside `withTenant`/
 * `withTenantTransaction` -- these functions issue plain, RLS-scoped SQL
 * against `erasure_records`, which carries the SAME fail-closed
 * `workspace_isolation` policy every other tenant-scoped table in this
 * codebase does (migration 0059's own header comment).
 */

/** Which of the scrub's two target tables a cursor/count belongs to. */
export type ScrubTable = "sends" | "events";

/**
 * A cursor mid-walk: the keyset position of the LAST row a committed page
 * rewrote. The keyset is composite -- `occurredAt` (an ISO string) plus
 * `id` -- because both `send_events` and `events` are partitioned by range
 * on their timestamp column, and a single uuid cannot express a resume
 * position on a partitioned table (a plain `ORDER BY id` has no stable
 * meaning across partitions). Storing the two components under explicit
 * names (not a positional array/tuple) means a later change to the
 * ordering columns is a visible schema-shaped change to this type, not a
 * silent misinterpretation of an already-stored row.
 */
export interface ScrubCursorInProgress {
  done: false;
  occurredAt: string;
  id: string;
}

/**
 * The walk over this table has reached the end of this contact's matching
 * rows -- a page returned zero rows. Deliberately NOT `null`: `null` means
 * "this table's walk has not started yet", and a completed walk must be
 * DISTINGUISHABLE from that so a resumed job can tell "nothing to do, I'm
 * done" apart from "nothing has run yet, start from the beginning". Unlike
 * `flow-segment-sweep-checkpoint.ts`'s PERPETUAL sweep (which resets its
 * cursor to `null` so a later-arriving row is never permanently skipped),
 * this walk is ONE-SHOT per erasure -- a contact's already-anonymized rows
 * do not grow new PII after the erasure request, so there is no future pass
 * to protect against, and "done" persisting forever is exactly correct
 * (T-13-13-CMP-04: a replayed job after completion must be a no-op).
 */
export interface ScrubCursorDone {
  done: true;
}

export type ScrubCursor = ScrubCursorInProgress | ScrubCursorDone;

function cursorColumnFor(table: ScrubTable): "sends_scrub_cursor" | "events_scrub_cursor" {
  return table === "sends" ? "sends_scrub_cursor" : "events_scrub_cursor";
}

function countColumnFor(table: ScrubTable): "sends_scrubbed" | "events_scrubbed" {
  return table === "sends" ? "sends_scrubbed" : "events_scrubbed";
}

/**
 * Returns the erasure record's stored cursor for `table`, or `null` when the
 * walk over that table has not started yet (a fresh erasure record, or one
 * whose OTHER table's walk has started but this one has not). Column name is
 * selected from a two-member literal-union whitelist (`cursorColumnFor`),
 * never interpolated from external input, so there is no SQL-injection
 * surface despite the column name being part of the query string.
 */
export async function loadErasureScrubCheckpoint(
  client: PoolClient,
  workspaceId: string,
  erasureRecordId: string,
  table: ScrubTable
): Promise<ScrubCursor | null> {
  const column = cursorColumnFor(table);
  const { rows } = await client.query<{ cursor: ScrubCursor | null }>(
    `SELECT ${column} as cursor FROM erasure_records WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, erasureRecordId]
  );
  return rows[0]?.cursor ?? null;
}

/**
 * Advances BOTH the cursor and the running row count for `table` in a
 * SINGLE statement -- the count increment is not a separate call, because
 * the two must commit together with exactly the same atomicity guarantee
 * the cursor itself needs (D-09): a resumed walk's TOTAL count must equal
 * the number of rows actually rewritten across every pass, never merely the
 * last pass's own count, and folding the increment into this same UPDATE is
 * what makes that automatic rather than a second thing a caller could
 * forget to keep in sync with the cursor write.
 *
 * `processedInPage` is 0 on the terminal call that writes `{ done: true }`
 * (a page that found no more rows performed no work), and equal to that
 * page's row count on every prior call.
 */
export async function advanceErasureScrubCheckpoint(
  client: PoolClient,
  workspaceId: string,
  erasureRecordId: string,
  table: ScrubTable,
  cursor: ScrubCursor,
  processedInPage: number
): Promise<void> {
  const cursorColumn = cursorColumnFor(table);
  const countColumn = countColumnFor(table);
  await client.query(
    `UPDATE erasure_records
     SET ${cursorColumn} = $3::jsonb, ${countColumn} = ${countColumn} + $4
     WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, erasureRecordId, JSON.stringify(cursor), processedInPage]
  );
}
