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
