import { Queue, Worker, type ConnectionOptions } from "bullmq";
import { withCrossWorkspaceScan } from "@mega-crm/tenant-context";
import { scrubbedConsole } from "@mega-crm/redaction";
import { buildJobOptions, STANDARD_JOB_RETENTION } from "@mega-crm/queue-core";
import {
  FLOW_SEGMENT_SWEEP_FLOW_SCHEMA_VERSION,
  FLOW_SEGMENT_SWEEP_QUEUE,
  FLOW_SEGMENT_SWEEP_TICK_SCHEMA_VERSION,
  flowSegmentSweepTickJobSchema,
} from "@mega-crm/shared-schemas";
import { flowSegmentSweepFlowQueue } from "./flow-queues.js";
import { wrapProcessor } from "../../processor-wrapper.js";

/**
 * Phase 12 (WRK-05/WRK-06, D-09): discovery-only half of the segment sweep,
 * split from the bounded per-flow walk (`flow-segment-sweep-flow.worker.ts`)
 * -- mirrors `campaign-scheduler.worker.ts` -> `campaign-kickoff.worker.ts`'s
 * own discover-then-enqueue split. This file used to ALSO run the whole
 * per-flow walk inline, in one unbounded transaction per flow, with no
 * cursor and no page bound -- the largest known unbounded-memory path in
 * the worker. It now does exactly one thing: find every live
 * segment-triggered flow across every tenant, and enqueue one bounded walk
 * job per flow.
 *
 * D-02b/RESEARCH.md Assumption A1/Pitfall 1: this is an INSURANCE path, not
 * a low-latency one -- the event-driven re-check
 * (`flow-trigger-evaluator.worker.ts`'s `checkSegmentEntryForContact`)
 * already covers latency for any contact change that arrives via an
 * ingested event. 15 minutes bounds worst-case staleness for a contact whose
 * segment membership changed with NO accompanying event (e.g. a bulk
 * CSV-import property update, or a segment definition edit that newly
 * includes a previously-unmatched contact with no fresh event of its own).
 */
export const SWEEP_INTERVAL_MS = 15 * 60_000;

/**
 * The stable id `upsertJobScheduler` dedupes by (WRK-13) -- constant across
 * every boot, mirrors `partition-maintenance.worker.ts`'s/
 * `send-reconciler.worker.ts`'s own scheduler ids, so registering it on
 * every worker boot never creates a second competing schedule.
 */
export const FLOW_SEGMENT_SWEEP_SCHEDULER_ID = "flow-segment-sweep-tick";

const JOB_NAME = "run-flow-segment-sweep-tick";

/**
 * Built through the shared `@mega-crm/queue-core` factory (Phase 12,
 * WRK-09/WRK-11, D-10) -- this discovery-tick queue was the one guarded
 * module the 12-02 consolidation missed (it kept a hand-rolled literal with
 * `removeOnFail: false` until this plan). `STANDARD_JOB_RETENTION`'s
 * bounded failed-job retention (`FAILED_JOB_RETENTION_SECONDS`, 7 days)
 * matters here too: a tick that throws remains inspectable in Redis for a
 * full working week, not forever, and this worker is already covered by
 * `attachSharedErrorListeners`' dead-letter hook (`apps/worker/src/server.ts`),
 * which is what makes bounding this retention safe.
 */
const DEFAULT_JOB_OPTIONS = buildJobOptions(STANDARD_JOB_RETENTION);

/**
 * WRK-13: the OLD `tickQueue.add({repeat})` registration this migrates
 * away from, named here purely so the one-time cleanup below can be
 * deleted once every environment has booted past this migration (every
 * live environment's Redis has, by then, had its legacy repeatable entry
 * removed). Redis persists across deploys -- leaving this entry in place
 * would run BOTH schedules after this change ships, and its empty `{}`
 * payload now fails `flowSegmentSweepTickJobSchema`'s validation on every
 * one of its ticks (it carries no `schemaVersion` at all).
 */
const LEGACY_JOB_NAME = "scan-segment-triggered-flows";
const LEGACY_REPEAT_EVERY_MS = SWEEP_INTERVAL_MS;
const LEGACY_JOB_ID = "scan-segment-triggered-flows";

