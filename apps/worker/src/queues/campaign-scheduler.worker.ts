import { Queue, Worker, type ConnectionOptions } from "bullmq";
import { withCrossWorkspaceScan, withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { CAMPAIGN_KICKOFF_QUEUE, type CampaignKickoffJob } from "@mega-crm/shared-schemas";

/** The scheduler's own repeatable-tick queue -- self-produced and self-consumed within this file/process only. */
const CAMPAIGN_SCHEDULER_QUEUE = "campaign-scheduler";
const SCAN_INTERVAL_MS = 60_000;

const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential" as const, delay: 2000 },
  removeOnComplete: { age: 86400 },
  removeOnFail: false,
};

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
 */
export function createCampaignSchedulerWorker(connection: ConnectionOptions): Worker {
  const tickQueue = new Queue(CAMPAIGN_SCHEDULER_QUEUE, { connection });
  // Idempotent registration: BullMQ dedupes a repeatable job by its own
  // repeat config + jobId, so calling this on every worker boot never
  // creates a second competing repeatable schedule.
  void tickQueue.add("scan-due-campaigns", {}, { repeat: { every: SCAN_INTERVAL_MS }, jobId: "scan-due-campaigns" });

  const kickoffQueue = new Queue<CampaignKickoffJob>(CAMPAIGN_KICKOFF_QUEUE, {
    connection,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });

  return new Worker(
    CAMPAIGN_SCHEDULER_QUEUE,
    async () => {
      const dueCampaigns = await findDueCampaignCandidates();
      for (const row of dueCampaigns) {
        const transitioned = await transitionToSending(row);
        if (!transitioned) continue; // already handled by a prior tick -- skip re-kickoff
        await kickoffQueue.add("kickoff", { workspaceId: row.workspaceId, campaignId: row.id }, { jobId: row.id });
      }
    },
    { connection }
  );
}
