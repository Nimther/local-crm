/**
 * Phase 15 (OPS-13, plan 15-13, Task 2): the first of two alerts this plan
 * builds on `queue-monitor.ts` (Task 1) -- catches a lane that is filling
 * faster than it drains. A deliberate SIBLING of `send-reconciler-watchdog.ts`
 * and `dead-letter-watchdog.ts`, not a fork: same shape (a periodic check, a
 * pure `evaluate*Health` function, a plain-text renderer, an atomic claim,
 * release-on-send-failure, an interval registration) -- but claims through
 * the SHARED `ops_alert_state` primitive (plan 15-12's `claimOpsAlertSlot`/
 * `releaseOpsAlertSlot`) instead of a dedicated singleton table, since this
 * is one of four OPS-13 alerts sharing that one keyed table.
 *
 * This module deliberately imports NO env module and NO tenancy module --
 * every dependency (the Postgres client, the queue-metrics reader, the mail
 * sender, the operator address) arrives through the `deps` parameter; boot
 * wiring (which real client/sender to pass, and the interval registration
 * call) happens in `apps/api/src/server.ts`, plan 15-14's job, never here.
 */

import {
  CAMPAIGN_KICKOFF_QUEUE,
  EMAIL_BROADCAST_QUEUE,
  EMAIL_TRIGGERED_QUEUE,
  ERASURE_SCRUB_QUEUE,
  EVENTS_INGEST_QUEUE,
  FLOW_ENROLL_EXISTING_QUEUE,
  IMPORTS_CSV_QUEUE,
  WEBHOOK_EVENTS_QUEUE,
} from "@mega-crm/shared-schemas";
import { claimOpsAlertSlot, releaseOpsAlertSlot, type OpsAlertStateClient } from "@mega-crm/db/src/ops/alert-state.js";
import { scrubbedConsole } from "@mega-crm/redaction";
import { readAllQueueMetrics, type QueueMetricsResult } from "./queue-monitor.js";

/**
 * D-OPS-13: how often the watchdog re-reads every monitored lane's job
 * counts. Each check is a handful of cheap BullMQ `getJobCounts`/bounded
 * `getWaiting`/`getDelayed` calls (Task 1) -- deliberately more frequent
 * than the reconciler's 15-minute poll (`RECONCILER_WATCHDOG_INTERVAL_MS`),
 * since a queue filling up is a faster-moving signal than a stalled
 * once-per-tick reconciler.
 */
export const QUEUE_DEPTH_WATCHDOG_INTERVAL_MS = 5 * 60_000;

/**
 * D-OPS-13: matches `send-reconciler-watchdog.ts`'s/`dead-letter-watchdog.ts`'s
 * shared 6h dedup convention for an event-driven (not once-daily) signal --
 * a queue can start backing up at any time, so a 20h (`partition-watchdog.ts`)
 * window would leave a genuinely growing backlog nearly silent for most of a
 * day.
 */
export const QUEUE_DEPTH_ALERT_DEDUP_HOURS = 6;

/** The `ops_alert_state.alert_name` this watchdog claims under -- independent of the other three OPS-13 alerts' own names/windows. */
export const QUEUE_DEPTH_ALERT_NAME = "queue-depth";

/**
 * Per-lane depth thresholds (FLAGGED ASSUMPTION, 15-13-PLAN.md's own
 * flagged-assumption note): first estimates chosen at the planner's
 * discretion, NOT values validated against a real production load test --
 * this repository does not yet have one. Each is set per-lane rather than as
 * one global number because the lanes' legitimate steady-state volumes
 * differ by orders of magnitude (a broadcast fan-out enqueues one job per
 * recipient; a triggered send is one job per individual contact event) --
 * a single shared threshold would either alert constantly on legitimate
 * broadcasts or never catch a stalled triggered lane. Depth = waiting +
 * delayed + active (never `failed` -- a failed job is `dead-letter-watchdog.ts`'s
 * own concern, not a sign of a queue backing up). Tune every value below from
 * real operation once this system has one.
 */
