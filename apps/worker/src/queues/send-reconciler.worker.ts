import { Queue, Worker, type ConnectionOptions } from "bullmq";
import { withCrossWorkspaceScan, withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { scrubbedConsole } from "@mega-crm/redaction";
import {
  SEND_RECONCILER_QUEUE,
  SEND_RECONCILER_TICK_SCHEMA_VERSION,
  sendReconcilerTickJobSchema,
} from "@mega-crm/shared-schemas";
import {
  classifyReconcilableSend,
  resolveReconcilingSend,
  sweepStaleDispatchingSend,
  backfillCampaignSendCounter,
  tryCompleteCampaign,
  STALE_DISPATCHING_AGE_MS,
  type SendStatus,
} from "@mega-crm/delivery-core";

/**
 * Phase 11 (DLV-03/DLV-04, plans 11-03 through 11-08) -- the
 * classification-only reconciler tick. An ambiguous send lands in
 * `reconciling` (send-dispatch.ts's ambiguous-throw/interrupted-redelivery
 * branches), or a `dispatching` row is orphaned by a lost Redis job; this
 * worker discovers every such candidate across workspaces, claims it
 * exclusively per-tenant, and classifies it via
 * `classifyReconcilableSend` (`@mega-crm/delivery-core`) into ONE of the
 * four verdicts ARCHITECTURE.md ##9's writer matrix names for this
 * component: `resolve_sent`, `resolve_unknown`, `sweep_to_reconciling`, or
 * `hold`. `resolveReconcilingSend`/`sweepStaleDispatchingSend`
 * (`packages/delivery-core/src/send-ledger.ts`) are the sole audited exits
 * from `reconciling`/`unknown`/stale-`dispatching` (D-03/D-08) -- this file
 * never writes a status onto the `sends` table directly: every write goes
 * through one of those two audited ledger functions, never a bare UPDATE of
 * this file's own.
 *
 * D-01/D-05 (locked): this worker NEVER calls SendGrid, or any provider
 * send API, for a row it is resolving -- it classifies PURELY from webhook
 * evidence already on disk (`send_events`, correlated by `send_id`).
 *
 * Deliberately has NO dedicated `Pool` of its own (unlike
 * `partition-maintenance.worker.ts`, which needs one because its
 * maintenance work is platform-level, not tenant-scoped): every per-tenant
 * write this file performs goes through `withTenant`/`withTenantTransaction`
 * -- the SAME shared pool `@mega-crm/tenant-context` already manages for
 * every other tenant-scoped write in this process. A future reader must NOT
 * "fix" this by copying `partition-maintenance.worker.ts`'s dedicated-pool
 * block -- there is nothing here that needs one.
 */

/**
 * D-16: ~5 min cadence -- frequent enough that a `reconciling` row does not
 * sit unresolved for long, infrequent enough that a bounded batch per tick
 * is a light scan, not a hot loop.
 */
export const RECONCILER_TICK_MS = 5 * 60_000;

/**
 * T-11-03-05: bounded work per tick so one backlogged workspace's
 * `reconciling`/`unknown`/stale-`dispatching` backlog can never monopolise a
 * single tick's scan/claim work; `sends_status_queued_at_idx` (11-02) keeps
 * this scan index-backed for every branch of the discovery predicate below.
 */
export const RECONCILER_BATCH_LIMIT = 500;

/**
 * The stable id `upsertJobScheduler` dedupes by -- constant across every
 * boot (mirrors `partition-maintenance.worker.ts`'s `JOB_SCHEDULER_ID`), so
 * registering it on every worker boot never creates a second competing
 * schedule.
 */
export const SEND_RECONCILER_SCHEDULER_ID = "send-reconciler-tick";

const JOB_NAME = "run-send-reconciler-tick";

/**
 * Same block as the other 9 job-options sites in this codebase (see
 * SPECIFICATION.md §5.3) -- `removeOnFail: false` matters here too: a
 * reconciler tick that throws must remain inspectable in Redis, not vanish.
 */
const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential" as const, delay: 2000 },
  removeOnComplete: { age: 86400 },
  removeOnFail: false,
};

export interface ReconcilableCandidateRow {
  id: string;
  workspaceId: string;
  campaignId: string | null;
  kind: string;
  status: SendStatus;
  queuedAt: Date;
  reconcilingSince: Date | null;
}

/**
 * Admin-side DISCOVERY scan (RESEARCH.md Pattern 1, mirrors
 * `flow-reconciliation.worker.ts`'s `findDueFlowRunCandidates` line-for-line):
 * runs on the dedicated `mega_crm_scan` role via `withCrossWorkspaceScan` --
 * this scan doesn't know which workspace a candidate row belongs to until it
 * reads one, so it can never go through `withTenant`/`withTenantTransaction`.
 * Deliberately NOT `FOR UPDATE`: the row-level lock for the actual
 * resolution happens per-tenant, in `resolveOneSend` below.
 *
 * The predicate covers every candidate `classifyReconcilableSend` can act
 * on: `reconciling`/`unknown` rows (D-03/D-04) and stale-`dispatching` rows
 * (D-08, the age bound passed as `$1`, a bound bigint parameter -- NEVER
 * interpolated into the SQL string, so the value can never become a SQL
 * injection surface or a query-plan-cache-busting literal). SELECT-list is
 * every field `classifyReconcilableSend` needs EXCEPT `hasEvidence`, which
 * cannot be read here: `mega_crm_scan` holds no grant on `send_events`
 * (migration 0042), so evidence classification belongs entirely to the
 * per-tenant step below.
 */
