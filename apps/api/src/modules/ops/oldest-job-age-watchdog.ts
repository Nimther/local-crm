/**
 * Phase 15 (OPS-13, plan 15-13, Task 3): the second of two alerts this plan
 * builds -- catches a lane that has stopped draining entirely (the oldest
 * pending BullMQ job across every monitored lane, from `queue-monitor.ts`'s
 * Task 1 reader) AND, per the roadmap's explicit lock, the age of the
 * oldest send still awaiting delivery evidence in `reconciling_since`.
 *
 * The roadmap's own wording says this alert "queries `reconciling_since`
 * directly". A send sitting in `reconciling` has no pending BullMQ job at
 * all, so reading only `reconciling_since` would leave a genuinely stalled
 * QUEUE completely unmonitored -- this module therefore evaluates BOTH
 * signals in one pass, honouring the roadmap's lock while closing the gap
 * it would otherwise leave. Both signals accumulate into ONE evaluation and
 * at most ONE alert per tick -- never two emails for one incident.
 *
 * ONE structural departure from `queue-depth-watchdog.ts` (its otherwise
 * direct sibling): the `reconciling_since` read touches `sends`, an
 * RLS-FORCED, tenant-scoped table, for a platform-wide MIN() aggregate --
 * exactly the same structural problem `ingestion-health-watchdog.ts`
 * documents for `ingress_journal`. `readOldestReconcilingSince` is therefore
 * ALWAYS invoked through `withCrossWorkspaceScan` (the `mega_crm_scan` role,
 * migration 0042's existing unrestricted `sends_scan` policy -- the SAME
 * grant `send-reconciler.worker.ts`'s own discovery query already uses,
 * see SPECIFICATION.md §5.10) -- `checkOldestJobAgeHealthAndAlert` wraps
 * that call internally, so no caller ever has to remember to do so itself.
 * The `ops_alert_state` claim/release, by contrast, carries no RLS and uses
 * the ordinary app-role client -- the exact same read-role/write-role split
 * `ingestion-health-watchdog.ts` established, applied here to a second
 * apps/api consumer of `withCrossWorkspaceScan` (this file is added to that
 * module's own allowlist test, `env-schema.test.ts`'s P3 guard).
 *
 * This module deliberately imports NO env module and NO tenancy module for
 * its OWN wiring -- every dependency (the Postgres client, the queue-metrics
 * reader, the mail sender, the operator address) arrives through the `deps`
 * parameter; boot wiring happens in `apps/api/src/server.ts`, plan 15-14's
 * job, never here.
 */

import { withCrossWorkspaceScan } from "@mega-crm/tenant-context";
import { claimOpsAlertSlot, releaseOpsAlertSlot, type OpsAlertStateClient } from "@mega-crm/db/src/ops/alert-state.js";
import { scrubbedConsole } from "@mega-crm/redaction";
import { RECONCILING_AGE_ALERT_HOURS } from "./send-reconciler-watchdog.js";
import { readAllQueueMetrics, type QueueMetricsResult } from "./queue-monitor.js";

/**
 * D-OPS-13: matches `queue-depth-watchdog.ts`'s own 5-minute cadence -- both
 * OPS-13 lane-health watchdogs poll at the same frequency, sized the same
 * way (cheap BullMQ reads plus one indexed Postgres aggregate).
 */
export const OLDEST_JOB_AGE_WATCHDOG_INTERVAL_MS = 5 * 60_000;

/** D-OPS-13: the same 6-hour event-driven dedup convention every OPS-13/dead-letter/reconciler watchdog shares. */
export const OLDEST_JOB_AGE_ALERT_DEDUP_HOURS = 6;

/** The `ops_alert_state.alert_name` this watchdog claims under -- independent of `queue-depth`'s own name/window. */
export const OLDEST_JOB_AGE_ALERT_NAME = "oldest-job-age";

