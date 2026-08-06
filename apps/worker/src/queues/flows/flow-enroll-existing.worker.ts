import { Worker, type Job, type ConnectionOptions } from "bullmq";
import type { PoolClient } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { compileSegmentDefinition, type SegmentDefinition } from "@mega-crm/segments-core";
import {
  FLOW_ENROLL_EXISTING_QUEUE,
  flowEnrollExistingJobSchema,
  type FlowEnrollExistingJob,
} from "@mega-crm/shared-schemas";
import { canEnterFlow } from "./flow-reentry.js";
import { enqueueFlowRunAdvance } from "./flow-queues.js";
import { loadEntryNodeId } from "./flow-trigger-evaluator.worker.js";

/**
 * D-04: batch size for the resumable enroll-existing cursor pattern -- small
 * enough that each batch's transaction (canEnterFlow + conditional flow_runs
 * insert + snapshot upsert, PER contact) stays bounded, mirroring
 * `recipient-snapshot.ts`'s bounded-batch discipline applied to genuinely
 * per-row external work rather than a single INSERT...SELECT.
 */
export const ENROLL_BATCH_SIZE = 500;
const ENROLL_STATEMENT_TIMEOUT_MS = 60_000;

interface FlowForEnroll {
  id: string;
  liveVersionId: string | null;
  triggerSegmentId: string | null;
  reentryMode: string;
  reentryWindowDays: number | null;
}

