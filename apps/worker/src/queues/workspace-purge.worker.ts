import { Queue, Worker, type ConnectionOptions } from "bullmq";
import type { Pool, PoolClient } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { buildJobOptions, buildRedisConnectionOptions, STANDARD_JOB_RETENTION } from "@mega-crm/queue-core";
import type { BuiltJobOptions } from "@mega-crm/queue-core";
import {
  createPgPool,
  PURGE_ADVISORY_LOCK_NAMESPACE,
  PURGE_BATCH_SIZE,
  PURGE_TABLE_ORDER,
  countPurgeTableRows,
  deletePurgeBatch as deletePurgeBatchDefault,
  type PurgeTable,
} from "@mega-crm/db";
import { wrapProcessor } from "../processor-wrapper.js";
import { logger } from "../logger.js";
import { workerEnv } from "../env.js";
import {
  advanceWorkspacePurgeCheckpoint,
  loadWorkspacePurgeProgress,
  markPurgeTableDone,
  recordAuthPurgeCounts,
} from "./workspace-purge-checkpoint.js";
import { countWorkspaceAuthRows, deleteWorkspaceAuthRows, type WorkspaceAuthPurgeCounts } from "./workspace-purge-auth.js";

/**
 * Phase 22 (PRG-01/PRG-02/PRG-03/PRG-05, D-05/D-07/D-09/D-14, plan 22-01):
 * the tracer's whole state machine -- discover, report, destroy in FK order,
 * tombstone. Read `apps/worker/src/queues/erasure-scrub.worker.ts` and
 * `packages/db/src/partitions/relocate-default.ts` before touching this
 * file; the mark-failed-then-rethrow discipline and the batched
 * `FOR UPDATE SKIP LOCKED` shape are copied from those two, not reinvented.
 *
 * `processWorkspacePurge` runs one tick in a fixed order -- this ordering IS
 * the D-07 announce-then-act guarantee:
 *
 *   (a) DESTRUCTIVE PHASE FIRST. For every `purge_records` row whose status
 *       is `reported` or `purging`, walk it. Because reporting happens
 *       AFTER this step within the same tick, a workspace reported in tick
 *       N cannot be destroyed until tick N+1 -- there is no timestamp
 *       comparison to get wrong, the ordering itself is the guarantee.
 *   (b) REPORTING PHASE SECOND. For every eligible workspace with no
 *       `purge_records` row yet, insert one with the pre-destruction
 *       per-table census and move it to `reported`.
 *
 * THE DESTRUCTIVE SELECTOR (`loadDestructiblePurgeRecords` below) matches
 * `reported` AND `purging` ONLY -- never `failed`. Do not widen this. A
 * `failed` record is a TERMINAL state for automation and a RESUMABLE state
 * for a human: the only way a failed purge continues is an operator issuing
 * `UPDATE purge_records SET status = 'purging', purge_error = NULL WHERE
 * workspace_id = $1` directly. Once returned, the next tick resumes from
 * `completed_tables` exactly as an interrupted purge does -- no work is
 * repeated, no count is doubled. Three other plans depend on this paragraph
 * not changing: 22-08's watchdog alerts on `failed` and never transitions
 * it; 22-08's runbook documents this exact statement as the operator act;
 * 22-07's auth-failure path marks `failed` and therefore also requires the
 * operator act -- its re-throw makes the tick job visibly fail, it does not
 * re-select the record.
 */

export const WORKSPACE_PURGE_QUEUE = "workspace-purge";

/** Stable id `upsertJobScheduler` dedupes by -- constant across every boot. */
const JOB_SCHEDULER_ID = "workspace-purge-tick";

/** The job name both the scheduled tick and the boot-time immediate run share. */
const JOB_NAME = "run-workspace-purge";

export const WORKSPACE_PURGE_JOB_OPTIONS: BuiltJobOptions = buildJobOptions(STANDARD_JOB_RETENTION);

