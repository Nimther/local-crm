import { Queue, Worker, type ConnectionOptions } from "bullmq";
import { withCrossWorkspaceScan, withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { scrubbedConsole } from "@mega-crm/redaction";
import { CAMPAIGN_KICKOFF_QUEUE, type CampaignKickoffJob } from "@mega-crm/shared-schemas";
import { buildJobOptions, STANDARD_JOB_RETENTION } from "@mega-crm/queue-core";
import { registerTrackedQueue } from "./queue-registry.js";
import { wrapProcessor } from "../processor-wrapper.js";

/**
 * The scheduler's own repeatable-tick queue -- self-produced and
 * self-consumed within this file/process only. Exported (Phase 15 plan 16,
 * OPS-14) so `board-queues.ts` can derive its Bull Board queue list from
 * this constant rather than a hand-typed duplicate string.
 */
export const CAMPAIGN_SCHEDULER_QUEUE = "campaign-scheduler";
const SCAN_INTERVAL_MS = 60_000;

/**
 * The stable id `upsertJobScheduler` dedupes by (Phase 12, WRK-13) -- constant
 * across every boot, mirrors `partition-maintenance.worker.ts`'s/
 * `send-reconciler.worker.ts`'s/`flow-segment-sweep.worker.ts`'s own scheduler
 * ids, so registering it on every worker boot never creates a second
 * competing schedule.
 */
const JOB_SCHEDULER_ID = "campaign-scheduler-tick";

/** The job name both the scheduled tick and this file's now-removed legacy repeatable job shared. */
const JOB_NAME = "scan-due-campaigns";

/**
 * WRK-13 one-time cleanup identifiers: the OLD `tickQueue.add({repeat})`
 * registration this migrates away from, named here purely so the cleanup
 * below can be deleted once every environment has booted past this
 * migration. Redis persists across deploys -- leaving this entry in place
 * would run BOTH schedules after this change ships.
 */
const LEGACY_JOB_NAME = "scan-due-campaigns";
const LEGACY_REPEAT_EVERY_MS = SCAN_INTERVAL_MS;
const LEGACY_JOB_ID = "scan-due-campaigns";

/** Built through the shared `@mega-crm/queue-core` factory (Phase 12, WRK-11, D-10). Reused for BOTH the tick registration and the long-lived kickoff producer below. */
const DEFAULT_JOB_OPTIONS = buildJobOptions(STANDARD_JOB_RETENTION);

export interface DueCampaignRow {
  id: string;
  workspaceId: string;
}

/**
 * Admin-side DISCOVERY scan for due scheduled campaigns (CAMP-02,
 * T-04-06-01; Phase 10 SEC-01/SEC-02, D-01/D-02): runs on the dedicated
 * `mega_crm_scan` login role via `withCrossWorkspaceScan` -- this scan
 * doesn't know which workspace a campaign belongs to until it reads one, so
 * it can never go through `withTenant`/`withTenantTransaction`. Access
 * control is the role's identity plus migration 0041's role-scoped
 * `campaigns_scan` policy (narrowed to `status = 'scheduled' AND
 * scheduled_at <= now()`), not a session GUC -- `mega_crm_scan` is
 * `NOBYPASSRLS`, owns no tables, and holds only the grants migration 0041
 * adds. Deliberately NOT `FOR UPDATE` here: Postgres RLS requires a row to
 * also satisfy an UPDATE-applicable policy before a locking SELECT can
 * return it, which `campaigns_scan` intentionally does NOT grant (it's
 * SELECT-only) -- the row-level lock for the actual mutation happens
 * per-campaign in `transitionToSending`, properly tenant-scoped, below.
 */
export async function findDueCampaignCandidates(): Promise<DueCampaignRow[]> {
  return withCrossWorkspaceScan(async (client) => {
    const { rows } = await client.query<DueCampaignRow>(
      `SELECT id, workspace_id as "workspaceId" FROM campaigns
       WHERE status = 'scheduled' AND scheduled_at <= now()`
    );
    return rows;
  });
}

/**
 * Transitions one due campaign to 'sending' via the SAME
 * `withTenant`/`withTenantTransaction` discipline every other tenant-scoped
 * write in this codebase uses (T-04-06-01: every write re-enters proper
 * RLS scoping, never relies on the discovery scan's admin exception).
 * `SELECT ... FOR UPDATE SKIP LOCKED` here is a NORMAL, fully tenant-scoped
 * query (workspace_id is already set via `withTenant`, satisfying the
 * ordinary `workspace_isolation` policy for both the lock and the write --
 * no admin exception needed for this step) that re-verifies the row is
 * STILL due, closing the race window between `findDueCampaignCandidates`'s
 * commit and this call, and gracefully skips (rather than blocks on) a row
 * a concurrent tick/process already has locked. The caller only enqueues a
 * kickoff job when this actually transitions the row.
 */
export async function transitionToSending(row: DueCampaignRow): Promise<boolean> {
  return withTenant(row.workspaceId, () =>
    withTenantTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM campaigns
         WHERE id = $1 AND status = 'scheduled' AND scheduled_at <= now()
         FOR UPDATE SKIP LOCKED`,
        [row.id]
      );
      if (rows.length === 0) return false;

      await client.query(
        `UPDATE campaigns SET status = 'sending', sending_started_at = now(), updated_at = now() WHERE id = $1`,
        [row.id]
      );
      return true;
    })
  );
}

/**
 * Test-only synchronization, mirrors `partition-maintenance.worker.ts`'s
 * identical WeakMap: `createCampaignSchedulerWorker`'s own scheduler
 * registration (and the short-lived internal `Queue` handle it runs
 * through) is fire-and-forget in production. This lets
 * `waitForCampaignSchedulerRegistration` below hand a test a promise that
 * resolves only once registration (including closing that internal handle)
 * has actually settled, instead of sleeping.
 */
const registrationSettled = new WeakMap<Worker, Promise<void>>();

/**
 * Test-only: resolves once the `Worker` returned by
 * `createCampaignSchedulerWorker` has finished registering its scheduler
 * (and closed its own internal tick-registration `Queue` handle). Not used
 * by production code.
 */
export function waitForCampaignSchedulerRegistration(worker: Worker): Promise<void> {
  return registrationSettled.get(worker) ?? Promise.resolve();
}

/**
 * Test-only: the long-lived kickoff producer queue constructed alongside a
 * given `Worker` -- not exported as a module-scope singleton (unlike
 * `flow-queues.ts`'s producers) because it is constructed fresh per
 * `createCampaignSchedulerWorker` call, one per test/process. Lets
 * `scheduler-registration.test.ts` assert it remains open and usable after
 * the tick registration has settled, without reaching into module internals.
 */
const kickoffQueueByWorker = new WeakMap<Worker, Queue<CampaignKickoffJob>>();

export function getCampaignSchedulerKickoffQueueForTest(worker: Worker): Queue<CampaignKickoffJob> | undefined {
  return kickoffQueueByWorker.get(worker);
}

export interface CreateCampaignSchedulerWorkerOptions {
  /**
   * Test-only, mirrors `partition-maintenance.worker.ts`'s/
   * `send-reconciler.worker.ts`'s identical option: BullMQ Workers start
   * processing immediately on construction; the scheduler-registration test
   * asserts what gets REGISTERED without wanting a real tick to race those
   * assertions against a live database. Omitted entirely from the
   * constructed worker's options unless a caller supplies it (G-12-1):
   * forwarding this key with an `undefined` value under the composition
   * root's one-argument call shape would overwrite BullMQ's own enabling
   * default rather than fall back to it, silently disabling the run loop.
   */
  autorun?: boolean;
}

/**
 * Constructs the repeatable campaign-scheduler Worker (CAMP-02): scans
 * `campaigns WHERE status='scheduled' AND scheduled_at<=now()` every
 * `SCAN_INTERVAL_MS` (60s), transitions each due campaign to `sending`, and
 * enqueues a `CAMPAIGN_KICKOFF` job with `jobId: campaignId` -- the SAME
 * deterministic id the launch route's immediate-launch enqueue uses
 * (`campaigns.routes.ts`), so a due campaign can never be double-kicked-off
 * regardless of which path (schedule vs. immediate launch) triggers it.
 * Self-healing/restart-safe by construction (RESEARCH.md): a worker
 * restart's next tick simply re-scans and re-picks any still-due campaign
 * -- there is no separate delayed-job state to lose.
 *
 * Phase 12 (WRK-13): the tick registration below migrated from the older
 * `tickQueue.add({repeat})` form to `queue.upsertJobScheduler(...)`, the
 * SAME `partition-maintenance.worker.ts`/`send-reconciler.worker.ts`/
 * `flow-segment-sweep.worker.ts` shape -- a stable scheduler id, an
 * immediate boot job, and a `try/catch/finally` that logs a failed
 * registration and always closes this file's own short-lived registration
 * `Queue` handle, so a transient Redis hiccup at boot can never become an
 * unhandled promise rejection that terminates every other registered
 * worker in the process.
 */
export function createCampaignSchedulerWorker(
  connection: ConnectionOptions,
  options: CreateCampaignSchedulerWorkerOptions = {}
): Worker {
  const queue = new Queue(CAMPAIGN_SCHEDULER_QUEUE, { connection });
  const bootJobId = `boot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  // Phase 12 (WRK-07): this queue is a genuinely long-lived PRODUCER, used on
  // EVERY tick to fan out kickoff jobs -- not a one-shot registration queue,
  // so it structurally cannot use the close-after-registration shape below.
  // It is deliberately left open here and instead registered with the
  // process-wide tracked-queue registry (`queue-registry.ts`) so
  // `server.ts`'s shutdown closes it. Do NOT "fix" this by closing it after
  // registration.
  const kickoffQueue = registerTrackedQueue(
    new Queue<CampaignKickoffJob>(CAMPAIGN_KICKOFF_QUEUE, {
      connection,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    })
  );

  const worker = new Worker(
    CAMPAIGN_SCHEDULER_QUEUE,
    wrapProcessor(CAMPAIGN_SCHEDULER_QUEUE, async () => {
      const dueCampaigns = await findDueCampaignCandidates();
      for (const row of dueCampaigns) {
        const transitioned = await transitionToSending(row);
        if (!transitioned) continue; // already handled by a prior tick -- skip re-kickoff
        await kickoffQueue.add("kickoff", { workspaceId: row.workspaceId, campaignId: row.id }, { jobId: row.id });
      }
    }),
    // G-12-1: the `autorun` key is included ONLY when a caller actually
    // supplied a value (mirrors `flow-segment-sweep.worker.ts`, which never
    // mentions the key at all) -- never nullish-coalesced to a restated
    // `true`, which would be a second source of truth for a value BullMQ
    // already owns. Under the composition root's single-argument call
    // shape, `options.autorun` is `undefined` and this spread contributes
    // nothing, leaving BullMQ's own default in effect.
    { connection, ...(options.autorun !== undefined ? { autorun: options.autorun } : {}) }
  );
  kickoffQueueByWorker.set(worker, kickoffQueue);

  // Fire-and-forget registration -- mirrors partition-maintenance.worker.ts's
  // try/catch/finally exactly: a Redis hiccup at boot must log, not crash
  // every other registered worker via an unhandled promise rejection; the
  // `finally` always closes this short-lived internal Queue handle so a
  // failure here never leaks a standalone Redis connection past construction.
  const registration = (async () => {
    try {
      await queue.upsertJobScheduler(
        JOB_SCHEDULER_ID,
        { every: SCAN_INTERVAL_MS },
        { name: JOB_NAME, opts: DEFAULT_JOB_OPTIONS }
      );
      await queue.add(JOB_NAME, {}, { ...DEFAULT_JOB_OPTIONS, jobId: bootJobId });

      // WRK-13 one-time cleanup: remove the legacy repeatable entry this
      // file's OLD registration form created. Tolerated not-found (a fresh
      // environment never had it) -- remove this block once every
      // environment has booted past this migration.
      await queue.removeRepeatable(LEGACY_JOB_NAME, { every: LEGACY_REPEAT_EVERY_MS }, LEGACY_JOB_ID);
    } catch (err) {
      scrubbedConsole.error("campaign-scheduler: scheduler registration failed", err);
    } finally {
      await queue.close().catch(() => undefined);
    }
  })();
  registrationSettled.set(worker, registration);

  return worker;
}
