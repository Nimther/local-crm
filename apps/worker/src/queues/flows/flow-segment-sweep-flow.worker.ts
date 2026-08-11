import { Worker, type ConnectionOptions, type Job } from "bullmq";
import type { PoolClient } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { compileSegmentDefinition, type SegmentDefinition } from "@mega-crm/segments-core";
import { scrubbedConsole } from "@mega-crm/redaction";
import { FLOW_SEGMENT_SWEEP_FLOW_QUEUE, flowSegmentSweepFlowJobSchema } from "@mega-crm/shared-schemas";
import { enterSegmentTriggeredFlow, type LiveSegmentFlowRow } from "./flow-trigger-evaluator.worker.js";
import { advanceSweepCheckpoint, loadSweepCheckpoint, resetSweepCheckpoint } from "./flow-segment-sweep-checkpoint.js";

/**
 * Phase 12 (WRK-05/WRK-06, D-09): the bounded, checkpointed, resumable
 * per-flow walk that `flow-segment-sweep.worker.ts`'s discovery tick fans
 * out to -- one job per live segment-triggered flow. Replaces the old
 * `sweepOneFlow`'s single unbounded transaction (every matching contact for
 * one flow, loaded and diffed in memory in one go) with a keyset-paginated
 * loop, each page in its OWN transaction, so a kill between pages loses at
 * most one page's worth of work rather than the whole flow's sweep.
 *
 * Mirrors `recipient-snapshot.ts`'s keyset-pagination/short-transaction
 * template, with ONE deliberate divergence (D-09/Pitfall 3): this walk is
 * PERPETUAL, so its cursor RESETS to NULL on reaching a page with zero
 * rows (see `resetSweepCheckpoint`'s own doc comment) -- unlike
 * `recipient-snapshot.ts`'s one-shot `campaigns.snapshot_cursor` freeze,
 * which never resets because a campaign send's audience is frozen once,
 * forever.
 */

/** 500 contacts per page -- large enough that a normally-sized segment sweeps in a handful of pages, small enough that each page's transaction stays short under `SWEEP_PAGE_STATEMENT_TIMEOUT_MS`. */
export const SWEEP_PAGE_SIZE = 500;

/** 1000 rows per stale-snapshot delete batch -- the same bounded-batch discipline as the page loop, applied to the anti-join cleanup so a segment with a large stale backlog can never hold one DELETE open indefinitely. */
export const SWEEP_DELETE_BATCH_SIZE = 1000;

/**
 * 15s per page -- deliberately much shorter than the OLD whole-flow budget
 * (`BULK_QUERY_STATEMENT_TIMEOUT_MS`, 60s) this file replaces: each page is
 * now a genuinely short transaction (one bounded SELECT, a bounded number
 * of per-contact entry-primitive calls, one checkpoint UPSERT), not an
 * entire flow's worth of work.
 */
export const SWEEP_PAGE_STATEMENT_TIMEOUT_MS = 15_000;

/**
 * 60s wall-clock budget for one walk JOB (spanning potentially many pages
 * and delete batches) -- bounds how long a single job may run before
 * yielding the worker, so a huge flow's backlog cannot monopolise it. The
 * job returns with its cursor intact (no error) when the budget expires
 * before the walk completes; the NEXT discovery tick's job for this flow
 * (deterministic jobId, `flow-segment-sweep.worker.ts`) resumes from
 * exactly that cursor.
 */
export const SWEEP_FLOW_JOB_BUDGET_MS = 60_000;

interface FlowForSweep {
  id: string;
  liveVersionId: string;
  triggerSegmentId: string;
  reentryMode: string;
  reentryWindowDays: number | null;
}

/**
 * Re-derives the flow's CURRENT trigger segment/reentry config from
 * `flows` itself (re-derive-from-row convention, mirrors
 * `flow-enroll-existing.worker.ts`'s `loadFlow`) -- the walk job payload
 * carries only `workspaceId`/`flowId`, never a stale copy of the flow's
 * settings. Returns `null` when the flow no longer matches the criteria
 * discovery required (paused since discovery ran, trigger segment/live
 * version cleared) or its trigger segment's definition was deleted --
 * both defensive no-ops, mirroring the old `sweepOneFlow`'s own guard.
 */