/**
 * A dedicated, platform-level Postgres pool -- mirrors
 * `partition-maintenance.worker.ts`'s own `partitionMaintenancePool`, never
 * `@mega-crm/tenant-context`'s shared, tenant-scoped pool. `organization`
 * and `purge_records` carry no RLS, and this pool is the one place this
 * worker enumerates and mutates them across every tenant at once.
 */
const workspacePurgePool = createPgPool({
  connectionString: process.env.DATABASE_URL ?? "",
  name: "worker-workspace-purge",
});

type PlatformClient = Pool | PoolClient;

/**
 * PRG-05: thrown when a batch's per-page re-read finds
 * `organization."deletedAt"` has gone back to `NULL` -- the workspace was
 * restored while its purge was walking. Caught at the workspace level in
 * `runWorkspacePurgeWalk`, which records `status = 'failed'` with
 * `purge_error` naming the restore and RE-THROWS -- refused, never
 * silently skipped.
 */
export class WorkspaceRestoredError extends Error {
  constructor(workspaceId: string) {
    super(`workspace ${workspaceId} was restored (organization."deletedAt" is null) during its purge walk -- refusing to continue destroying its rows`);
    this.name = "WorkspaceRestoredError";
  }
}

export interface EligibleWorkspace {
  id: string;
  deletedAt: Date;
}

/**
 * PRG-01: a plain query on the dedicated platform pool selecting every
 * soft-deleted workspace whose retention window has elapsed. No scan role
 * and no new grant is needed -- `organization` carries no RLS and
 * `mega_crm_app` already holds SELECT on it (migration 0045).
 */
export async function findEligibleWorkspaces(client: PlatformClient, now: Date, retentionDays: number): Promise<EligibleWorkspace[]> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const { rows } = await client.query<EligibleWorkspace>(
    `SELECT id, "deletedAt" FROM organization WHERE "deletedAt" IS NOT NULL AND "deletedAt" <= $1::timestamp`,
    [cutoff],
  );
  return rows;
}

async function readOrganizationDeletedAt(client: PlatformClient, workspaceId: string): Promise<Date | null> {
  const { rows } = await client.query<{ deletedAt: Date | null }>(`SELECT "deletedAt" FROM organization WHERE id = $1`, [
    workspaceId,
  ]);
  return rows[0]?.deletedAt ?? null;
}

/**
 * D-09: retires the workspace by an anonymizing UPDATE -- NEVER a DELETE
 * against `organization`. All 27 tenant tables cascade from this row; one
 * delete statement would fire an unbounded, uncheckpointed cascade across
 * every one of them. `deletedAt` is left UNCHANGED (it still records when
 * the soft-delete happened); `"purgedAt"` (migration 0068) is the separate,
 * later fact that the physical purge completed.
 */
export async function tombstoneOrganization(client: PlatformClient, workspaceId: string): Promise<void> {
  await client.query(
    `UPDATE organization SET name = 'purged-workspace', slug = 'purged-' || id::text, "purgedAt" = now() WHERE id = $1`,
    [workspaceId],
  );
}

interface DestructiblePurgeRecordRow {
  workspaceId: string;
}

async function loadDestructiblePurgeRecords(client: PlatformClient): Promise<DestructiblePurgeRecordRow[]> {
  const { rows } = await client.query<DestructiblePurgeRecordRow>(
    `SELECT workspace_id AS "workspaceId" FROM purge_records WHERE status IN ('reported', 'purging')`,
  );
  return rows;
}

async function markPurgeComplete(client: PlatformClient, workspaceId: string): Promise<void> {
  await client.query(`UPDATE purge_records SET status = 'complete', purged_at = now(), updated_at = now() WHERE workspace_id = $1`, [
    workspaceId,
  ]);
}

async function markPurgeFailed(client: PlatformClient, workspaceId: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  await client.query(`UPDATE purge_records SET status = 'failed', purge_error = $2, updated_at = now() WHERE workspace_id = $1`, [
    workspaceId,
    message,
  ]);
}