export async function findReconcilableCandidates(): Promise<ReconcilableCandidateRow[]> {
  return withCrossWorkspaceScan(async (client) => {
    const { rows } = await client.query<ReconcilableCandidateRow>(
      `SELECT id, workspace_id AS "workspaceId", campaign_id AS "campaignId", kind, status,
              queued_at AS "queuedAt", reconciling_since AS "reconcilingSince"
       FROM sends
       WHERE status IN ('reconciling', 'unknown')
          OR (status = 'dispatching' AND queued_at < now() - ($1::bigint * INTERVAL '1 millisecond'))
       ORDER BY queued_at
       LIMIT ${RECONCILER_BATCH_LIMIT}`,
      [STALE_DISPATCHING_AGE_MS]
    );
    return rows;
  });
}

/** The outcome `resolveOneSend` reports for a single candidate, for `runReconcilerTick` to tally per-verdict counts. */
export type ResolveOneSendOutcome =
  | { kind: "resolve_sent"; resolved: boolean }
  | { kind: "resolve_unknown"; resolved: boolean }
  | { kind: "sweep_to_reconciling"; resolved: boolean }
  | { kind: "hold" };

/**
 * Per-tenant exclusive claim + full verdict classification (RESEARCH.md
 * Pattern 1/2, DLV-03/DLV-04, plan 11-08): re-scopes via
 * `withTenant`/`withTenantTransaction` and re-locks the row `SELECT ... FOR
 * UPDATE SKIP LOCKED` -- a concurrent reconciler pass racing for the SAME
 * row observes zero claimable rows and returns `{ kind: "hold" }` rather
 * than blocking (the reconciler-vs-reconciler half of DLV-04's exclusivity
 * guarantee; the retry-worker half is closed by `dispatchSendGate`/
 * `claimFlowSend`'s fourth status branch, not by this lock).
 *
 * One transaction performs AT MOST ONE status transition -- a swept row is
 * NOT re-classified in the same transaction; it resolves on a later tick
 * through the normal `reconciling` evidence path, keeping this function's
 * shape simple and its lock hold time short.
 *
 * Evidence is read from `send_events` ONLY inside this per-tenant
 * transaction -- the discovery scan's role has no grant on that table
 * (migration 0042 re-confirmed).
 */
export async function resolveOneSend(row: ReconcilableCandidateRow): Promise<ResolveOneSendOutcome> {
  return withTenant(row.workspaceId, () =>
    withTenantTransaction(async (client) => {
      const { rows } = await client.query<{
        id: string;
        campaignId: string | null;
        kind: string;
        status: SendStatus;
        queuedAt: Date;
        reconcilingSince: Date | null;
      }>(
        `SELECT id, campaign_id AS "campaignId", kind, status, queued_at AS "queuedAt",
                reconciling_since AS "reconcilingSince"
         FROM sends WHERE id = $1 AND status IN ('reconciling', 'unknown', 'dispatching')
         FOR UPDATE SKIP LOCKED`,
        [row.id]
      );
      if (rows.length === 0) {
        // Already claimed by a concurrent tick, or resolved/swept since discovery.
        return { kind: "hold" };
      }
      const liveRow = rows[0];

      const { rows: evidenceRows } = await client.query(`SELECT 1 FROM send_events WHERE send_id = $1 LIMIT 1`, [
        liveRow.id,
      ]);
      const hasEvidence = evidenceRows.length > 0;

      const verdict = classifyReconcilableSend({
        status: liveRow.status,
        queuedAt: liveRow.queuedAt,
        reconcilingSince: liveRow.reconcilingSince,
        hasEvidence,
        now: new Date(),
      });

      switch (verdict.kind) {
        case "resolve_sent": {
          const { resolved } = await resolveReconcilingSend(client, liveRow.id, { kind: "resolve_sent" });
          // A flow-kind send (null campaignId) never touches a campaign
          // counter or completion check -- there is no campaign to update.
          if (resolved && liveRow.campaignId) {
            await backfillCampaignSendCounter(client, liveRow.campaignId, "sent");
            await tryCompleteCampaign(client, liveRow.campaignId);
          }
          return { kind: "resolve_sent", resolved };
        }
        case "resolve_unknown": {
          const { resolved } = await resolveReconcilingSend(client, liveRow.id, { kind: "resolve_unknown" });
          // No counter touched -- resolving to unknown is not a terminal
          // outcome the campaign's sent_count/failed_count ever reflects
          // (D-13: rollups/counters exclude unknown by construction).
          return { kind: "resolve_unknown", resolved };
        }
        case "sweep_to_reconciling": {
          const { resolved } = await sweepStaleDispatchingSend(client, liveRow.id);
          return { kind: "sweep_to_reconciling", resolved };
        }
        case "hold":
        default:
          return { kind: "hold" };
      }
    })
  );
}