async function loadFlowForSweep(
  client: PoolClient,
  workspaceId: string,
  flowId: string
): Promise<{ flow: FlowForSweep; definition: SegmentDefinition } | null> {
  const { rows } = await client.query<{
    id: string;
    liveVersionId: string | null;
    triggerSegmentId: string | null;
    reentryMode: string;
    reentryWindowDays: number | null;
  }>(
    `SELECT id, live_version_id as "liveVersionId", trigger_segment_id as "triggerSegmentId",
            reentry_mode as "reentryMode", reentry_window_days as "reentryWindowDays"
     FROM flows
     WHERE workspace_id = $1 AND id = $2 AND status = 'live' AND trigger_type = 'segment'`,
    [workspaceId, flowId]
  );
  const row = rows[0];
  if (!row || !row.liveVersionId || !row.triggerSegmentId) return null;

  const { rows: segmentRows } = await client.query<{ definition: SegmentDefinition }>(
    `SELECT definition FROM segments WHERE id = $1 AND workspace_id = $2`,
    [row.triggerSegmentId, workspaceId]
  );
  const definition = segmentRows[0]?.definition;
  if (!definition) return null; // D-24 restrict-delete should prevent this; defensive no-op

  return {
    flow: {
      id: row.id,
      liveVersionId: row.liveVersionId,
      triggerSegmentId: row.triggerSegmentId,
      reentryMode: row.reentryMode,
      reentryWindowDays: row.reentryWindowDays,
    },
    definition,
  };
}

/**
 * One bounded batch of the stale-snapshot anti-join DELETE (the same
 * cleanup the old `sweepOneFlow` ran unbounded) -- removes at most
 * `SWEEP_DELETE_BATCH_SIZE` rows whose contact no longer matches the
 * trigger segment. Scoped by the SAME per-page statement timeout as the
 * page loop -- this is also now a short transaction, never a single
 * unbounded DELETE over a segment's whole stale backlog.
 */
async function deleteStaleSnapshotBatch(
  client: PoolClient,
  workspaceId: string,
  flowId: string,
  whereSql: string,
  params: unknown[]
): Promise<number> {
  await client.query(`SELECT set_config('statement_timeout', $1, true)`, [String(SWEEP_PAGE_STATEMENT_TIMEOUT_MS)]);

  const workspaceParamIdx = params.length + 1;
  const flowParamIdx = params.length + 2;
  const limitIdx = params.length + 3;
  const { rowCount } = await client.query(
    `DELETE FROM flow_segment_membership_snapshot
     WHERE id IN (
       SELECT s.id FROM flow_segment_membership_snapshot s
       WHERE s.workspace_id = $${workspaceParamIdx} AND s.flow_id = $${flowParamIdx}
         AND NOT EXISTS (SELECT 1 FROM contacts c WHERE ${whereSql} AND c.id = s.contact_id)
       LIMIT $${limitIdx}
     )`,
    [...params, workspaceId, flowId, SWEEP_DELETE_BATCH_SIZE]
  );
  return rowCount ?? 0;
}

/**
 * Loops `deleteStaleSnapshotBatch` until a batch removes nothing, or the
 * job's overall budget expires -- each batch its own transaction, mirroring
 * the page loop's own short-transaction discipline. Runs BEFORE the page
 * loop (and before any early return the caller might take), preserving the
 * old `sweepOneFlow`'s ordering: a fully-emptied segment still clears its
 * stale rows even if the page loop below has nothing to do.
 */
async function drainStaleSnapshotBatches(
  workspaceId: string,
  flowId: string,
  whereSql: string,
  params: unknown[],
  deadlineAt: number
): Promise<void> {
  while (Date.now() < deadlineAt) {
    const deleted = await withTenantTransaction((client) =>
      deleteStaleSnapshotBatch(client, workspaceId, flowId, whereSql, params)
    );
    if (deleted === 0) break;
  }
}

export interface SweepOneFlowPageResult {
  /** Rows the page's SELECT returned (0 means the walk has reached the end of `contacts.id` order for this flow's current matching set). */
  processed: number;
  /** The page's last contact id, or `null` when `processed` is 0. */
  lastContactId: string | null;
}

/**
 * One page of the bounded walk (WRK-05/WRK-06, D-09): keyset-paginates on
 * `contacts.id` (`c.id > $cursor ORDER BY c.id ASC LIMIT`) -- NEVER
 * skip-ahead OFFSET pagination (Pitfall 3). Diffs the page's contact ids
 * against `flow_segment_membership_snapshot` scoped to JUST this page's ids
 * (bounded -- never the whole flow's snapshot, unlike the old `sweepOneFlow`),
 * routes each newly-matching contact through the SAME `enterSegmentTriggeredFlow`
 * entry primitive the event-driven re-check and the old sweep both use
 * (key_link: "same entry path as event triggers"), then commits the page's
 * checkpoint advance ON THE SAME `client` -- the caller wraps this whole
 * function in one `withTenantTransaction`, so the enrollment writes and the
 * cursor write are visible or absent together (D-09's core guarantee).
 *
 * A page with zero rows means the walk has reached the end of the current
 * matching set -- resets the checkpoint (see `resetSweepCheckpoint`'s own
 * doc comment for why a permanent cursor would be wrong here) rather than
 * advancing it.
 */