export interface DueSegmentFlowRow {
  id: string;
  workspaceId: string;
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
 *
 * Selects only `id`/`workspace_id` -- unlike the old discovery half, the
 * walk job re-derives the flow's trigger segment/reentry config itself
 * (`flow-segment-sweep-flow.worker.ts`'s `loadFlowForSweep`), so this scan
 * carries the same T-12-06-01 mitigation the threat register requires:
 * every subsequent read/write re-enters tenant-scoped context, and the
 * scan role's own visibility never extends past this one query.
 */
export async function findLiveSegmentTriggeredFlows(): Promise<DueSegmentFlowRow[]> {
  return withCrossWorkspaceScan(async (client) => {
    const { rows } = await client.query<DueSegmentFlowRow>(
      `SELECT id, workspace_id as "workspaceId"
       FROM flows
       WHERE status = 'live' AND trigger_type = 'segment'
         AND trigger_segment_id IS NOT NULL AND live_version_id IS NOT NULL`
    );
    return rows;
  });
}

/**
 * The sweep's per-tick body (WRK-05/WRK-06): discovers every live
 * segment-triggered flow across every tenant and enqueues ONE bounded walk
 * job per flow, under a job id derived from the flow id (`sweep-${flowId}`)
 * -- BullMQ's `Queue.add()` no-ops while a job with that id exists in ANY
 * state, so a still-running (or still-retained-completed, hence
 * `FLOW_SEGMENT_SWEEP_FLOW_JOB_OPTIONS`'s `removeOnComplete: true`) sweep
 * for that flow is never double-enqueued by the next tick. Exported
 * standalone (mirrors every other worker's exported-processor convention)
 * so `flow-segment-trigger.test.ts` can invoke a single tick directly
 * without waiting on `SWEEP_INTERVAL_MS`'s real 15-minute repeat interval.
 */
export async function runFlowSegmentSweepTick(): Promise<void> {
  const dueFlows = await findLiveSegmentTriggeredFlows();
  for (const row of dueFlows) {
    await flowSegmentSweepFlowQueue.add(
      "sweep",
      { schemaVersion: FLOW_SEGMENT_SWEEP_FLOW_SCHEMA_VERSION, workspaceId: row.workspaceId, flowId: row.id },
      { jobId: `sweep-${row.id}` }
    );
  }
}

/**
 * Constructs the discovery Worker (WRK-05/WRK-06/WRK-13): registers the
 * 15-minute job-scheduler tick (idempotent by `FLOW_SEGMENT_SWEEP_SCHEDULER_ID`)
 * via the SAME `upsertJobScheduler` + try/catch/finally + registration-queue
 * close shape `partition-maintenance.worker.ts`/`send-reconciler.worker.ts`
 * established, migrating away from this file's own former
 * `tickQueue.add({repeat})` form -- the old form had neither a try/finally
 * nor a `queue.close()` call at all, leaking that registration queue's
 * Redis connection for the life of the process. In the same guarded block,
 * removes the legacy repeatable entry (see the three `LEGACY_*` constants
 * above) -- tolerates a not-found result (a fresh environment has none).
 * The processor validates every job's payload against
 * `flowSegmentSweepTickJobSchema` (R-05) before calling `runFlowSegmentSweepTick`
 * -- an unrecognized `schemaVersion` is DEFERRED (logged, never processed)
 * rather than thrown.
 */
export function createFlowSegmentSweepWorker(connection: ConnectionOptions): Worker {
  const queue = new Queue(FLOW_SEGMENT_SWEEP_QUEUE, { connection });

  const worker = new Worker(
    FLOW_SEGMENT_SWEEP_QUEUE,
    wrapProcessor(FLOW_SEGMENT_SWEEP_QUEUE, async (job) => {
      const parsed = flowSegmentSweepTickJobSchema.safeParse(job.data);
      if (!parsed.success) {
        scrubbedConsole.error("flow-segment-sweep: deferring job with an unrecognized payload shape", {
          jobId: job.id,
        });
        return;
      }
      await runFlowSegmentSweepTick();
    }),
    { connection }
  );

  // Fire-and-forget registration -- copied in shape from
  // partition-maintenance.worker.ts's/send-reconciler.worker.ts's
  // try/catch/finally exactly: a Redis hiccup at boot must log, not crash
  // every other registered worker via an unhandled promise rejection; the
  // `finally` always closes this short-lived internal Queue handle so a
  // failure here never leaks a standalone Redis connection past
  // construction.
  void (async () => {
    try {
      await queue.upsertJobScheduler(
        FLOW_SEGMENT_SWEEP_SCHEDULER_ID,
        { every: SWEEP_INTERVAL_MS },
        {
          name: JOB_NAME,
          data: { schemaVersion: FLOW_SEGMENT_SWEEP_TICK_SCHEMA_VERSION },
          opts: DEFAULT_JOB_OPTIONS,
        }
      );

      // WRK-13 one-time cleanup: remove the legacy repeatable entry this
      // file's OLD registration form created. Tolerated not-found (a fresh
      // environment never had it) -- remove this block once every
      // environment has booted past this migration.
      await queue.removeRepeatable(LEGACY_JOB_NAME, { every: LEGACY_REPEAT_EVERY_MS }, LEGACY_JOB_ID);
    } catch (err) {
      scrubbedConsole.error("flow-segment-sweep: scheduler registration failed", err);
    } finally {
      await queue.close().catch(() => undefined);
    }
  })();

  return worker;
}