/**
 * Discovery + per-tenant resolution, once (RESEARCH.md Pattern 1). Exported
 * standalone (mirrors `flow-reconciliation.worker.ts`'s own exported
 * discovery/claim functions) so the reconciler test suite can drive a full
 * tick directly, without a live BullMQ `Worker`.
 *
 * Returns per-verdict counts (D-14's future health row is a straightforward
 * consumer of exactly this shape, not built in this plan): `scanned` is the
 * candidate-row count this pass discovered (bounded by
 * `RECONCILER_BATCH_LIMIT`); `resolvedSent`/`markedUnknown`/`swept` count
 * only ACTUAL transitions (`resolved: true`), never attempted-but-lost-the-
 * race claims. Logs the same four counts via `scrubbedConsole` -- counts
 * only, never send ids, contact ids, workspace ids, or addresses.
 */
export async function runReconcilerTick(): Promise<{
  scanned: number;
  resolvedSent: number;
  markedUnknown: number;
  swept: number;
}> {
  const candidates = await findReconcilableCandidates();
  let resolvedSent = 0;
  let markedUnknown = 0;
  let swept = 0;

  for (const row of candidates) {
    const outcome = await resolveOneSend(row);
    if (outcome.kind === "resolve_sent" && outcome.resolved) {
      resolvedSent += 1;
    } else if (outcome.kind === "resolve_unknown" && outcome.resolved) {
      markedUnknown += 1;
    } else if (outcome.kind === "sweep_to_reconciling" && outcome.resolved) {
      swept += 1;
    }
  }

  const summary = { scanned: candidates.length, resolvedSent, markedUnknown, swept };
  scrubbedConsole.log("send-reconciler: tick complete", summary);
  return summary;
}

export interface CreateSendReconcilerWorkerOptions {
  /**
   * Test-only, mirrors `partition-maintenance.worker.ts`'s identical
   * option: BullMQ Workers start processing immediately on construction;
   * tests assert what gets REGISTERED without wanting a real tick to race
   * those assertions. Always left at BullMQ's own default (`true`) in
   * production.
   */
  autorun?: boolean;
}

/**
 * Constructs the repeatable send-reconciler Worker (DLV-03): registers the
 * ~5min job-scheduler tick (idempotent by `SEND_RECONCILER_SCHEDULER_ID`)
 * and processes each tick by validating the job payload against
 * `sendReconcilerTickJobSchema` (R-05) BEFORE ever calling
 * `runReconcilerTick` -- a `schemaVersion` this worker does not recognize is
 * DEFERRED (logged via `scrubbedConsole`, the processor returns without
 * processing) rather than best-effort-processed, so a rolling deploy can
 * never have an old- or new-code worker treat a payload shape it wasn't
 * built for as the one it expects. Never throws on a version mismatch -- a
 * deferred payload must not consume one of the job's BullMQ `attempts`.
 */
export function createSendReconcilerWorker(
  connection: ConnectionOptions,
  options: CreateSendReconcilerWorkerOptions = {}
): Worker {
  const queue = new Queue(SEND_RECONCILER_QUEUE, { connection });

  const worker = new Worker(
    SEND_RECONCILER_QUEUE,
    async (job) => {
      const parsed = sendReconcilerTickJobSchema.safeParse(job.data);
      if (!parsed.success) {
        scrubbedConsole.error("send-reconciler: deferring job with an unrecognized payload shape", {
          jobId: job.id,
        });
        return;
      }
      await runReconcilerTick();
    },
    { connection, autorun: options.autorun }
  );

  // Fire-and-forget registration -- copied in shape from
  // partition-maintenance.worker.ts's try/catch/finally exactly (T-11-03-07):
  // a Redis hiccup at boot must log, not crash every other registered
  // worker via an unhandled promise rejection; the `finally` always closes
  // this short-lived internal Queue handle so a failure here never leaks a
  // standalone Redis connection past construction.
  void (async () => {
    try {
      await queue.upsertJobScheduler(
        SEND_RECONCILER_SCHEDULER_ID,
        { every: RECONCILER_TICK_MS },
        {
          name: JOB_NAME,
          data: { schemaVersion: SEND_RECONCILER_TICK_SCHEMA_VERSION },
          opts: DEFAULT_JOB_OPTIONS,
        }
      );
    } catch (err) {
      scrubbedConsole.error("send-reconciler: scheduler registration failed", err);
    } finally {
      await queue.close().catch(() => undefined);
    }
  })();

  return worker;
}