/**
 * Before the FIRST destructive batch: re-reads `organization."deletedAt"`
 * and throws `WorkspaceRestoredError` if it is null, then moves the record
 * to `purging` and stamps `first_destructive_batch_at` -- ONLY if it is
 * still null (`COALESCE`), so re-entering this on a resumed `purging`
 * record never overwrites the original point-of-no-return timestamp
 * (D-14). The per-page re-check inside `walkPurgeTable` below is the
 * REAL enforcement against a restore mid-walk; this call is the fail-fast
 * gate before any table work starts at all.
 */
async function beginDestructivePhase(client: PlatformClient, workspaceId: string): Promise<void> {
  const deletedAt = await readOrganizationDeletedAt(client, workspaceId);
  if (deletedAt === null) {
    throw new WorkspaceRestoredError(workspaceId);
  }
  await client.query(
    `UPDATE purge_records
        SET status = 'purging',
            first_destructive_batch_at = COALESCE(first_destructive_batch_at, now()),
            updated_at = now()
      WHERE workspace_id = $1 AND status IN ('reported', 'purging')`,
    [workspaceId],
  );
}

/**
 * Phase 22 (PRG-02, D-10/D-12, plan 22-07): the synthetic `completed_tables`
 * marker for the auth step -- never a real `PurgeTable` name, so it can never
 * collide with an entry in `PURGE_TABLE_ORDER`. Recorded via the SAME
 * `markPurgeTableDone` primitive every tenant table uses, so a resumed purge
 * skips an already-completed auth step exactly like it skips an
 * already-completed table -- and re-running it anyway would be harmless
 * regardless, since `deleteWorkspaceAuthRows` deleting already-absent rows is
 * a zero-count no-op.
 */
const AUTH_STEP_MARKER = "auth";

type DeletePurgeBatchFn = typeof deletePurgeBatchDefault;

/**
 * Walks one table to exhaustion for one workspace, in bounded,
 * checkpointed pages -- the per-batch loop PRG-03/PRG-05 both depend on.
 * Each page is its OWN `withTenant`/`withTenantTransaction` scope (mirrors
 * `erasure-scrub.worker.ts`'s `walkTableToExhaustion`): (i) re-reads
 * `organization."deletedAt"` and throws `WorkspaceRestoredError` if it is
 * null -- the REAL per-batch restore guard, re-evaluated on every single
 * page, not merely once before the walk starts; (ii) calls `deleteBatchFn`;
 * (iii) advances the checkpoint heartbeat; all three on the SAME client and
 * the SAME transaction, so the delete and the heartbeat commit together
 * (one commit, never two).
 *
 * Exits the per-page loop the first time a page deletes zero rows, then
 * CONFIRMS with `countPurgeTableRows` -- a page that legitimately found
 * nothing left is different from a page whose rows were all `SKIP LOCKED`
 * under contention. A non-zero confirmed count retries the whole table's
 * walk (up to 3 attempts) rather than declaring the table done -- and
 * `markPurgeTableDone` (a platform-table write, no RLS) is called only once
 * the confirmed count is genuinely zero.
 */
async function walkPurgeTable(
  platformClient: PlatformClient,
  workspaceId: string,
  table: PurgeTable,
  batchSize: number,
  deleteBatchFn: DeletePurgeBatchFn,
): Promise<void> {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    for (;;) {
      const deletedInPage = await withTenant(workspaceId, () =>
        withTenantTransaction(async (client) => {
          const deletedAt = await readOrganizationDeletedAt(client, workspaceId);
          if (deletedAt === null) {
            throw new WorkspaceRestoredError(workspaceId);
          }
          const n = await deleteBatchFn(client, table, workspaceId, batchSize);
          await advanceWorkspacePurgeCheckpoint(client, workspaceId);
          return n;
        }),
      );
      if (deletedInPage === 0) break;
    }

    const remaining = await withTenant(workspaceId, () =>
      withTenantTransaction((client) => countPurgeTableRows(client, table, workspaceId)),
    );
    if (remaining === 0) {
      await markPurgeTableDone(platformClient, workspaceId, table);
      return;
    }
    logger.warn(
      { workspaceId, table, remaining, attempt },
      "workspace-purge: rows remained after a zero-delete page (SKIP LOCKED contention) -- retrying this table's walk",
    );
  }
  throw new Error(
    `workspace-purge: table "${table}" still has rows for workspace ${workspaceId} after ${MAX_ATTEMPTS} retries -- likely persistent SKIP LOCKED contention`,
  );
}

