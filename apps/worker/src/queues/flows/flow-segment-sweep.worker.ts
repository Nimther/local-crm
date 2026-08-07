import { Queue, Worker, type ConnectionOptions } from "bullmq";
import type { PoolClient } from "pg";
import { withCrossWorkspaceScan, withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { compileSegmentDefinition, type SegmentDefinition } from "@mega-crm/segments-core";
import { FLOW_SEGMENT_SWEEP_QUEUE } from "@mega-crm/shared-schemas";
import { enterSegmentTriggeredFlow, type LiveSegmentFlowRow } from "./flow-trigger-evaluator.worker.js";

/**
 * D-02b/RESEARCH.md Assumption A1/Pitfall 1: this is an INSURANCE path, not a
 * low-latency one -- the event-driven re-check
 * (`flow-trigger-evaluator.worker.ts`'s `checkSegmentEntryForContact`)
 * already covers latency for any contact change that arrives via an
 * ingested event. 15 minutes bounds worst-case staleness for a contact whose
 * segment membership changed with NO accompanying event (e.g. a bulk
 * CSV-import property update, or a segment definition edit that newly
 * includes a previously-unmatched contact with no fresh event of its own).
 */
export const SWEEP_INTERVAL_MS = 15 * 60_000;

/**
 * A background job has more time budget than the segments engine's own
 * interactive save-eval timeout (15s), but must still be bounded -- mirrors
 * `recipient-snapshot.ts`'s `SNAPSHOT_STATEMENT_TIMEOUT_MS` discipline,
 * applied here to the per-flow bulk membership query.
 */
const BULK_QUERY_STATEMENT_TIMEOUT_MS = 60_000;

interface DueSegmentFlowRow {
  id: string;
  workspaceId: string;
  triggerSegmentId: string;
  liveVersionId: string;
  reentryMode: string;
  reentryWindowDays: number | null;
}

/**
 * Admin-side DISCOVERY scan (T-06-08-02, mirrors
 * `campaign-scheduler.worker.ts`'s `findDueCampaignCandidates` and
 * `flow-reconciliation.worker.ts`'s due-run scan exactly; Phase 10
 * SEC-01/SEC-02, D-01/D-02): runs on the dedicated `mega_crm_scan` login
 * role via `withCrossWorkspaceScan` -- this scan doesn't know which
 * workspace a flow belongs to until it reads one, so it can never go
 * through `withTenant`/`withTenantTransaction`. Access control is the
 * role's identity plus migration 0042's role-scoped `flows_scan` policy
 * (narrowed to `status = 'live' AND trigger_type = 'segment' AND
 * trigger_segment_id IS NOT NULL AND live_version_id IS NOT NULL`), not a
 * session GUC -- this connection is never granted any write visibility
 * across tenants (`flows_scan` is SELECT-only).
 */
async function findLiveSegmentTriggeredFlows(): Promise<DueSegmentFlowRow[]> {
  return withCrossWorkspaceScan(async (client) => {
    const { rows } = await client.query<DueSegmentFlowRow>(
      `SELECT id, workspace_id as "workspaceId", trigger_segment_id as "triggerSegmentId",
              live_version_id as "liveVersionId", reentry_mode as "reentryMode",
              reentry_window_days as "reentryWindowDays"
       FROM flows
       WHERE status = 'live' AND trigger_type = 'segment'
         AND trigger_segment_id IS NOT NULL AND live_version_id IS NOT NULL`
    );
    return rows;
  });
}

async function loadSegmentDefinition(
  client: PoolClient,
  workspaceId: string,
  segmentId: string
): Promise<SegmentDefinition | null> {
  const { rows } = await client.query<{ definition: SegmentDefinition }>(
    `SELECT definition FROM segments WHERE id = $1 AND workspace_id = $2`,
    [segmentId, workspaceId]
  );
  return rows[0]?.definition ?? null;
}

/**
 * RESEARCH.md Pitfall 1 (the prohibition this plan's threat register
 * explicitly guards, T-06-08-01): ONE compiled bulk query per
 * segment-triggered flow (`SELECT id FROM contacts WHERE <compiled where>`),
 * diffed in-process against `flow_segment_membership_snapshot` -- O(flows)
 * bulk queries total, NEVER a per-contact `isContactInSegment` point-check
 * loop across the whole workspace (which would be O(flows x contacts)).
 * Every subsequent read/write (segment lookup, contacts query, flow_runs
 * insert, snapshot upsert) re-enters `withTenant(row.workspaceId)` and is
 * fully RLS-scoped as normal -- the admin-scan exception above grants
 * nothing beyond the initial cross-tenant flow discovery.
 */
async function sweepOneFlow(row: DueSegmentFlowRow): Promise<void> {
  await withTenant(row.workspaceId, () =>
    withTenantTransaction(async (client) => {
      const definition = await loadSegmentDefinition(client, row.workspaceId, row.triggerSegmentId);
      if (!definition) return; // D-24 restrict-delete should prevent this; defensive no-op

      await client.query(`SELECT set_config('statement_timeout', $1, true)`, [
        String(BULK_QUERY_STATEMENT_TIMEOUT_MS),
      ]);
      const { whereSql, params } = compileSegmentDefinition(definition, row.workspaceId);

      // 06-19/WR-04/FLOW-04: clear this flow's snapshot row for any contact
      // who no longer matches the trigger segment -- "seen" must mean
      // "currently inside this membership episode", not "ever considered".
      // Bounded anti-join DELETE (not a per-contact loop), covered by the
      // statement_timeout set above. Runs BEFORE the empty-membership early
      // return below so a fully-emptied segment still clears its stale rows.
      const deleteParams = [...params, row.workspaceId, row.id];
      const workspaceParamIdx = params.length + 1;
      const flowParamIdx = params.length + 2;
      await client.query(
        `DELETE FROM flow_segment_membership_snapshot s
         WHERE s.workspace_id = $${workspaceParamIdx} AND s.flow_id = $${flowParamIdx}
           AND NOT EXISTS (SELECT 1 FROM contacts c WHERE ${whereSql} AND c.id = s.contact_id)`,
        deleteParams
      );

      const { rows: matchingContacts } = await client.query<{ id: string }>(
        `SELECT c.id FROM contacts c WHERE ${whereSql}`,
        params
      );
      if (matchingContacts.length === 0) return;

      const { rows: seenRows } = await client.query<{ contactId: string }>(
        `SELECT contact_id as "contactId" FROM flow_segment_membership_snapshot WHERE workspace_id = $1 AND flow_id = $2`,
        [row.workspaceId, row.id]
      );
      const seenIds = new Set(seenRows.map((seenRow) => seenRow.contactId));
      const newContactIds = matchingContacts.map((contactRow) => contactRow.id).filter((id) => !seenIds.has(id));
      if (newContactIds.length === 0) return;

      const flowForEntry: LiveSegmentFlowRow = {
        id: row.id,
        liveVersionId: row.liveVersionId,
        triggerSegmentId: row.triggerSegmentId,
        reentryMode: row.reentryMode,
        reentryWindowDays: row.reentryWindowDays,
      };

      // Same entry primitive the event-driven re-check uses (key_link:
      // "same entry path as event triggers") -- canEnterFlow + version-pinned
      // run creation + advance enqueue + snapshot upsert, per contact.
      for (const contactId of newContactIds) {
        await enterSegmentTriggeredFlow(client, row.workspaceId, flowForEntry, contactId);
      }
    })
  );
}

/**
 * The sweep's per-tick body -- discovers every live segment-triggered flow
 * across every tenant and sweeps each one. Exported standalone (not only as
 * a Worker's inline processor), mirroring every other worker's exported-
 * processor convention in this codebase, so
 * `flow-segment-trigger.test.ts` (Task 3) can invoke a single tick directly
 * without waiting on `SWEEP_INTERVAL_MS`'s real 15-minute repeat interval.
 */
export async function runFlowSegmentSweepTick(): Promise<void> {
  const dueFlows = await findLiveSegmentTriggeredFlows();
  for (const row of dueFlows) {
    await sweepOneFlow(row);
  }
}

/**
 * Constructs the repeatable flow-segment-sweep Worker (D-02b): scans every
 * live segment-triggered flow across every tenant every `SWEEP_INTERVAL_MS`
 * (15 min) and enrolls any contact newly matching that flow's trigger
 * segment. Registered in `apps/worker/src/server.ts`'s `buildWorker()`
 * (Task 2).
 */
export function createFlowSegmentSweepWorker(connection: ConnectionOptions): Worker {
  const tickQueue = new Queue(FLOW_SEGMENT_SWEEP_QUEUE, { connection });
  // Idempotent registration: BullMQ dedupes a repeatable job by its own
  // repeat config + jobId, so calling this on every worker boot never
  // creates a second competing repeatable schedule.
  void tickQueue.add(
    "scan-segment-triggered-flows",
    {},
    { repeat: { every: SWEEP_INTERVAL_MS }, jobId: "scan-segment-triggered-flows" }
  );

  return new Worker(FLOW_SEGMENT_SWEEP_QUEUE, runFlowSegmentSweepTick, { connection });
}