export async function sweepOneFlowPage(
  client: PoolClient,
  workspaceId: string,
  flow: LiveSegmentFlowRow,
  whereSql: string,
  params: unknown[],
  afterContactId: string | null
): Promise<SweepOneFlowPageResult> {
  await client.query(`SELECT set_config('statement_timeout', $1, true)`, [String(SWEEP_PAGE_STATEMENT_TIMEOUT_MS)]);

  const cursorClause = afterContactId ? `AND c.id > $${params.length + 1}` : "";
  const cursorParams = afterContactId
    ? [...params, afterContactId, SWEEP_PAGE_SIZE]
    : [...params, SWEEP_PAGE_SIZE];
  const limitIdx = cursorParams.length;

  const { rows: pageContacts } = await client.query<{ id: string }>(
    `SELECT c.id FROM contacts c WHERE ${whereSql} ${cursorClause} ORDER BY c.id ASC LIMIT $${limitIdx}`,
    cursorParams
  );

  if (pageContacts.length === 0) {
    await resetSweepCheckpoint(client, workspaceId, flow.id);
    return { processed: 0, lastContactId: null };
  }

  const pageContactIds = pageContacts.map((row) => row.id);
  const { rows: seenRows } = await client.query<{ contactId: string }>(
    `SELECT contact_id as "contactId" FROM flow_segment_membership_snapshot
     WHERE workspace_id = $1 AND flow_id = $2 AND contact_id = ANY($3::uuid[])`,
    [workspaceId, flow.id, pageContactIds]
  );
  const seenIds = new Set(seenRows.map((row) => row.contactId));

  for (const contactId of pageContactIds) {
    if (seenIds.has(contactId)) continue; // already considered on a prior page/walk -- enterSegmentTriggeredFlow's own contract is one-shot per D-02
    await enterSegmentTriggeredFlow(client, workspaceId, flow, contactId);
  }

  const lastContactId = pageContactIds.at(-1) as string;
  await advanceSweepCheckpoint(client, workspaceId, flow.id, lastContactId);

  return { processed: pageContacts.length, lastContactId };
}

/**
 * The walk job's handler (WRK-05/WRK-06, D-09, R-05): validates the payload
 * against `flowSegmentSweepFlowJobSchema` itself -- an unrecognized
 * `schemaVersion` is DEFERRED (logged, returns without doing any work)
 * rather than thrown, so a rolling deploy's old- or new-code worker never
 * acts on a payload shape it was not built for. `data` is typed `unknown`
 * (not `FlowSegmentSweepFlowJob`) precisely so this validation is real --
 * a caller (a live Worker, or a test driving one job directly) can hand
 * this function a stale-shaped payload and observe the defer, not a throw.
 *
 * Re-enters `withTenant(workspaceId, ...)` for everything after the payload
 * check -- discovery's cross-workspace scan role grants nothing beyond
 * finding which flows exist; this job, like every per-flow write in this
 * codebase, runs fully tenant-scoped.
 *
 * Drains the stale-snapshot cleanup FIRST (before the page loop, before any
 * early return), then loops `sweepOneFlowPage` -- each page its own
 * transaction -- until a page returns zero rows (the walk is complete) or
 * the job's `SWEEP_FLOW_JOB_BUDGET_MS` wall-clock budget expires. On budget
 * expiry the function simply returns: the cursor a prior page committed is
 * exactly where the NEXT job for this flow (the following discovery tick's
 * enqueue, same deterministic jobId) resumes from -- no error, no partial
 * state to reconcile.
 */
export async function runFlowSegmentSweepFlowJob(data: unknown): Promise<void> {
  const parsed = flowSegmentSweepFlowJobSchema.safeParse(data);
  if (!parsed.success) {
    scrubbedConsole.error("flow-segment-sweep-flow: deferring job with an unrecognized payload shape", {});
    return;
  }
  const { workspaceId, flowId } = parsed.data;
  const deadlineAt = Date.now() + SWEEP_FLOW_JOB_BUDGET_MS;

  await withTenant(workspaceId, async () => {
    const setup = await withTenantTransaction((client) => loadFlowForSweep(client, workspaceId, flowId));
    if (!setup) return;

    const { flow, definition } = setup;
    const { whereSql, params } = compileSegmentDefinition(definition, workspaceId);

    await drainStaleSnapshotBatches(workspaceId, flowId, whereSql, params, deadlineAt);

    let cursor = await withTenantTransaction((client) => loadSweepCheckpoint(client, workspaceId, flowId));

    while (Date.now() < deadlineAt) {
      const page = await withTenantTransaction((client) =>
        sweepOneFlowPage(client, workspaceId, flow, whereSql, params, cursor)
      );
      if (page.processed === 0) break;
      cursor = page.lastContactId;
    }
  });
}

/**
 * Constructs the bounded per-flow walk Worker. Registered in
 * `apps/worker/src/server.ts`'s `buildWorker()` beside the existing sweep
 * (discovery) worker -- WRK-05/WRK-06.
 */
export function createFlowSegmentSweepFlowWorker(connection: ConnectionOptions): Worker {
  return new Worker(
    FLOW_SEGMENT_SWEEP_FLOW_QUEUE,
    async (job: Job) => {
      await runFlowSegmentSweepFlowJob(job.data);
    },
    { connection }
  );
}