/**
 * The per-table census -- computed ONCE, at report time, and written
 * verbatim to `table_counts`. This value is the D-07/D-10 evidence and is
 * never mutated again afterward (see workspace-purge-checkpoint.ts's own
 * header comment for why the destructive walk's own checkpoint advance
 * deliberately does not touch this column).
 */
async function computePurgeCensus(workspaceId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of PURGE_TABLE_ORDER) {
    counts[table] = await withTenant(workspaceId, () =>
      withTenantTransaction((client) => countPurgeTableRows(client, table, workspaceId)),
    );
  }
  return counts;
}

/**
 * The reporting half of one tick (PRG-01, D-07): inserts a fresh
 * `purge_records` row with the pre-destruction census, `reported_at` set,
 * and `status = 'reported'` -- emitting one structured log line carrying
 * only identifiers, timestamps and counts (T-22-01-04, never a contact
 * field or a workspace name). `ON CONFLICT (workspace_id) DO NOTHING`
 * guards against a benign race where two overlapping ticks both see the
 * same not-yet-reported workspace as eligible.
 */
async function reportWorkspaceForPurge(
  client: PlatformClient,
  workspaceId: string,
  deletedAt: Date,
  eligibleAt: Date,
): Promise<void> {
  const tableCounts = await computePurgeCensus(workspaceId);

  await client.query(
    `INSERT INTO purge_records (workspace_id, soft_deleted_at, eligible_at, reported_at, status, table_counts)
     VALUES ($1, $2, $3, now(), 'reported', $4::jsonb)
     ON CONFLICT (workspace_id) DO NOTHING`,
    [workspaceId, deletedAt, eligibleAt, JSON.stringify(tableCounts)],
  );

  logger.info({ workspaceId, deletedAt, eligibleAt, tableCounts }, "workspace-purge: workspace reported for purge");
}

/**
 * The destructive walk for ONE workspace (PRG-03/PRG-05): takes a
 * per-workspace advisory lock on a DEDICATED connection (single-flight
 * guard, D-14), skipping (structured log, no error, no `failed` mark) if
 * the lock is already held -- a concurrent tick, or the restore path
 * (plan 22-06) sharing this same lock. Released explicitly before the
 * connection returns to the pool (an advisory lock lives for the physical
 * session, not the pooled checkout -- `relocate-default.ts`'s own
 * precedent).
 *
 * A `purge_records` row already `complete` short-circuits immediately
 * (replay is a no-op, PRG-03) BEFORE the lock's own re-check would matter,
 * and one already `failed` is likewise left alone -- see this file's own
 * header comment on the destructive selector for why `failed` is never
 * auto-resumed.
 */