export const QUEUE_DEPTH_THRESHOLDS: Record<string, number> = {
  // The per-recipient fan-out lane -- this system's target scale (STACK.md:
  // 100k-1M contacts) means a single large broadcast can legitimately enqueue
  // on the order of 100k jobs within seconds of launch. Set high enough that
  // a legitimate large send never trips this, while still bounding an
  // actually-runaway backlog (which would keep climbing past this on the
  // NEXT tick, not just briefly touch it once).
  [EMAIL_BROADCAST_QUEUE]: 100_000,
  // The triggered-send lane must never be starved behind a flooded broadcast
  // queue (STACK.md's own two-queue rationale) -- a stalled triggered lane
  // is exactly the failure OPS-13 exists to catch fastest, so this threshold
  // is two orders of magnitude below the broadcast lane's.
  [EMAIL_TRIGGERED_QUEUE]: 2_000,
  // Event ingestion volume scales with overall contact-event traffic
  // (segment/flow evaluation, analytics) rather than with a single
  // broadcast's recipient count -- a middle tier between the fan-out lane
  // and the small one-shot lanes below.
  [EVENTS_INGEST_QUEUE]: 20_000,
  // One job per whole VERIFIED webhook batch (not per individual delivery
  // event -- see `enqueueWebhookBatch`'s own doc comment), so this lane's
  // healthy depth is close to zero even at high webhook volume.
  [WEBHOOK_EVENTS_QUEUE]: 500,
  // One job per campaign launch or scheduled-campaign tick -- should never
  // meaningfully queue; a depth this high means the kickoff/dispatch worker
  // itself has stopped.
  [CAMPAIGN_KICKOFF_QUEUE]: 200,
  // One job per contact erasure request (CMP-04) -- infrequent by nature.
  [ERASURE_SCRUB_QUEUE]: 200,
  // One job per uploaded CSV file -- rare; a marketer uploads a contact list
  // occasionally, not continuously.
  [IMPORTS_CSV_QUEUE]: 50,
  // One-shot backfill job per flow publish-with-backfill choice -- rare.
  [FLOW_ENROLL_EXISTING_QUEUE]: 50,
};

export interface QueueDepthEvaluation {
  healthy: boolean;
  /** Human-readable, queue-name-carrying lines -- e.g. "email-broadcast: depth 100050 exceeds threshold 100000" or "webhook-events: unreadable -- blind monitor, treated as unhealthy". Never a workspace id, contact email, or send id (T-15-42): these are built ONLY from queue names and integers. */
  reasons: string[];
}

/**
 * Pure -- no I/O. Iterates every entry in `thresholds` (not every key in
 * `metrics`) so a queue this watchdog is SUPPOSED to monitor but whose
 * metrics are entirely ABSENT from the map still evaluates unhealthy
 * (T-15-43: absence of data is never treated as good news) -- the same
 * discipline `evaluateReconcilerHealth` applies to a missing health row,
 * extended here to a missing map entry rather than a missing table row.
 * Boundary: `depth > threshold` is unhealthy; `depth === threshold` is
 * healthy -- exactly at the threshold is fine, matching every other
 * watchdog's own documented boundary convention.
 */
export function evaluateQueueDepthHealth(
  metrics: Record<string, QueueMetricsResult>,
  thresholds: Record<string, number> = QUEUE_DEPTH_THRESHOLDS,
): QueueDepthEvaluation {
  const reasons: string[] = [];

  for (const [queueName, threshold] of Object.entries(thresholds)) {
    const result = metrics[queueName];

    if (!result || !result.readable) {
      reasons.push(`${queueName}: unreadable -- blind monitor, treated as unhealthy`);
      continue;
    }

    const depth = result.waiting + result.delayed + result.active;
    if (depth > threshold) {
      reasons.push(`${queueName}: depth ${depth} exceeds threshold ${threshold}`);
    }
  }

  return { healthy: reasons.length === 0, reasons };
}

/**
 * D-OPS-13/T-15-42: plain-text body only -- queue names, depths, thresholds
 * and reason lines. NEVER a workspace id, contact id, send id, email
 * address, or SendGrid key: `reasons` (this function's only per-incident
 * input) is built exclusively from `evaluateQueueDepthHealth`, which itself
 * only ever touches queue names and integers -- there is no code path by
 * which tenant data could reach this string.
 */