async function loadFlow(client: PoolClient, workspaceId: string, flowId: string): Promise<FlowForEnroll | null> {
  const { rows } = await client.query<FlowForEnroll>(
    `SELECT id, live_version_id as "liveVersionId", trigger_segment_id as "triggerSegmentId",
            reentry_mode as "reentryMode", reentry_window_days as "reentryWindowDays"
     FROM flows WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, flowId]
  );
  return rows[0] ?? null;
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

interface EnrollBatchResult {
  processed: number;
  lastContactId: string | null;
}

/**
 * One page of the resumable batch enroll (D-04, mirrors
 * `recipient-snapshot.ts`'s `materializeBatch` pattern): keyset-paginates on
 * `contacts.id` (`c.id > $cursor ORDER BY c.id ASC LIMIT`) -- NEVER
 * skip-ahead OFFSET pagination, which degrades to O(n^2) at
 * 100k-1M-contact scale (Pitfall 3). For each contact NOT already in the
 * membership snapshot, routes it through the SAME `canEnterFlow` + version-
 * pinned `flow_runs` insert + advance-enqueue path the event/sweep triggers
 * use, then upserts the snapshot row regardless of the entry decision
 * (mirrors `enterSegmentTriggeredFlow`'s own contract -- an already-seen
 * contact is skipped entirely on a later batch/redelivery). The persisted
 * `flows.enroll_cursor` is advanced in the SAME transaction as the batch's
 * work, so a crash between them is impossible -- a redelivered job resumes
 * exactly where the last committed batch left off. No single unbounded
 * transaction ever spans the whole segment (T-06-08-04).
 */
async function enrollBatch(
  client: PoolClient,
  workspaceId: string,
  flow: FlowForEnroll & { liveVersionId: string; triggerSegmentId: string },
  definition: SegmentDefinition,
  afterContactId: string | null
): Promise<EnrollBatchResult> {
  await client.query(`SELECT set_config('statement_timeout', $1, true)`, [String(ENROLL_STATEMENT_TIMEOUT_MS)]);

  const { whereSql, params } = compileSegmentDefinition(definition, workspaceId);
  const cursorClause = afterContactId ? `AND c.id > $${params.length + 1}` : "";
  const cursorParams = afterContactId
    ? [...params, afterContactId, ENROLL_BATCH_SIZE]
    : [...params, ENROLL_BATCH_SIZE];
  const limitIdx = cursorParams.length;

  const { rows } = await client.query<{ id: string }>(
    `SELECT c.id FROM contacts c WHERE ${whereSql} ${cursorClause} ORDER BY c.id ASC LIMIT $${limitIdx}`,
    cursorParams
  );

  const entryNodeId = await loadEntryNodeId(client, workspaceId, flow.liveVersionId);

  for (const row of rows) {
    const contactId = row.id;

    const { rows: seenRows } = await client.query(
      `SELECT 1 FROM flow_segment_membership_snapshot WHERE workspace_id = $1 AND flow_id = $2 AND contact_id = $3`,
      [workspaceId, flow.id, contactId]
    );
    if (seenRows.length > 0) continue; // already processed by a prior batch/redelivery

    const decision = await canEnterFlow(client, {
      workspaceId,
      flowId: flow.id,
      contactId,
      reentryMode: flow.reentryMode,
      reentryWindowDays: flow.reentryWindowDays,
    });

    if (decision.allowed) {
      const { rows: runRows } = await client.query<{ id: string }>(
        `INSERT INTO flow_runs
           (workspace_id, flow_id, flow_version_id, contact_id, status, current_node_id, next_wake_at, entered_at, last_entry_at)
         VALUES ($1, $2, $3, $4, 'waiting', $5, now(), now(), now())
         ON CONFLICT (workspace_id, flow_id, contact_id) WHERE status IN ('waiting', 'advancing') DO NOTHING
         RETURNING id`,
        [workspaceId, flow.id, flow.liveVersionId, contactId, entryNodeId]
      );
      const flowRunId = runRows[0]?.id;
      if (flowRunId) {
        await enqueueFlowRunAdvance({ workspaceId, flowRunId });
      }
    }

    await client.query(
      `INSERT INTO flow_segment_membership_snapshot (workspace_id, flow_id, contact_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, flow_id, contact_id) DO NOTHING`,
      [workspaceId, flow.id, contactId]
    );
  }

  const lastContactId = rows.at(-1)?.id ?? afterContactId;
  await client.query(`UPDATE flows SET enroll_cursor = $2, updated_at = now() WHERE id = $1`, [
    flow.id,
    lastContactId,
  ]);

  return { processed: rows.length, lastContactId };
}

/**
 * D-04 (enrollExisting=false path): marks every CURRENT member of the
 * flow's trigger segment "seen" in `flow_segment_membership_snapshot`
 * WITHOUT creating a single `flow_runs` row -- so only contacts who enter
 * the segment AFTER this publish (via the event re-check or periodic sweep)
 * ever get enrolled. A single `INSERT...SELECT` bulk statement (no
 * per-contact external work -- no `canEnterFlow` call, unlike the
 * `enrollExisting=true` path above) -- chunking is unnecessary here since
 * nothing but this one statement runs regardless of segment size.
 */
async function seedSnapshotOnly(
  client: PoolClient,
  workspaceId: string,
  flowId: string,
  definition: SegmentDefinition
): Promise<void> {
  await client.query(`SELECT set_config('statement_timeout', $1, true)`, [String(ENROLL_STATEMENT_TIMEOUT_MS)]);

  const { whereSql, params } = compileSegmentDefinition(definition, workspaceId);
  await client.query(
    `INSERT INTO flow_segment_membership_snapshot (workspace_id, flow_id, contact_id)
     SELECT c.workspace_id, $${params.length + 1}, c.id
     FROM contacts c
     WHERE ${whereSql}
     ON CONFLICT (workspace_id, flow_id, contact_id) DO NOTHING`,
    [...params, flowId]
  );
}

/**
 * D-04: the publish route's "enroll existing segment members" job --
 * re-reads the flow's CURRENT trigger segment/reentry config (re-derive-
 * from-row convention, never trusts the job payload as authority beyond
 * `flowId`/`enrollExisting`). `enrollExisting=true` loops the resumable
 * `enrollBatch` (persisted `enroll_cursor`) until a batch processes 0 rows
 * -- resumable: a redelivered job re-enters here, re-reads the persisted
 * cursor, and continues from there. `enrollExisting=false` runs the single
 * bulk seed-only statement instead -- no cursor needed, since it is a single
 * atomic statement regardless of segment size.
 */
export async function processFlowEnrollExisting(data: FlowEnrollExistingJob): Promise<void> {
  const { workspaceId, flowId, enrollExisting } = flowEnrollExistingJobSchema.parse(data);

  await withTenant(workspaceId, async () => {
    const initial = await withTenantTransaction(async (client) => {
      const flow = await loadFlow(client, workspaceId, flowId);
      if (!flow || !flow.triggerSegmentId || !flow.liveVersionId) return null;
      // Narrow: liveVersionId/triggerSegmentId are confirmed non-null above,
      // reconstruct so enrollBatch's parameter type doesn't need to re-guard.
      const resolvedFlow: FlowForEnroll & { liveVersionId: string; triggerSegmentId: string } = {
        ...flow,
        liveVersionId: flow.liveVersionId,
        triggerSegmentId: flow.triggerSegmentId,
      };

      const definition = await loadSegmentDefinition(client, workspaceId, resolvedFlow.triggerSegmentId);
      if (!definition) return null;

      const { rows } = await client.query<{ enrollCursor: string | null }>(
        `SELECT enroll_cursor as "enrollCursor" FROM flows WHERE id = $1 AND workspace_id = $2`,
        [flowId, workspaceId]
      );
      return { flow: resolvedFlow, definition, cursor: rows[0]?.enrollCursor ?? null };
    });
    if (!initial) return;

    const { flow, definition } = initial;

    if (!enrollExisting) {
      await withTenantTransaction((client) => seedSnapshotOnly(client, workspaceId, flow.id, definition));
      return;
    }

    let cursor = initial.cursor;
    while (true) {
      const { processed, lastContactId } = await withTenantTransaction((client) =>
        enrollBatch(client, workspaceId, flow, definition, cursor)
      );
      if (processed === 0) break;
      cursor = lastContactId;
    }
  });
}

/** Registered in apps/worker/src/server.ts's buildWorker() (Task 3). */
export function createFlowEnrollExistingWorker(connection: ConnectionOptions): Worker<FlowEnrollExistingJob> {
  return new Worker<FlowEnrollExistingJob>(
    FLOW_ENROLL_EXISTING_QUEUE,
    async (job: Job<FlowEnrollExistingJob>) => {
      await processFlowEnrollExisting(job.data);
    },
    { connection }
  );
}