async function runWorkspacePurgeWalk(
  platformClient: Pool,
  workspaceId: string,
  batchSize: number,
  deleteBatchFn: DeletePurgeBatchFn,
  afterTableWalk?: (workspaceId: string) => Promise<void> | void,
  afterAuthDelete?: (workspaceId: string, counts: WorkspaceAuthPurgeCounts) => Promise<void> | void,
): Promise<void> {
  const lockConn = await platformClient.connect();
  let locked = false;
  try {
    const { rows } = await lockConn.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock($1, hashtext($2)) AS locked`, [
      PURGE_ADVISORY_LOCK_NAMESPACE,
      workspaceId,
    ]);
    locked = rows[0]?.locked ?? false;
    if (!locked) {
      logger.info({ workspaceId }, "workspace-purge: advisory lock already held for this workspace -- skipping this tick");
      return;
    }

    const progress = await loadWorkspacePurgeProgress(platformClient, workspaceId);
    if (!progress || progress.status === "complete" || progress.status === "failed") {
      return;
    }

    try {
      await beginDestructivePhase(platformClient, workspaceId);

      for (const table of PURGE_TABLE_ORDER) {
        if (progress.completedTables.includes(table)) continue;
        await walkPurgeTable(platformClient, workspaceId, table, batchSize, deleteBatchFn);
      }

      // Plan 22-09 (PRG-03, SC3): test-only seam, invoked once every table is
      // confirmed empty and marked done but BEFORE the auth step and the
      // tombstone. A no-op unless a caller supplies one -- production never
      // does. This is what lets `workspace-purge-resume.test.ts`'s real-
      // SIGKILL harness freeze the child process at exactly the "before the
      // tail" boundary, proving that boundary is resumable rather than
      // merely assumed to be (the table loop above is the only naturally
      // checkpointed part of the tail; the auth step and the tombstone are
      // not, so this is the only way to land a real kill precisely between
      // them).
      if (afterTableWalk) {
        await afterTableWalk(workspaceId);
      }

      // Phase 22 (PRG-02, D-12, plan 22-07): the auth step runs AFTER every
      // tenant table is empty and BEFORE the tombstone -- this ordering IS
      // the guarantee that a purge never reports success with membership
      // rows left behind. Guarded by the SAME `progress.completedTables`
      // snapshot the table loop above reads (fetched once at the top of this
      // function): a resumed purge whose auth step already succeeded on an
      // earlier tick skips it here exactly like it skips an
      // already-completed table above.
      //
      // Gap-closure plan 22-11 (PRG-02) reordered this block's INTERNAL
      // statement sequence to close a crash window: count -> record ->
      // delete -> (afterAuthDelete seam) -> mark-done. `countWorkspaceAuthRows`
      // reads `member`/`invitation` on the ORDINARY platform pool BEFORE
      // anything is destroyed, and `recordAuthPurgeCounts` writes those real
      // counts write-once BEFORE the elevated-pool delete runs at all. A kill
      // ANYWHERE after that write -- during the delete, between the delete
      // and `markPurgeTableDone`, or on a resumed re-entry -- can therefore
      // never see the real counts replaced by a re-count of zero: the
      // write-once merge (see `recordAuthPurgeCounts`'s own doc comment)
      // means the counts captured here are the ones that survive, no matter
      // how many times this block re-runs.
      //
      // Deliberately inside THIS try block, not a nested one: any failure
      // from `deleteWorkspaceAuthRows` (a missing `AUTH_DATABASE_URL`, a
      // connection error, a permission error) falls straight into the
      // catch below -- `purge_records` is marked `failed` with a reason
      // naming the auth connection (the thrown error's own message), the
      // organization is NOT tombstoned, and the error is re-thrown so BullMQ
      // sees this tick's job fail. The re-throw buys VISIBILITY only -- it
      // does not cause a retry into destruction. Per this file's own header
      // comment, `loadDestructiblePurgeRecords` matches `reported` and
      // `purging` only, so once this catch marks the row `failed` every
      // later tick (retried or scheduled) passes it over. The only way past
      // `failed` is the documented operator act (`UPDATE purge_records SET
      // status = 'purging', purge_error = NULL WHERE workspace_id = $1`,
      // 22-08's runbook) -- after which the next tick resumes here, sees
      // `AUTH_STEP_MARKER` still absent from `completed_tables`, and tries
      // the auth step again -- re-counting and re-recording is a no-op by
      // construction (write-once), and re-deleting already-absent rows is a
      // zero-count no-op (per `deleteWorkspaceAuthRows`'s own doc comment).
      if (!progress.completedTables.includes(AUTH_STEP_MARKER)) {
        const preCounts = await countWorkspaceAuthRows(platformClient, workspaceId);
        await recordAuthPurgeCounts(platformClient, workspaceId, preCounts);

        const authCounts = await deleteWorkspaceAuthRows(workspaceId);

        // Gap-closure plan 22-11 (PRG-02): test-only seam, invoked the
        // INSTANT `deleteWorkspaceAuthRows` returns -- the two auth DELETEs
        // have already committed on the elevated pool, but the `auth`
        // completed-tables marker has not happened yet. This is the ONLY
        // way to land a real kill inside that window. A no-op unless a
        // caller supplies one -- production never does. It sits between the
        // delete's commit and `markPurgeTableDone` -- the last unmarked
        // window in the auth step, now that the census write happens BEFORE
        // the delete.
        if (afterAuthDelete) {
          await afterAuthDelete(workspaceId, authCounts);
        }

        // Drift signal, never a throw: the pre-delete count and the delete's
        // own returned row count should always agree (nothing else writes
        // `member`/`invitation` for this workspace between the two reads).
        // Carries only `workspaceId` and four integers -- no contact field,
        // no workspace name (T-22-01-04 logging discipline).
        if (preCounts.memberCount !== authCounts.memberCount || preCounts.invitationCount !== authCounts.invitationCount) {
          logger.warn(
            {
              workspaceId,
              preMemberCount: preCounts.memberCount,
              preInvitationCount: preCounts.invitationCount,
              deletedMemberCount: authCounts.memberCount,
              deletedInvitationCount: authCounts.invitationCount,
            },
            "workspace-purge: pre-delete auth count drifted from the delete's own returned count",
          );
        }

        await markPurgeTableDone(platformClient, workspaceId, AUTH_STEP_MARKER);
      }

      await tombstoneOrganization(platformClient, workspaceId);
      await markPurgeComplete(platformClient, workspaceId);
      logger.info({ workspaceId }, "workspace-purge: purge complete, organization tombstoned");
    } catch (err) {
      await markPurgeFailed(platformClient, workspaceId, err).catch((markErr) => {
        // Phase 15 plan 08 (OPS-06) discipline, mirrored from
        // erasure-scrub.worker.ts's own markErr comment: a failure to
        // RECORD the failure must never mask the original error.
        logger.error({ err: markErr, workspaceId }, "workspace-purge: failed to record purge failure");
      });
      if (err instanceof WorkspaceRestoredError) {
        logger.error({ workspaceId, reason: err.message }, "workspace-purge: refused -- workspace restored mid-walk (PRG-05)");
      }
      throw err;
    }
  } finally {
    if (locked) {
      await lockConn
        .query(`SELECT pg_advisory_unlock($1, hashtext($2))`, [PURGE_ADVISORY_LOCK_NAMESPACE, workspaceId])
        .catch(() => undefined);
    }
    lockConn.release();
  }
}

