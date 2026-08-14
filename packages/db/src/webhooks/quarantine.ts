import type { PoolClient } from "pg";
import { scrubbedConsole } from "@mega-crm/redaction";

/**
 * Phase 13 (CMP-08, D-05, plan 13-01, Task 2): the insert-only writer for
 * `send_event_quarantine` (migration 0055). Lives in `packages/db` rather
 * than `apps/api` because plan 13-04's caller is in `apps/worker`, which
 * cannot import `@mega-crm/api` in production code -- the phase-wide
 * placement decision recorded in 13-01-PLAN.md's "Cross-app shared-module
 * placement" section.
 *
 * Mirrors `packages/queue-core/src/dead-letter-writer.ts` exactly:
 * insert-only, no read-back, and swallow-and-log its own failure through
 * `scrubbedConsole` (`@mega-crm/redaction`) so a quarantine failure can
 * never propagate into the caller's own batch processing. No caller is
 * wired in this plan -- plan 13-04 owns the bounding logic that decides
 * which events route here.
 *
 * Every call site is expected to already be inside `withTenant`/
 * `withTenantTransaction` -- `send_event_quarantine` carries the same
 * fail-closed `workspace_isolation` policy every other tenant-scoped table
 * in this codebase does.
 */

/**
 * Phase 13 (CMP-04, D-07, gap-closure plan 13-16, Task 1): the retention
 * horizon for `send_event_quarantine`, in the same versioned-constant house
 * style `ingress-journal.ts`'s `INGRESS_JOURNAL_RETENTION_DAYS` carries.
 * Four points, each load-bearing:
 *
 * 1. Equal to `INGRESS_JOURNAL_RETENTION_DAYS`. Both tables are created by
 *    the same migration (0055), both hold verified-but-unprocessed SendGrid
 *    payload PII, and ARCHITECTURE.md §12's erasure-scrub exemption argument
 *    is written once for both -- a horizon here longer than the journal's
 *    would silently invalidate a documented exemption that names both
 *    tables together.
 * 2. The CMP-04 erasure scrub (`erasure-scrub.worker.ts`) deliberately does
 *    NOT reach this table, and this horizon is the reason: it expires
 *    faster than an erasure request's own completion window, so a row
 *    carrying an erasure-requested contact's data is gone from here on its
 *    own before the scrub would ever need to touch it. This is the exact
 *    paragraph whose absence was recorded as this phase's blocking
 *    verification gap -- `ingress_journal` had it, this table did not.
 * 3. Not shorter than `OCCURRED_AT_MAX_PAST_DAYS` (`@mega-crm/delivery-core`),
 *    so a quarantined event stays queryable for at least as long as the
 *    acceptance window it failed -- an operator investigating a wave of
 *    rejections has the rejected rows for the whole period over which the
 *    rejection decision was made.
 * 4. If a later phase raises this constant, point 2's exemption argument
 *    stops holding and `erasure-scrub.worker.ts`'s scope must be revisited
 *    rather than inherited.
 */
export const SEND_EVENT_QUARANTINE_RETENTION_DAYS = 7;

export interface QuarantinedEventRow {
  sgEventId: string | null;
  eventType: string | null;
  rawEvent: unknown;
  reason: string;
  occurredAtCandidate: string | null;
}

/**
 * Inserts one row per rejected event. Resolves rather than rejecting when
 * the INSERT itself fails -- a quarantine-write failure must never abort
 * the surrounding batch (mirrors `writeDeadLetterOnTerminalFailure`'s own
 * contract). `rawEvent` is passed through `JSON.stringify` before binding
 * for the same reason `writeIngressJournal` does: node-postgres serializes
 * a bare JS object correctly as `jsonb`, but this keeps the binding
 * explicit rather than relying on the driver's default object handling
 * matching every caller's shape.
 */
export async function writeQuarantinedEvent(
  client: PoolClient,
  workspaceId: string,
  row: QuarantinedEventRow
): Promise<void> {
  try {
    await client.query(
      `INSERT INTO send_event_quarantine (workspace_id, sg_event_id, event_type, raw_event, reason, occurred_at_candidate)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        workspaceId,
        row.sgEventId,
        row.eventType,
        JSON.stringify(row.rawEvent),
        row.reason,
        row.occurredAtCandidate,
      ]
    );
  } catch (writeErr) {
    scrubbedConsole.error("quarantine: failed to write send_event_quarantine row", writeErr);
  }
}

/**
 * Phase 13 (CMP-04, D-07, gap-closure plan 13-16, Task 1): the disposal
 * counterpart to `writeQuarantinedEvent`. Deletes `send_event_quarantine`
 * rows older than `retentionDays`, returning the deleted count. Three
 * things a reader cannot infer from the SQL below:
 *
 * First, the predicate names `received_at` and nothing else, because that
 * is the only column on this row the server sets -- `occurred_at_candidate`
 * and any provider-supplied `timestamp` field inside `raw_event` are exactly
 * the values CMP-05's bounds check refused to trust, and letting either one
 * choose when PII is disposed of would hand an attacker or a broken clock
 * control over a compliance horizon.
 *
 * Second, this is a plain row delete rather than the payload-null-plus-
 * tombstone shape `purgeExpiredIngressJournalPayloads` uses for its sibling
 * table: a quarantined event is a terminal decision with no replay value
 * and no cross-workspace reader (migration 0055 grants this table nothing
 * to `mega_crm_scan`), so there is no signal a surviving row would keep
 * alive -- unlike an un-ingested journal row, which is the only remaining
 * evidence of an ingestion loss and is therefore kept as a tombstone.
 *
 * Third, the delete is not row-limited per call, mirroring
 * `pruneIngressJournal`'s own unbounded shape -- acceptable here because
 * quarantine rows are a strict subset of webhook events that failed the
 * bounds check, far below the completed-journal volume the adjacent
 * unbounded prune already deletes in the same transaction (T-13-16-03,
 * disposition: accept). If quarantine volume ever approaches webhook
 * volume, a page limit is the correct response.
 *
 * Takes a `PoolClient` as its first argument and never opens its own
 * connection, matching every other helper in this directory -- the
 * fail-closed `workspace_isolation` policy means an unscoped caller raises
 * rather than silently deleting nothing, and that property comes from the
 * migration, not from anything this function does.
 */
export async function pruneSendEventQuarantine(client: PoolClient, retentionDays: number): Promise<number> {
  const result = await client.query(
    `DELETE FROM send_event_quarantine
      WHERE received_at < now() - make_interval(days => $1)`,
    [retentionDays]
  );
  return result.rowCount ?? 0;
}