/**
 * FLAGGED ASSUMPTION (15-13-PLAN.md's own note): a first estimate, not
 * validated against a real production load test. Set below the reconciling-
 * send threshold (`RECONCILING_SEND_AGE_ALERT_HOURS`) deliberately: a job
 * that has not even been ATTEMPTED yet after this many hours means the send
 * pipeline itself has stopped moving -- more urgent than an already-dispatched
 * send merely awaiting delivery evidence. Generous enough that a very large
 * legitimate broadcast, draining under normal per-tenant SendGrid RPS
 * throttling (STACK.md), should still fully drain well within this window
 * for realistic list sizes; tune from real operation once this system has
 * one.
 */
export const OLDEST_PENDING_JOB_AGE_ALERT_HOURS = 12;

/**
 * FLAGGED ASSUMPTION: chosen in explicit relationship to
 * `send-reconciler-watchdog.ts`'s existing `RECONCILING_AGE_ALERT_HOURS`
 * (30h) -- see that module's own doc comment. That existing alert fires from
 * a WORKER-written health-row snapshot (`send_reconciler_runs.oldest_reconciling_since`,
 * refreshed once per reconciler tick) and answers "is the reconciler
 * ticking but failing to resolve backlog". THIS constant is deliberately
 * set BELOW 30h so that a direct, live read of `sends` (this watchdog's own
 * 5-minute poll, entirely independent of whether the reconciler is ticking
 * at all) surfaces an individual stuck send EARLIER -- an escalating
 * early-warning on the same underlying signal, not a simultaneous duplicate:
 * if a backlog is genuinely stuck long enough to trip BOTH alerts, they do
 * so roughly `30 - 24 = 6` hours apart, never at the same tick.
 */
export const RECONCILING_SEND_AGE_ALERT_HOURS = 24;

// Runtime guard for the documented ORDER relationship above -- fails loudly
// at module load (never silently) if either constant is ever edited without
// re-reading this file's own doc comment, so the two watchdogs cannot drift
// into alerting on the same condition at the same tick.
if (RECONCILING_SEND_AGE_ALERT_HOURS >= RECONCILING_AGE_ALERT_HOURS) {
  throw new Error(
    "oldest-job-age-watchdog: RECONCILING_SEND_AGE_ALERT_HOURS must stay strictly below " +
      "send-reconciler-watchdog.ts's RECONCILING_AGE_ALERT_HOURS -- see this constant's own doc comment",
  );
}