export interface ProcessWorkspacePurgeDeps {
  /** Defaults to this module's own dedicated `workspacePurgePool`. */
  client?: Pool;
  now?: () => Date;
  retentionDays?: number;
  batchSize?: number;
  /** Injectable seam for tests (walk-order spies, the restore-mid-walk fault injection). */
  deletePurgeBatch?: DeletePurgeBatchFn;
  /**
   * Plan 22-09 test-only seam: called once per workspace immediately after
   * every table in `PURGE_TABLE_ORDER` is confirmed empty and marked done,
   * but before the auth step and the tombstone. See `runWorkspacePurgeWalk`'s
   * own call site comment. Never set in production.
   */
  afterTableWalk?: (workspaceId: string) => Promise<void> | void;
  /**
   * Gap-closure plan 22-11 test-only seam: called once per workspace the
   * instant `deleteWorkspaceAuthRows` returns -- the two auth DELETEs have
   * already committed on the elevated pool, but the platform-pool checkpoint
   * write and the `auth` completed-tables marker have not happened yet. See
   * `runWorkspacePurgeWalk`'s own call site comment for why this is the ONLY
   * way to land a real kill inside that window. Never set in production.
   */
  afterAuthDelete?: (workspaceId: string, counts: WorkspaceAuthPurgeCounts) => Promise<void> | void;
}

