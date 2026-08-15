import { Queue, Worker, type ConnectionOptions } from "bullmq";
import { pool, withCrossWorkspaceScan, withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { scrubbedConsole } from "@mega-crm/redaction";
import { recordReconcilerRun } from "@mega-crm/db/src/reconciler/reconciler-run.js";
import { buildJobOptions, STANDARD_JOB_RETENTION } from "@mega-crm/queue-core";
import {
  SEND_RECONCILER_QUEUE,
  SEND_RECONCILER_TICK_SCHEMA_VERSION,
  sendReconcilerTickJobSchema,
} from "@mega-crm/shared-schemas";
import { wrapProcessor } from "../processor-wrapper.js";
import {
  classifyReconcilableSend,
  resolveReconcilingSend,
  sweepStaleDispatchingSend,
  backfillCampaignSendCounter,
  tryCompleteCampaign,
  STALE_DISPATCHING_AGE_MS,
  RECONCILE_RESCAN_HORIZON_MS,
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
 *
 * 11-09 (D-14) update to the paragraph above: `send_reconciler_runs` IS a
 * platform-level table (no `workspace_id`, no RLS -- migration 0050's own
 * header), so its health-row write below uses the SAME shared
 * `@mega-crm/tenant-context` pool directly, UNSCOPED (no `withTenant`) --
 * still not a second, dedicated `Pool` construction, just the plain form of
 * the one this file already imports for every tenant-scoped write.
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
 * Built through the shared `@mega-crm/queue-core` factory (Phase 12,
 * WRK-11, D-10) -- `STANDARD_JOB_RETENTION`'s bounded failed-job retention
 * (WRK-09, `FAILED_JOB_RETENTION_SECONDS`, 7 days) matters here too: a
 * reconciler tick that throws remains inspectable in Redis for a full
 * working week, not forever, and the durable `dead_letter_jobs` row is the
 * terminal record beyond that.
 */
const DEFAULT_JOB_OPTIONS = buildJobOptions(STANDARD_JOB_RETENTION);

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
 * on: `reconciling` rows (D-03, deliberately UNBOUNDED by age -- ageing out
 * of `reconciling` into `unknown` is itself a verdict this worker must
 * still be able to issue, `resolve_unknown`), `unknown` rows bounded by
 * `RECONCILE_RESCAN_HORIZON_MS` (D-04, code review CR-01: a row past its
 * 72h re-scan horizon can only ever classify to `hold` in
 * `classifyReconcilableSend` -- see that function's own `queuedAt` age
 * check -- so this discovery query must stop selecting it, or a growing
 * backlog of such permanently-inert rows eventually fills every tick's
 * `RECONCILER_BATCH_LIMIT` and starves out genuinely fresh `reconciling`
 * rows forever), and stale-`dispatching` rows (D-08, the age bound passed
 * as `$1`). Both age bounds are passed as bound bigint parameters -- NEVER
 * interpolated into the SQL string, so neither value can ever become a SQL
 * injection surface or a query-plan-cache-busting literal. The `unknown`
 * bound uses `queued_at`, the SAME column `classifyReconcilableSend` itself
 * compares against for that branch (`reconciler.ts`'s `unknown -> sent`
 * check) -- using any other column here would make discovery and
 * classification disagree at the horizon boundary. SELECT-list is every
 * field `classifyReconcilableSend` needs EXCEPT `hasEvidence`, which cannot
 * be read here: `mega_crm_scan` holds no grant on `send_events` (migration
 * 0042), so evidence classification belongs entirely to the per-tenant step
 * below.
 */
export async function findReconcilableCandidates(batchLimit?: number): Promise<ReconcilableCandidateRow[]> {
  const { candidates } = await discoverReconcilableCandidatesWithOldestReconciling(batchLimit);
  return candidates;
}

export interface ReconcilableDiscovery {
  candidates: ReconcilableCandidateRow[];
  /** The earliest `reconciling_since` observed, across ALL workspaces, among rows still `reconciling` -- `null` when none exist. Observed at DISCOVERY time (before this tick resolves anything), per D-14's own "oldest outstanding ... it observed" phrasing -- not re-queried after resolution. */
  oldestReconcilingSince: Date | null;
}

/**
 * 11-09 (D-14): the SAME discovery query `findReconcilableCandidates` runs,
 * plus the `MIN(reconciling_since)` aggregate the health row's own
 * `oldest_reconciling_since` column needs -- both issued against the SAME
 * client inside ONE `withCrossWorkspaceScan` call, so writing the health row
 * adds no second scan-role round trip. `findReconcilableCandidates` (above)
 * delegates to this for its own unchanged candidates-only contract, so the
 * discovery SQL exists in exactly one place.
 *
 * `batchLimit` defaults to `RECONCILER_BATCH_LIMIT` (500) for every
 * production call site (`runReconcilerTick`, `findReconcilableCandidates`
 * called with no argument). It is overridable ONLY so
 * `send-reconciler-verdicts.test.ts`'s starvation regression (code review
 * CR-01) can reproduce "more past-horizon `unknown` rows than the batch
 * admits, alongside a fresh `reconciling` row" without actually seeding
 * 500+ rows per test run -- the production default never changes.
 */
async function discoverReconcilableCandidatesWithOldestReconciling(
  batchLimit: number = RECONCILER_BATCH_LIMIT
): Promise<ReconcilableDiscovery> {
  return withCrossWorkspaceScan(async (client) => {
    const { rows } = await client.query<ReconcilableCandidateRow>(
      `SELECT id, workspace_id AS "workspaceId", campaign_id AS "campaignId", kind, status,
              queued_at AS "queuedAt", reconciling_since AS "reconcilingSince"
       FROM sends
       WHERE status = 'reconciling'
          OR (status = 'unknown' AND queued_at >= now() - ($2::bigint * INTERVAL '1 millisecond'))
          OR (status = 'dispatching' AND queued_at < now() - ($1::bigint * INTERVAL '1 millisecond'))
       ORDER BY queued_at
       LIMIT $3`,
      [STALE_DISPATCHING_AGE_MS, RECONCILE_RESCAN_HORIZON_MS, batchLimit]
    );
    const { rows: oldestRows } = await client.query<{ oldestReconcilingSince: Date | null }>(
      `SELECT MIN(reconciling_since) AS "oldestReconcilingSince" FROM sends WHERE status = 'reconciling'`
    );
    return { candidates: rows, oldestReconcilingSince: oldestRows[0]?.oldestReconcilingSince ?? null };
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
 * Returns per-verdict counts: `scanned` is the candidate-row count this pass
 * discovered (bounded by `RECONCILER_BATCH_LIMIT`); `resolvedSent`/
 * `markedUnknown`/`swept` count only ACTUAL transitions (`resolved: true`),
 * never attempted-but-lost-the-race claims. Logs the same four counts via
 * `scrubbedConsole` -- counts only, never send ids, contact ids, workspace
 * ids, or addresses.
 *
 * 11-09 (D-14): writes the `send_reconciler_runs` health row LAST, after the
 * candidate loop completes, via the plain (unscoped) shared
 * `@mega-crm/tenant-context` pool -- this table is platform-level, not
 * tenant-scoped (see this file's own header comment). Deliberately no
 * try/catch around the loop or the write: an unhandled throw ANYWHERE above
 * -- discovery, a single `resolveOneSend` call -- skips the write entirely,
 * so a run that did not finish never reports itself alive (T-11-09-04). This
 * matches `processPartitionMaintenance`'s own precedent (no try/catch: an
 * unhandled throw is what puts the BullMQ job in the failed set).
 *
 * `options.batchLimit` mirrors `discoverReconcilableCandidatesWithOldestReconciling`'s
 * own override -- test-only (code review CR-01's starvation regression),
 * defaults to `RECONCILER_BATCH_LIMIT` for every production call
 * (`createSendReconcilerWorker`'s processor calls this with no argument).
 */
export async function runReconcilerTick(options: { batchLimit?: number } = {}): Promise<{
  scanned: number;
  resolvedSent: number;
  markedUnknown: number;
  swept: number;
}> {
  const { candidates, oldestReconcilingSince } = await discoverReconcilableCandidatesWithOldestReconciling(
    options.batchLimit
  );
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

  await recordReconcilerRun(pool, {
    lastRunAt: new Date(),
    candidatesScanned: summary.scanned,
    rowsResolved: summary.resolvedSent,
    rowsMarkedUnknown: summary.markedUnknown,
    staleDispatchingSwept: summary.swept,
    oldestReconcilingSince,
  });

  return summary;
}

export interface CreateSendReconcilerWorkerOptions {
  /**
   * Test-only, mirrors `partition-maintenance.worker.ts`'s identical
   * option: BullMQ Workers start processing immediately on construction;
   * tests assert what gets REGISTERED without wanting a real tick to race
   * those assertions. Omitted entirely from the constructed worker's
   * options unless a caller supplies it (G-12-1): forwarding this key with
   * an `undefined` value under the composition root's one-argument call
   * shape would overwrite BullMQ's own enabling default rather than fall
   * back to it, silently disabling the run loop.
   */
  autorun?: boolean;
}

/**
 * Test-only synchronization, mirrors `partition-maintenance.worker.ts`'s and
 * `campaign-scheduler.worker.ts`'s identical WeakMap:
 * `createSendReconcilerWorker`'s own scheduler registration (and the
 * short-lived internal `Queue` handle it runs through) is fire-and-forget in
 * production. This lets `waitForSendReconcilerRegistration` below hand a
 * test a promise that resolves only once registration (including closing
 * that internal handle) has actually settled, instead of sleeping -- without
 * it, a test that constructs this factory has no deterministic point at
 * which the factory's background Redis handle is finished, and its own
 * `queue.close()` races the throwaway Redis server's teardown.
 */
const registrationSettled = new WeakMap<Worker, Promise<void>>();

/**
 * Test-only: resolves once the `Worker` returned by
 * `createSendReconcilerWorker` has finished registering its scheduler (and
 * closed its own internal tick-registration `Queue` handle). Not used by
 * production code, mirrors `partition-maintenance.worker.ts`'s identical
 * helper. Resolves immediately (rather than hanging) for a worker this
 * module never registered a promise against.
 */
export function waitForSendReconcilerRegistration(worker: Worker): Promise<void> {
  return registrationSettled.get(worker) ?? Promise.resolve();
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
    wrapProcessor(SEND_RECONCILER_QUEUE, async (job) => {
      const parsed = sendReconcilerTickJobSchema.safeParse(job.data);
      if (!parsed.success) {
        scrubbedConsole.error("send-reconciler: deferring job with an unrecognized payload shape", {
          jobId: job.id,
        });
        return;
      }
      await runReconcilerTick();
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

  // Fire-and-forget registration -- copied in shape from
  // partition-maintenance.worker.ts's try/catch/finally exactly (T-11-03-07):
  // a Redis hiccup at boot must log, not crash every other registered
  // worker via an unhandled promise rejection; the `finally` always closes
  // this short-lived internal Queue handle so a failure here never leaks a
  // standalone Redis connection past construction. Captured into a named
  // promise (rather than launched as a bare `void` expression) and stored
  // against the worker so `waitForSendReconcilerRegistration` can hand a
  // test a deterministic settle point (see that function's own comment).
  const registration = (async () => {
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
  registrationSettled.set(worker, registration);

  return worker;
}