export function renderQueueDepthAlertText(reasons: string[], now: Date): string {
  const lines: string[] = [];
  lines.push("Mega CRM queue depth alert");
  lines.push("");
  lines.push(`Checked at (UTC): ${now.toISOString()}`);
  lines.push("Tripped condition(s):");
  for (const reason of reasons) {
    lines.push(`  - ${reason}`);
  }
  lines.push("");
  lines.push(
    "ACTION REQUIRED: check whether apps/worker is running and consuming the named lane(s) above, " +
      "whether Redis is reachable, and whether BullMQ Worker concurrency for that lane is sufficient " +
      "for current volume.",
  );
  return lines.join("\n");
}

export interface QueueDepthAlertMessage {
  to: string;
  text: string;
}

export interface QueueDepthWatchdogDeps {
  client: OpsAlertStateClient;
  now: Date;
  operatorEmail: string;
  sendMail: (message: QueueDepthAlertMessage) => Promise<void>;
  /** Defaults to the real `readAllQueueMetrics` (Task 1) -- injectable so tests never touch real BullMQ/Redis. */
  readMetrics?: () => Promise<Record<string, QueueMetricsResult>>;
  thresholds?: Record<string, number>;
}

/**
 * Reads every monitored queue's metrics, evaluates health, and -- on any
 * unhealthy evaluation that WINS the atomic per-`QUEUE_DEPTH_ALERT_DEDUP_HOURS`-
 * window claim (via the SHARED `claimOpsAlertSlot`, keyed by
 * `QUEUE_DEPTH_ALERT_NAME`) -- sends the plain-text operator alert. Returns
 * early without sending, and without touching `ops_alert_state`, when
 * healthy or when the claim is refused (another replica already claimed
 * this window, or this process already sent recently).
 *
 * Mirrors `checkReconcilerHealthAndAlert`'s/`checkDeadLetterHealthAndAlert`'s
 * CR-02 release-on-failure discipline: a rejected `sendMail` releases the
 * claim (via `releaseOpsAlertSlot`) before rethrowing, so the very next
 * check -- this replica or another, still inside the same dedup window --
 * can claim and actually send. The rejection itself is never swallowed here.
 */
export async function checkQueueDepthHealthAndAlert(deps: QueueDepthWatchdogDeps): Promise<void> {
  const readMetrics = deps.readMetrics ?? readAllQueueMetrics;
  const metrics = await readMetrics();
  const result = evaluateQueueDepthHealth(metrics, deps.thresholds ?? QUEUE_DEPTH_THRESHOLDS);

  if (result.healthy) return;

  const claimed = await claimOpsAlertSlot(deps.client, QUEUE_DEPTH_ALERT_NAME, deps.now, QUEUE_DEPTH_ALERT_DEDUP_HOURS);
  if (!claimed) return;

  const text = renderQueueDepthAlertText(result.reasons, deps.now);
  try {
    await deps.sendMail({ to: deps.operatorEmail, text });
  } catch (err) {
    await releaseOpsAlertSlot(deps.client, QUEUE_DEPTH_ALERT_NAME, deps.now).catch(() => undefined);
    throw err;
  }
}

export interface StartQueueDepthWatchdogDeps {
  client: OpsAlertStateClient;
  operatorEmail: string;
  sendMail: (message: QueueDepthAlertMessage) => Promise<void>;
  readMetrics?: () => Promise<Record<string, QueueMetricsResult>>;
  thresholds?: Record<string, number>;
}

/**
 * Registers the `QUEUE_DEPTH_WATCHDOG_INTERVAL_MS` poll and returns the
 * interval handle (caller owns clearing it). NOT wired into
 * `apps/api/src/server.ts` by this module -- that boot-time call is plan
 * 15-14's job. A rejected check is logged rather than crashing the interval
 * -- this is the outermost boundary, mirroring every other watchdog's own
 * `start*Watchdog` function.
 */
export function startQueueDepthWatchdog(deps: StartQueueDepthWatchdogDeps): NodeJS.Timeout {
  return setInterval(() => {
    void checkQueueDepthHealthAndAlert({ ...deps, now: new Date() }).catch((err: unknown) => {
      scrubbedConsole.error("queue-depth-watchdog: health check failed", err);
    });
  }, QUEUE_DEPTH_WATCHDOG_INTERVAL_MS);
}