/**
 * One full tick, in the fixed order this file's own header comment
 * documents: destructive phase first, reporting phase second.
 */
export async function processWorkspacePurge(deps: ProcessWorkspacePurgeDeps = {}): Promise<void> {
  const client = deps.client ?? workspacePurgePool;
  const now = deps.now ?? (() => new Date());
  const retentionDays = deps.retentionDays ?? workerEnv.WORKSPACE_PURGE_RETENTION_DAYS;
  const batchSize = deps.batchSize ?? PURGE_BATCH_SIZE;
  const deleteBatchFn = deps.deletePurgeBatch ?? deletePurgeBatchDefault;

  const destructible = await loadDestructiblePurgeRecords(client);
  for (const record of destructible) {
    await runWorkspacePurgeWalk(client, record.workspaceId, batchSize, deleteBatchFn, deps.afterTableWalk, deps.afterAuthDelete);
  }

  const nowValue = now();
  const eligible = await findEligibleWorkspaces(client, nowValue, retentionDays);
  for (const ws of eligible) {
    const existing = await loadWorkspacePurgeProgress(client, ws.id);
    if (existing) continue;
    const eligibleAt = new Date(ws.deletedAt.getTime() + retentionDays * 24 * 60 * 60 * 1000);
    await reportWorkspaceForPurge(client, ws.id, ws.deletedAt, eligibleAt);
  }
}

/**
 * Test-only synchronization -- mirrors `partition-maintenance.worker.ts`'s
 * own `registrationSettled` WeakMap exactly (see that file's doc comment
 * for the full rationale).
 */
const registrationSettled = new WeakMap<Worker, Promise<void>>();

export function waitForWorkspacePurgeRegistration(worker: Worker): Promise<void> {
  return registrationSettled.get(worker) ?? Promise.resolve();
}

export interface CreateWorkspacePurgeWorkerOptions {
  autorun?: boolean;
}

/**
 * Constructs the workspace-purge Worker: registers the
 * `WORKSPACE_PURGE_TICK_CRON` job-scheduler (idempotent by
 * `JOB_SCHEDULER_ID`) and separately enqueues one immediate off-schedule
 * job with a per-boot unique `jobId`, mirroring
 * `partition-maintenance.worker.ts`'s exact shape -- including
 * `upsertJobScheduler` wrapped in try/catch/finally so a registration
 * failure logs and continues instead of crashing boot.
 */
export function createWorkspacePurgeWorker(connection: ConnectionOptions, options: CreateWorkspacePurgeWorkerOptions = {}): Worker {
  const queue = new Queue(WORKSPACE_PURGE_QUEUE, { connection });
  const bootJobId = `boot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const worker = new Worker(
    WORKSPACE_PURGE_QUEUE,
    wrapProcessor(WORKSPACE_PURGE_QUEUE, async () => {
      await processWorkspacePurge();
    }),
    { connection, ...(options.autorun !== undefined ? { autorun: options.autorun } : {}) },
  );

  const registration = (async () => {
    try {
      await queue.upsertJobScheduler(
        JOB_SCHEDULER_ID,
        { pattern: workerEnv.WORKSPACE_PURGE_TICK_CRON, tz: "UTC" },
        { name: JOB_NAME, opts: WORKSPACE_PURGE_JOB_OPTIONS },
      );
      await queue.add(JOB_NAME, {}, { ...WORKSPACE_PURGE_JOB_OPTIONS, jobId: bootJobId });
    } catch (err) {
      logger.error({ err }, "workspace-purge: scheduler registration failed");
    } finally {
      await queue.close().catch(() => undefined);
    }
  })();
  registrationSettled.set(worker, registration);

  return worker;
}

/** Convenience re-export so `apps/worker/src/server.ts` builds this worker's connection the same way every other factory does. */
export { buildRedisConnectionOptions };
