import { Queue, Worker, type ConnectionOptions } from "bullmq";
import type { PoolClient } from "pg";
import { withCrossWorkspaceScan, withTenant, withTenantTransaction } from "@mega-crm/tenant-context";

/** The reconciliation job's own repeatable-tick queue -- self-produced and self-consumed within this file/process only. */
const ANALYTICS_RECONCILE_QUEUE = "analytics-reconcile";
/** A few minutes, per D-08b's stated freshness bound for the "correctness backstop" path. */
const RECONCILE_INTERVAL_MS = 3 * 60_000;
/** Bounded recent window -- a rolling reconcile of "today" and "yesterday" (UTC) is enough to correct any drift from a crashed increment or a race without re-scanning a workspace's entire send history on every tick. */
const RECONCILE_WINDOW_DAYS = 2;

interface WorkspaceRow {
  id: string;
}

/**
 * Overwrites ONE (workspace, day) `workspace_daily_rollup` row from a fresh
 * `COUNT(*) FILTER (...)` scan of that workspace's `sends` (07-06, ANLT-04).
 * This is the correctness backstop -- and the SOLE writer of `sent_count`,
 * since the incremental webhook-driven path (`incrementWorkspaceDailyRollup`)
 * never sets it (a dispatched send produces no webhook event of its own).
 *
 * The `bounced_count` filter groups hard-bounce (`bounced_at`), address-drop
 * (`dropped_at`), and spam-report (`spam_reported_at`) terminals together --
 * mirroring the SAME D-08 grouping the webhook worker's incremental path
 * already applies to `bounced_count` (see `webhook-events.worker.ts`'s
 * `bounce_hard`/`bounce_soft`/`dropped`/`spam_report` cases) -- so this
 * reconciliation overwrite never silently REGRESSES a count the incremental
 * path had correctly raised.
 *
 * The `ON CONFLICT ... DO UPDATE SET <col> = EXCLUDED.<col>` is an ABSOLUTE
 * OVERWRITE from the fresh scan -- it must never add the existing stored
 * value to the freshly-computed one (that would be the additive bug
 * described in Pitfall 2). Running this twice with zero new sends must
 * leave every count byte-identical.
 */
export async function reconcileWorkspaceDay(client: PoolClient, workspaceId: string, day: string): Promise<void> {
  await client.query(
    `INSERT INTO workspace_daily_rollup (
       workspace_id, day, sent_count, delivered_count, opened_count,
       clicked_count, bounced_count, unsubscribed_count
     )
     SELECT
       $1, $2::date,
       count(*) FILTER (WHERE sent_at IS NOT NULL AND sent_at::date = $2::date),
       count(*) FILTER (WHERE delivered_at IS NOT NULL AND delivered_at::date = $2::date),
       count(*) FILTER (WHERE first_opened_at IS NOT NULL AND first_opened_at::date = $2::date),
       count(*) FILTER (WHERE first_clicked_at IS NOT NULL AND first_clicked_at::date = $2::date),
       count(*) FILTER (
         WHERE (bounced_at IS NOT NULL AND bounced_at::date = $2::date)
            OR (dropped_at IS NOT NULL AND dropped_at::date = $2::date)
            OR (spam_reported_at IS NOT NULL AND spam_reported_at::date = $2::date)
       ),
       count(*) FILTER (WHERE unsubscribed_at IS NOT NULL AND unsubscribed_at::date = $2::date)
     FROM sends
     WHERE workspace_id = $1
     ON CONFLICT (workspace_id, day) DO UPDATE SET
       sent_count = EXCLUDED.sent_count,
       delivered_count = EXCLUDED.delivered_count,
       opened_count = EXCLUDED.opened_count,
       clicked_count = EXCLUDED.clicked_count,
       bounced_count = EXCLUDED.bounced_count,
       unsubscribed_count = EXCLUDED.unsubscribed_count`,
    [workspaceId, day]
  );
}

/** The last `windowDays` UTC calendar days (today first), as `YYYY-MM-DD` strings. */
function recentDays(windowDays: number): string[] {
  const now = new Date();
  const days: string[] = [];
  for (let i = 0; i < windowDays; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

/**
 * Reconciles one workspace's bounded recent window inside a FRESH
 * `withTenant`/`withTenantTransaction` scope (Pitfall 5) -- every workspace
 * gets its own transaction/GUC; never shared across two workspace ids.
 */
async function reconcileWorkspace(workspaceId: string, windowDays: number): Promise<void> {
  const days = recentDays(windowDays);
  await withTenant(workspaceId, () =>
    withTenantTransaction(async (client) => {
      for (const day of days) {
        await reconcileWorkspaceDay(client, workspaceId, day);
      }
    })
  );
}

/**
 * Constructs the repeatable analytics-reconciliation Worker (07-06, ANLT-04;
 * Phase 10 SEC-01/SEC-02, D-01/D-02): enumerates known workspaces via
 * `SELECT id FROM organization`, read through `withCrossWorkspaceScan` on
 * the dedicated `mega_crm_scan` login role -- the SAME single audited
 * cross-workspace read entry point every other cross-tenant discovery scan
 * in this codebase now uses, regardless of how sensitive the underlying
 * data is. `organization` carries no RLS of its own (it is the top-level
 * tenant identity table), so migration 0042 grants SELECT on it with no
 * accompanying policy; the boundary that matters here is role identity, not
 * a per-table predicate. Reconciles each workspace's recent window from a
 * fresh scan of its own `sends`, overwriting (never adding to) the
 * incrementally-maintained rollup rows. Self-healing/restart-safe by
 * construction, mirroring `createCampaignSchedulerWorker`'s repeatable-tick
 * shape: a worker restart's next tick simply re-scans and re-corrects, with
 * no separate delayed-job state to lose.
 */
export function createAnalyticsReconciliationWorker(connection: ConnectionOptions): Worker {
  const tickQueue = new Queue(ANALYTICS_RECONCILE_QUEUE, { connection });
  // Idempotent registration: BullMQ dedupes a repeatable job by its own
  // repeat config + jobId, so calling this on every worker boot never
  // creates a second competing repeatable schedule.
  void tickQueue.add(
    "reconcile-rollups",
    {},
    { repeat: { every: RECONCILE_INTERVAL_MS }, jobId: "reconcile-rollups" }
  );

  return new Worker(
    ANALYTICS_RECONCILE_QUEUE,
    async () => {
      const rows = await withCrossWorkspaceScan(async (client) => {
        const { rows: workspaceRows } = await client.query<WorkspaceRow>(`SELECT id FROM organization`);
        return workspaceRows;
      });
      for (const row of rows) {
        await reconcileWorkspace(row.id, RECONCILE_WINDOW_DAYS);
      }
    },
    { connection }
  );
}
