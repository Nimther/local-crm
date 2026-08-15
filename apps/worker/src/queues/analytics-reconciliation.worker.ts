import { Queue, Worker, type ConnectionOptions } from "bullmq";
import type { PoolClient } from "pg";
import { withCrossWorkspaceScan, withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { scrubbedConsole } from "@mega-crm/redaction";
import { buildJobOptions, STANDARD_JOB_RETENTION } from "@mega-crm/queue-core";
import { wrapProcessor } from "../processor-wrapper.js";

/** The reconciliation job's own repeatable-tick queue -- self-produced and self-consumed within this file/process only. */
const ANALYTICS_RECONCILE_QUEUE = "analytics-reconcile";
/**
 * A few minutes, per D-08b's stated freshness bound for the "correctness
 * backstop" path. Exported (test-only consumer: `scheduler-registration.test.ts`)
 * so the recurring-schedule regression test asserts against this literal
 * rather than a duplicated magic number that could silently drift from it.
 */
export const RECONCILE_INTERVAL_MS = 3 * 60_000;
/**
 * Bounded recent window -- a rolling reconcile of "today" and "yesterday"
 * (UTC) is enough to correct any drift from a crashed increment or a race
 * without re-scanning a workspace's entire send history on every tick.
 * Exported (test-only consumer: `analytics-reconciliation-dirty-day.test.ts`)
 * so tests drive `reconcileWorkspace` with the SAME window width production
 * uses, rather than a duplicated literal that could silently drift from it.
 * The dirty-day sweep (CMP-03, D-14) reads this constant to decide which
 * days count as "standing"; the MARKING predicate (`isNotToday`) no longer
 * depends on it at all -- see `packages/db/src/analytics/daily-rollup.ts`.
 */
export const RECONCILE_WINDOW_DAYS = 2;

/**
 * CMP-02 (D-13) day-semantics authority: `sends.sent_at` is the single
 * documented field that decides which UTC calendar day a send counts toward
 * for `sent_count`. This is SendGrid-acceptance time, not a change from the
 * reconciler's existing behavior -- it makes explicit what the query below
 * already computes. Event-derived counters (`delivered_count`,
 * `opened_count`, `clicked_count`, `bounced_count`, `unsubscribed_count`) key
 * off the provider event's own `occurred_at` UTC day instead (see
 * `incrementWorkspaceDailyRollup` in `packages/db/src/analytics/daily-rollup.ts`
 * for the incremental-path half of that contract).
 */
export const SEND_DAY_FIELD = "sent_at";

/**
 * The stable id `upsertJobScheduler` dedupes by (Phase 12, WRK-13) --
 * constant across every boot, mirrors `partition-maintenance.worker.ts`'s/
 * `send-reconciler.worker.ts`'s/`flow-segment-sweep.worker.ts`'s own
 * scheduler ids, so registering it on every worker boot never creates a
 * second competing schedule.
 */
const JOB_SCHEDULER_ID = "analytics-reconcile-tick";

/** The job name both the scheduled tick and this file's now-removed legacy repeatable job shared. */
const JOB_NAME = "reconcile-rollups";

/**
 * WRK-13 one-time cleanup identifiers: the OLD `tickQueue.add({repeat})`
 * registration this migrates away from, named here purely so the cleanup
 * below can be deleted once every environment has booted past this
 * migration. Redis persists across deploys -- leaving this entry in place
 * would run BOTH schedules after this change ships.
 */
const LEGACY_JOB_NAME = "reconcile-rollups";
const LEGACY_REPEAT_EVERY_MS = RECONCILE_INTERVAL_MS;
const LEGACY_JOB_ID = "reconcile-rollups";

/** Built through the shared `@mega-crm/queue-core` factory (Phase 12, WRK-11, D-10). */
const DEFAULT_JOB_OPTIONS = buildJobOptions(STANDARD_JOB_RETENTION);

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
 *
 * CMP-02 (D-13) day-semantics fix: `sends.*_at` columns are `timestamptz`
 * (packages/db/src/schema/sends.ts), and Postgres converts a `timestamptz`
 * to the session's `TimeZone` GUC before truncating it to a `date` -- a bare
 * `<col>::date` cast therefore makes the daily number depend on which pooled
 * connection served this query (an operator-settable, session-level GUC),
 * not on any fact about the send itself. Every one of the eight FILTER casts
 * below wraps its column in `AT TIME ZONE 'UTC'` first, forcing the
 * conversion to UTC regardless of the session `TimeZone` GUC, so
 * `reconcileWorkspaceDay` produces byte-identical counts under any session
 * timezone. This same pitfall applies to ANY future query in this codebase
 * that buckets a `timestamptz` column by calendar day -- bucket in UTC
 * explicitly, never rely on the bare cast.
 */
export async function reconcileWorkspaceDay(client: PoolClient, workspaceId: string, day: string): Promise<void> {
  await client.query(
    `INSERT INTO workspace_daily_rollup (
       workspace_id, day, sent_count, delivered_count, opened_count,
       clicked_count, bounced_count, unsubscribed_count
     )
     SELECT
       $1, $2::date,
       count(*) FILTER (WHERE sent_at IS NOT NULL AND (sent_at AT TIME ZONE 'UTC')::date = $2::date),
       count(*) FILTER (WHERE delivered_at IS NOT NULL AND (delivered_at AT TIME ZONE 'UTC')::date = $2::date),
       count(*) FILTER (WHERE first_opened_at IS NOT NULL AND (first_opened_at AT TIME ZONE 'UTC')::date = $2::date),
       count(*) FILTER (WHERE first_clicked_at IS NOT NULL AND (first_clicked_at AT TIME ZONE 'UTC')::date = $2::date),
       count(*) FILTER (
         WHERE (bounced_at IS NOT NULL AND (bounced_at AT TIME ZONE 'UTC')::date = $2::date)
            OR (dropped_at IS NOT NULL AND (dropped_at AT TIME ZONE 'UTC')::date = $2::date)
            OR (spam_reported_at IS NOT NULL AND (spam_reported_at AT TIME ZONE 'UTC')::date = $2::date)
       ),
       count(*) FILTER (WHERE unsubscribed_at IS NOT NULL AND (unsubscribed_at AT TIME ZONE 'UTC')::date = $2::date)
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
 * CMP-03 (D-14): the dirty-day sweep's discovery query -- every (workspace,
 * day) row this workspace's own `dirtied_at` marks as needing re-verification,
 * oldest day first, bounded by `limit`. `PoolClient`-first and
 * transaction-scoped like every other query helper in this codebase; scoped
 * to the caller's own workspace implicitly through RLS (the caller must
 * already be inside a `withTenant`/`withTenantTransaction` scope), never
 * through an explicit `workspace_id` parameter here.
 *
 * `day::text` is deliberate, not decorative: node-postgres parses a `date`
 * column into a JS `Date` at LOCAL midnight by default, which would silently
 * disagree with the `YYYY-MM-DD` strings `recentDays` produces and that
 * `reconcileWorkspaceDay` expects as its `day` parameter.
 */
export async function findDirtyRollupDays(client: PoolClient, limit: number): Promise<string[]> {
  const { rows } = await client.query<{ day: string }>(
    `SELECT day::text as day FROM workspace_daily_rollup
      WHERE dirtied_at IS NOT NULL
      ORDER BY day ASC
      LIMIT $1`,
    [limit]
  );
  return rows.map((row) => row.day);
}

/**
 * CMP-03 (D-14, T-13-05-02): the dirty-day sweep's race-free conditional
 * clear. TWO predicates gate the clear, and both are load-bearing:
 *
 * - `dirtied_at <= $1` (`sweepStartedAt`) -- a mark written AFTER this tick
 *   already read its dirty-day list has not yet been reconciled by this
 *   tick, and clearing it here would lose that late event's verification
 *   permanently; it must survive to be picked up by the NEXT tick instead.
 *   `sweepStartedAt` must come from the SAME database clock that wrote
 *   `dirtied_at` (`now()` inside `incrementWorkspaceDailyRollup`'s upsert)
 *   -- comparing against an application-clock `Date` would open exactly the
 *   skew this predicate exists to close.
 * - `day = ANY($2)` (`reconciledDays`) -- scopes the clear to EXACTLY the
 *   days this tick actually reconciled. Execution-discovered bug (deviation
 *   Rule 1): without this second predicate, `DIRTY_DAY_SWEEP_PAGE_LIMIT`
 *   would be silently defeated -- a backlog larger than the page limit would
 *   still have EVERY old-enough mark cleared here, including the days
 *   `findDirtyRollupDays`'s `LIMIT` excluded from this tick's reconcile
 *   loop, falsely marking them "verified" without ever re-scanning them.
 *   Proven by a regression test seeding `DIRTY_DAY_SWEEP_PAGE_LIMIT + 5`
 *   dirty days and asserting exactly 5 remain marked afterwards.
 */
export async function clearDirtyRollupDays(client: PoolClient, sweepStartedAt: Date, reconciledDays: string[]): Promise<void> {
  if (reconciledDays.length === 0) return;
  await client.query(
    `UPDATE workspace_daily_rollup
        SET dirtied_at = NULL
      WHERE dirtied_at IS NOT NULL
        AND dirtied_at <= $1
        AND day = ANY($2::date[])`,
    [sweepStartedAt, reconciledDays]
  );
}

/**
 * Bounds the per-tick, per-workspace dirty-day sweep (CMP-03, D-14,
 * T-13-05-03). The dirty set is bounded and SMALL BY CONSTRUCTION under
 * `isNotToday`'s `day != today` predicate (`packages/db/src/analytics/daily-rollup.ts`)
 * -- yesterday's rows are marked ROUTINELY by any workspace with
 * midnight-adjacent traffic, and genuinely late days are the only other
 * source. Expected steady state is roughly one row per active workspace per
 * day, plus late arrivals -- NOT deep paging. This bound exists so a
 * pathological backlog degrades into "more ticks", never "one tick that
 * never finishes"; a workspace's dirty-day count regularly approaching this
 * limit is a symptom (a stuck marking bug, or genuinely catastrophic late
 * event volume) to investigate, not expected operation.
 */
export const DIRTY_DAY_SWEEP_PAGE_LIMIT = 50;

/**
 * Reconciles one workspace's bounded recent window inside a FRESH
 * `withTenant`/`withTenantTransaction` scope (Pitfall 5) -- every workspace
 * gets its own transaction/GUC; never shared across two workspace ids.
 *
 * CMP-03 (D-14, plan 13-05) -- the dirty-day sweep mechanism: beyond the
 * standing `recentDays(windowDays)` window this function has always
 * reconciled, it ALSO reconciles every day `findDirtyRollupDays` returns --
 * the (workspace, day) rows a late event marked via `incrementWorkspaceDailyRollup`.
 * A retroactive increment is NEVER trusted on its own; it is verified by the
 * exact same absolute-overwrite fresh `sends` scan every other day gets
 * (`reconcileWorkspaceDay`, unchanged). The standing window's width
 * (`RECONCILE_WINDOW_DAYS`) is deliberately NOT widened to "cover" late
 * events -- that would pay for every tick, forever, to handle an event class
 * that is rare by construction; the dirty-day sweep pays only for the days
 * that actually need it.
 *
 * `sweepStartedAt` is captured ONCE, from the DATABASE's own clock (`now()`),
 * at the top of this transaction -- the SAME clock `incrementWorkspaceDailyRollup`
 * writes `dirtied_at` from, so `clearDirtyRollupDays`'s `<=` comparison is
 * never skewed by an application-clock/database-clock drift. Reconcile ALWAYS
 * runs before clear, and both stay inside this SAME per-workspace transaction
 * -- never a second transaction for the dirty sweep: a crash between
 * reconcile and clear leaves a day reconciled but still marked (harmless,
 * picked up again next tick), while a crash between clear and reconcile
 * would lose the late event's verification (not harmless). The standing and
 * dirty day lists are deduplicated so a dirty day that also falls inside the
 * standing window is reconciled exactly once.
 *
 * Exported (test-only consumer: `analytics-reconciliation-dirty-day.test.ts`)
 * so tests can drive exactly "one tick" for one workspace -- the same unit
 * the worker processor loops over per discovered workspace -- without
 * needing a real BullMQ/Redis worker.
 */
export async function reconcileWorkspace(workspaceId: string, windowDays: number): Promise<void> {
  const standingDays = recentDays(windowDays);
  await withTenant(workspaceId, () =>
    withTenantTransaction(async (client) => {
      const { rows: clockRows } = await client.query<{ now: Date }>(`SELECT now() as now`);
      const sweepStartedAt = clockRows[0].now;

      const dirtyDays = await findDirtyRollupDays(client, DIRTY_DAY_SWEEP_PAGE_LIMIT);
      const days = Array.from(new Set([...standingDays, ...dirtyDays]));

      for (const day of days) {
        await reconcileWorkspaceDay(client, workspaceId, day);
      }

      // Scoped to `days` (this tick's ACTUAL reconcile set), not "every old
      // enough mark" -- see clearDirtyRollupDays's own doc comment for the
      // bug this scoping prevents when the dirty backlog exceeds the page
      // limit.
      await clearDirtyRollupDays(client, sweepStartedAt, days);
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
const registrationSettled = new WeakMap<Worker, Promise<void>>();

/**
 * Test-only: resolves once the `Worker` returned by
 * `createAnalyticsReconciliationWorker` has finished registering its
 * scheduler (and closed its own internal tick-registration `Queue` handle).
 * Not used by production code, mirrors `partition-maintenance.worker.ts`'s
 * identical helper.
 */
export function waitForAnalyticsReconciliationRegistration(worker: Worker): Promise<void> {
  return registrationSettled.get(worker) ?? Promise.resolve();
}

export interface CreateAnalyticsReconciliationWorkerOptions {
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
 * Phase 12 (WRK-13): the tick registration below migrated from the older
 * `tickQueue.add({repeat})` form to `queue.upsertJobScheduler(...)`, the
 * SAME `partition-maintenance.worker.ts`/`send-reconciler.worker.ts`/
 * `flow-segment-sweep.worker.ts` shape -- a stable scheduler id, an
 * immediate boot job, and a `try/catch/finally` that logs a failed
 * registration and always closes this file's own short-lived registration
 * `Queue` handle.
 */
export function createAnalyticsReconciliationWorker(
  connection: ConnectionOptions,
  options: CreateAnalyticsReconciliationWorkerOptions = {}
): Worker {
  const queue = new Queue(ANALYTICS_RECONCILE_QUEUE, { connection });
  const bootJobId = `boot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const worker = new Worker(
    ANALYTICS_RECONCILE_QUEUE,
    wrapProcessor(ANALYTICS_RECONCILE_QUEUE, async () => {
      const rows = await withCrossWorkspaceScan(async (client) => {
        const { rows: workspaceRows } = await client.query<WorkspaceRow>(`SELECT id FROM organization`);
        return workspaceRows;
      });
      for (const row of rows) {
        await reconcileWorkspace(row.id, RECONCILE_WINDOW_DAYS);
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

  // Fire-and-forget registration -- mirrors partition-maintenance.worker.ts's
  // try/catch/finally exactly: a Redis hiccup at boot must log, not crash
  // every other registered worker via an unhandled promise rejection; the
  // `finally` always closes this short-lived internal Queue handle so a
  // failure here never leaks a standalone Redis connection past construction.
  const registration = (async () => {
    try {
      await queue.upsertJobScheduler(
        JOB_SCHEDULER_ID,
        { every: RECONCILE_INTERVAL_MS },
        { name: JOB_NAME, opts: DEFAULT_JOB_OPTIONS }
      );
      await queue.add(JOB_NAME, {}, { ...DEFAULT_JOB_OPTIONS, jobId: bootJobId });

      // WRK-13 one-time cleanup: remove the legacy repeatable entry this
      // file's OLD registration form created. Tolerated not-found (a fresh
      // environment never had it) -- remove this block once every
      // environment has booted past this migration.
      await queue.removeRepeatable(LEGACY_JOB_NAME, { every: LEGACY_REPEAT_EVERY_MS }, LEGACY_JOB_ID);
    } catch (err) {
      scrubbedConsole.error("analytics-reconciliation: scheduler registration failed", err);
    } finally {
      await queue.close().catch(() => undefined);
    }
  })();
  registrationSettled.set(worker, registration);

  return worker;
}