export interface SendsReconcilingClient {
  query<T = Record<string, unknown>>(queryText: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/**
 * The global minimum `reconciling_since` across EVERY workspace's still-
 * `reconciling` sends -- the SAME query shape `send-reconciler.worker.ts`'s
 * own discovery step already issues (SPECIFICATION.md §5.10), just from a
 * different process/pool. `client` is always the scan-role connection in
 * production (`checkOldestJobAgeHealthAndAlert` wraps this call in
 * `withCrossWorkspaceScan` itself, mirroring `readIngestionHealth`'s own
 * convention) -- a tenant-scoped connection cannot answer this platform-wide
 * question at all under `sends`'s fail-closed RLS predicate.
 */
export async function readOldestReconcilingSince(client: SendsReconcilingClient): Promise<Date | null> {
  const { rows } = await client.query<{ oldest_reconciling_since: Date | null }>(
    `SELECT MIN(reconciling_since) AS oldest_reconciling_since FROM sends WHERE status = 'reconciling'`,
  );
  return rows[0]?.oldest_reconciling_since ?? null;
}

export interface OldestJobAgeEvaluation {
  healthy: boolean;
  /** Human-readable lines -- queue names, ages in hours, and reason names only. Never a workspace id, contact email, or send id (T-15-42). */
  reasons: string[];
}

/**
 * Pure -- no I/O. Evaluates THREE independent conditions, all of which can
 * fire together into ONE evaluation (never separate calls/alerts):
 *
 *   1. any monitored queue's metrics entry is unreadable -- unhealthy with a
 *      blind-monitor reason (T-15-43: absence of data is never good news).
 *   2. the OLDEST pending job across every READABLE queue's `oldestPendingAt`
 *      is older than `OLDEST_PENDING_JOB_AGE_ALERT_HOURS` -- unhealthy,
 *      naming that queue and the age.
 *   3. `oldestReconcilingSince` (already read platform-wide) is older than
 *      `RECONCILING_SEND_AGE_ALERT_HOURS` -- unhealthy, naming the age.
 *
 * Boundary: `age > threshold` is unhealthy; `age === threshold` is healthy,
 * matching every other watchdog's own documented convention.
 */
export function evaluateOldestJobAgeHealth(
  queueMetrics: Record<string, QueueMetricsResult>,
  oldestReconcilingSince: Date | null,
  now: Date,
  thresholds: { oldestPendingJobAgeHours: number; reconcilingSendAgeHours: number } = {
    oldestPendingJobAgeHours: OLDEST_PENDING_JOB_AGE_ALERT_HOURS,
    reconcilingSendAgeHours: RECONCILING_SEND_AGE_ALERT_HOURS,
  },
): OldestJobAgeEvaluation {
  const reasons: string[] = [];

  let oldestQueueName: string | null = null;
  let oldestPendingAt: Date | null = null;

  for (const [queueName, result] of Object.entries(queueMetrics)) {
    if (!result.readable) {
      reasons.push(`${queueName}: unreadable -- blind monitor, treated as unhealthy`);
      continue;
    }
    if (result.oldestPendingAt && (!oldestPendingAt || result.oldestPendingAt.getTime() < oldestPendingAt.getTime())) {
      oldestPendingAt = result.oldestPendingAt;
      oldestQueueName = queueName;
    }
  }

  if (oldestPendingAt && oldestQueueName) {
    const ageHours = (now.getTime() - oldestPendingAt.getTime()) / (60 * 60 * 1000);
    if (ageHours > thresholds.oldestPendingJobAgeHours) {
      reasons.push(
        `${oldestQueueName}: oldest pending job is ${ageHours.toFixed(1)}h old, exceeds threshold ${thresholds.oldestPendingJobAgeHours}h`,
      );
    }
  }

  if (oldestReconcilingSince) {
    const ageHours = (now.getTime() - oldestReconcilingSince.getTime()) / (60 * 60 * 1000);
    if (ageHours > thresholds.reconcilingSendAgeHours) {
      reasons.push(
        `reconciling_since backlog: oldest unresolved send is ${ageHours.toFixed(1)}h old, exceeds threshold ${thresholds.reconcilingSendAgeHours}h`,
      );
    }
  }

  return { healthy: reasons.length === 0, reasons };
}

/**
 * D-OPS-13/T-15-42: plain-text body only -- queue names, ages in hours and
 * reason lines. `reasons` (this function's only per-incident input) is
 * built exclusively from `evaluateOldestJobAgeHealth`, which itself only
 * ever touches queue names and numbers -- there is no code path by which
 * tenant data could reach this string.
 */
export function renderOldestJobAgeAlertText(reasons: string[], now: Date): string {
  const lines: string[] = [];
  lines.push("Mega CRM oldest-job-age alert");
  lines.push("");
  lines.push(`Checked at (UTC): ${now.toISOString()}`);
  lines.push("Tripped condition(s):");
  for (const reason of reasons) {
    lines.push(`  - ${reason}`);
  }
  lines.push("");
  lines.push(
    "ACTION REQUIRED: for a pending-job reason, check whether apps/worker is running and consuming " +
      "the named lane; for a reconciling_since reason, check whether webhook delivery evidence is " +
      "arriving and whether apps/worker's send-reconciler tick is running.",
  );
  return lines.join("\n");
}

export interface OldestJobAgeAlertMessage {
  to: string;
  text: string;
}

export interface OldestJobAgeWatchdogDeps {
  client: OpsAlertStateClient;
  now: Date;
  operatorEmail: string;
  sendMail: (message: OldestJobAgeAlertMessage) => Promise<void>;
  /** Defaults to the real `readAllQueueMetrics` (Task 1) -- injectable so tests never touch real BullMQ/Redis. */
  readMetrics?: () => Promise<Record<string, QueueMetricsResult>>;
  /** Defaults to a real `withCrossWorkspaceScan(readOldestReconcilingSince)` call -- injectable so tests never require `SCAN_DATABASE_URL`/a live scan connection unless they want one. */
  readOldestReconcilingSince?: () => Promise<Date | null>;
  thresholds?: { oldestPendingJobAgeHours: number; reconcilingSendAgeHours: number };
}

/**
 * Reads every monitored queue's metrics AND the platform-wide oldest
 * `reconciling_since`, evaluates BOTH into one evaluation, and -- on any
 * unhealthy evaluation that WINS the atomic per-`OLDEST_JOB_AGE_ALERT_DEDUP_HOURS`-
 * window claim (via the SHARED `claimOpsAlertSlot`, keyed by
 * `OLDEST_JOB_AGE_ALERT_NAME`) -- sends exactly ONE plain-text operator
 * alert, even when both conditions fired. Returns early without sending,
 * and without touching `ops_alert_state`, when healthy or when the claim is
 * refused.
 *
 * Mirrors every sibling watchdog's CR-02 release-on-failure discipline: a
 * rejected `sendMail` releases the claim before rethrowing, so the very next
 * check can retry.
 */
export async function checkOldestJobAgeHealthAndAlert(deps: OldestJobAgeWatchdogDeps): Promise<void> {
  const readMetrics = deps.readMetrics ?? readAllQueueMetrics;
  // Named distinctly from the module-level `readOldestReconcilingSince` pure
  // reader (never re-bind to the same identifier here -- a `const` of the
  // same name shadows the import inside its own initializer and would
  // recurse into itself forever the first time it is invoked).
  const resolveOldestReconcilingSince =
    deps.readOldestReconcilingSince ?? (() => withCrossWorkspaceScan((client) => readOldestReconcilingSince(client)));

  const [metrics, oldestReconcilingSince] = await Promise.all([readMetrics(), resolveOldestReconcilingSince()]);
  const result = evaluateOldestJobAgeHealth(metrics, oldestReconcilingSince, deps.now, deps.thresholds);

  if (result.healthy) return;

  const claimed = await claimOpsAlertSlot(deps.client, OLDEST_JOB_AGE_ALERT_NAME, deps.now, OLDEST_JOB_AGE_ALERT_DEDUP_HOURS);
  if (!claimed) return;

  const text = renderOldestJobAgeAlertText(result.reasons, deps.now);
  try {
    await deps.sendMail({ to: deps.operatorEmail, text });
  } catch (err) {
    await releaseOpsAlertSlot(deps.client, OLDEST_JOB_AGE_ALERT_NAME, deps.now).catch(() => undefined);
    throw err;
  }
}

export interface StartOldestJobAgeWatchdogDeps {
  client: OpsAlertStateClient;
  operatorEmail: string;
  sendMail: (message: OldestJobAgeAlertMessage) => Promise<void>;
  readMetrics?: () => Promise<Record<string, QueueMetricsResult>>;
  readOldestReconcilingSince?: () => Promise<Date | null>;
  thresholds?: { oldestPendingJobAgeHours: number; reconcilingSendAgeHours: number };
}

/**
 * Registers the `OLDEST_JOB_AGE_WATCHDOG_INTERVAL_MS` poll and returns the
 * interval handle (caller owns clearing it). NOT wired into
 * `apps/api/src/server.ts` by this module -- that boot-time call is plan
 * 15-14's job. A rejected check is logged rather than crashing the interval.
 */
export function startOldestJobAgeWatchdog(deps: StartOldestJobAgeWatchdogDeps): NodeJS.Timeout {
  return setInterval(() => {
    void checkOldestJobAgeHealthAndAlert({ ...deps, now: new Date() }).catch((err: unknown) => {
      scrubbedConsole.error("oldest-job-age-watchdog: health check failed", err);
    });
  }, OLDEST_JOB_AGE_WATCHDOG_INTERVAL_MS);
}
