import { Queue, Worker, type ConnectionOptions } from "bullmq";
import { withCrossWorkspaceScan, withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { scrubbedConsole } from "@mega-crm/redaction";
import {
  SEND_RECONCILER_QUEUE,
  SEND_RECONCILER_TICK_SCHEMA_VERSION,
  sendReconcilerTickJobSchema,
} from "@mega-crm/shared-schemas";
import { resolveReconcilingSend } from "@mega-crm/delivery-core";

/**
 * Phase 11 (DLV-03, plan 11-03) -- the classification-only reconciler tick,
 * the one path this phase proves end to end: an interrupted send lands in
 * `reconciling` (send-dispatch.ts), this worker discovers it across
 * workspaces, claims it exclusively per-tenant, and resolves it to `sent`
 * from webhook evidence already on disk. `resolveReconcilingSend`
 * (`packages/delivery-core/src/send-ledger.ts`) is the sole audited exit
 * from `reconciling`/`unknown` (D-03) -- this file never writes
 * `sends.status` directly.
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
 * `reconciling` backlog can never monopolise a single tick's scan/claim
 * work; `sends_status_queued_at_idx` (11-02) keeps this scan index-backed.
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
}

/**
 * Admin-side DISCOVERY scan (RESEARCH.md Pattern 1, mirrors
 * `flow-reconciliation.worker.ts`'s `findDueFlowRunCandidates` line-for-line):
 * runs on the dedicated `mega_crm_scan` role via `withCrossWorkspaceScan` --
 * this scan doesn't know which workspace a `reconciling` send belongs to
 * until it reads one, so it can never go through
 * `withTenant`/`withTenantTransaction`. Deliberately NOT `FOR UPDATE`: the
 * row-level lock for the actual resolution happens per-tenant, in
 * `resolveOneSend` below. Only columns on `sends` may be read here --
 * `mega_crm_scan` holds no grant on `send_events` (migration 0042), so
 * evidence classification belongs entirely to the per-tenant step.
 */
export async function findReconcilableCandidates(): Promise<ReconcilableCandidateRow[]> {
  return withCrossWorkspaceScan(async (client) => {
    const { rows } = await client.query<ReconcilableCandidateRow>(
      `SELECT id, workspace_id AS "workspaceId" FROM sends
       WHERE status = 'reconciling'
       ORDER BY queued_at
       LIMIT ${RECONCILER_BATCH_LIMIT}`
    );
    return rows;
  });
}

/**
 * Per-tenant exclusive claim + evidence classification (RESEARCH.md Pattern
 * 1/2, DLV-04): re-scopes via `withTenant`/`withTenantTransaction` and
 * re-locks the row `SELECT ... FOR UPDATE SKIP LOCKED` -- a concurrent
 * reconciler pass racing for the SAME row observes zero claimable rows and
 * returns `false` rather than blocking (this is the reconciler-vs-reconciler
 * half of DLV-04's exclusivity guarantee; the retry-worker half is closed by
 * `dispatchSendGate`/`claimFlowSend`'s fourth status branch, not by this
 * lock). Evidence is read from `send_events` ONLY inside this per-tenant
 * transaction -- the discovery scan's role has no grant on that table. If
 * evidence exists, resolves to `sent` via `resolveReconcilingSend` (the sole
 * audited exit from `reconciling`, D-03) and returns whether that write
 * actually landed; otherwise leaves the row untouched in `reconciling` and
 * returns `false` -- resolving a no-evidence row to `unknown` is 11-07's
 * expansion of this same function, and this slice must not guess.
 */
export async function resolveOneSend(row: ReconcilableCandidateRow): Promise<boolean> {
  return withTenant(row.workspaceId, () =>
    withTenantTransaction(async (client) => {
      const { rows } = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM sends WHERE id = $1 AND status = 'reconciling' FOR UPDATE SKIP LOCKED`,
        [row.id]
      );
      if (rows.length === 0) {
        // Already claimed by a concurrent tick, or resolved since discovery.
        return false;
      }

      const { rows: evidenceRows } = await client.query(`SELECT 1 FROM send_events WHERE send_id = $1 LIMIT 1`, [
        row.id,
      ]);
      if (evidenceRows.length === 0) {
        // No webhook evidence yet -- leave it in 'reconciling'. D-05: the
        // reconciler makes NO provider call to find out more; D-01: only
        // resolveReconcilingSend may leave this state, and only on evidence.
        return false;
      }

      const { resolved } = await resolveReconcilingSend(client, row.id, { status: "sent" });
      return resolved;
    })
  );
}

/**
 * Discovery + per-tenant resolution, once (RESEARCH.md Pattern 1). Exported
 * standalone (mirrors `flow-reconciliation.worker.ts`'s own exported
 * discovery/claim functions) so `send-reconciler-tracer.test.ts` can drive a
 * full tick directly, without a live BullMQ `Worker`.
 */
export async function runReconcilerTick(): Promise<{ scanned: number; resolved: number }> {
  const candidates = await findReconcilableCandidates();
  let resolved = 0;
  for (const row of candidates) {
    if (await resolveOneSend(row)) {
      resolved += 1;
    }
  }
  return { scanned: candidates.length, resolved };
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
