/**
 * Phase 15 (OPS-13, plan 15-14, Task 2): the fourth OPS-13 alert -- catches a
 * disproportionate SHARE of send attempts failing, as distinct from a queue
 * backing up (`queue-depth-watchdog.ts`) or a stalled pipeline
 * (`oldest-job-age-watchdog.ts`). A deliberate SIBLING of those two: same
 * shape (a periodic check, a pure `evaluate*Health` function, a plain-text
 * renderer, an atomic claim via the SHARED `ops_alert_state` primitive,
 * release-on-send-failure, an interval registration).
 *
 * The trap this module exists to avoid (this plan's own header, T-15-47):
 * the send pipeline routinely and deliberately defers a job under
 * `rate-limiter-flexible` tenant-bucket backpressure (`tenant-deferral.ts`'s
 * `deferForTenantBucket`) -- that is normal operation, not a failure, and the
 * deferred job's `sends` row never leaves `dispatching` while it waits
 * (`deferForTenantBucket` throws `DelayedError` immediately after
 * `job.moveToDelayed` resolves, per `processor-wrapper.ts`'s control-flow
 * allowlist -- no status write happens on that path at all). Counting those
 * rows as failures would turn routine per-tenant throttling into a false
 * outage alert on every large broadcast.
 *
 * The terminal/non-terminal split below is DERIVED from
 * `@mega-crm/delivery-core`'s exported `SEND_STATUS_TRANSITIONS`
 * (`send-state-machine.ts`) rather than hard-coded status strings, so a
 * future status addition cannot silently land on the wrong side of the
 * ratio: a status is "terminal" here iff its own transitions entry is an
 * empty array (no further transition ever leaves it) -- exactly
 * `sent`/`failed`/`excluded` as of this plan. That split alone is what
 * excludes `dispatching` (the in-flight/deferred case above), `reconciling`
 * (still finding out -- see `ATTEMPTED_TERMINAL_STATUSES`'s own comment) and
 * `unknown` (an ambiguous terminal the reconciler could not resolve within
 * its resolution window -- counting it as a failure would double-alert
 * against `oldest-job-age-watchdog.ts`'s own `reconciling_since` signal;
 * counting it as a success would hide a genuine, unresolved loss) from BOTH
 * sides of the ratio, with no separate rule needed for either.
 *
 * `excluded` is DERIVED-terminal (its own transitions entry is empty) but is
 * explicitly carved OUT of the denominator below, with its own named
 * constant and rationale: an excluded send never reached SendGrid at all
 * (suppressed/unsubscribed/frequency-capped before the pre-send gate ever
 * attempted dispatch -- `send-state-machine.ts`'s own header). Counting a
 * pile of deliberately-skipped sends as "successful attempts" would dilute a
 * genuine high failure rate among the sends that WERE actually attempted --
 * exactly the silent-masking failure mode this alert exists to prevent, just
 * from the opposite direction of the `reconciling`/`unknown` cases above.
 *
 * This module deliberately imports NO env module -- every dependency (the
 * Postgres client, the mail sender, the operator address) arrives through
 * the `deps` parameter; boot wiring happens in `apps/api/src/server.ts`,
 * this plan's Task 3, never here. The `sends` read DOES need
 * `withCrossWorkspaceScan` (the `mega_crm_scan` role, migration 0042's
 * existing unrestricted `sends_scan` policy -- the SAME grant
 * `oldest-job-age-watchdog.ts`'s `readOldestReconcilingSince` already uses)
 * because a platform-wide status breakdown cannot be answered by a
 * tenant-scoped connection under `sends`'s fail-closed RLS predicate; this
 * is the THIRD apps/api file added to `env-schema.test.ts`'s P3
 * `withCrossWorkspaceScan` allowlist.
 */

import { SEND_STATUSES, SEND_STATUS_TRANSITIONS, type SendStatus } from "@mega-crm/delivery-core";
import { withCrossWorkspaceScan } from "@mega-crm/tenant-context";
import { claimOpsAlertSlot, releaseOpsAlertSlot, type OpsAlertStateClient } from "@mega-crm/db/src/ops/alert-state.js";
import { scrubbedConsole } from "@mega-crm/redaction";

/**
 * D-OPS-13: matches `oldest-job-age-watchdog.ts`'s own 5-minute-class
 * cadence class, widened slightly: a share computed over a rolling window is
 * a slower-moving signal than an individual job's age, so a 15-minute poll
 * is frequent enough to catch a genuinely worsening failure rate without
 * re-computing the same aggregate needlessly often.
 */
export const FAILED_SEND_SHARE_WATCHDOG_INTERVAL_MS = 15 * 60_000;

/** D-OPS-13: the same 6-hour event-driven dedup convention every OPS-13/dead-letter/reconciler watchdog shares. */
export const FAILED_SEND_SHARE_ALERT_DEDUP_HOURS = 6;

/** The `ops_alert_state.alert_name` this watchdog claims under -- independent of the other three OPS-13 alerts' own names/windows. */
export const FAILED_SEND_SHARE_ALERT_NAME = "failed-send-share";

/**
 * FLAGGED ASSUMPTION (15-14-PLAN.md's own flagged-assumption note, inherited
 * from 15-13's): a first estimate, not validated against a real production
 * load test. `sends.status` reaches a terminal value (`sent`/`failed`)
 * almost immediately after SendGrid's synchronous `mail/send` response (unit
 * 3 of the three-unit dispatch discipline) -- a 6h rolling window is wide
 * enough to accumulate a meaningful sample even for a workspace sending in
 * modest bursts, while staying short enough that a genuinely NEW failure
 * spike is visible within the same working day it starts, not smeared
 * across a much longer look-back. Tune from real operation once this system
 * has one.
 */
export const FAILED_SEND_SHARE_ROLLING_WINDOW_HOURS = 6;

/**
 * FLAGGED ASSUMPTION: a first estimate. A share alert on two sends is noise
 * -- the smallest active tenant would otherwise trip this alert constantly
 * on a single unlucky bounce (1-of-2 is a 50% share). 20 terminal
 * (sent+failed) outcomes is a small but non-trivial sample: below it, the
 * evaluation is unconditionally healthy regardless of how skewed the
 * observed share looks. Tune from real operation once this system has one.
 */
export const FAILED_SEND_SHARE_MIN_SAMPLE_SIZE = 20;

/**
 * FLAGGED ASSUMPTION: a first estimate. 10% failed-of-attempted is well
 * above SendGrid's typical steady-state permanent-rejection rate for a
 * verified sender with clean list hygiene, while still catching a real
 * degradation (a bad API key, a suspended sender, a de-verified domain)
 * long before it silently drains an entire campaign. Tune from real
 * operation once this system has one.
 */
export const FAILED_SEND_SHARE_ALERT_THRESHOLD = 0.1;

/**
 * Derived, not hard-coded: a status is terminal iff `SEND_STATUS_TRANSITIONS`
 * gives it zero outgoing transitions (see this module's own header). As of
 * this plan: `sent`, `failed`, `excluded`.
 */
const TERMINAL_STATUSES: readonly SendStatus[] = SEND_STATUSES.filter((status) => SEND_STATUS_TRANSITIONS[status].length === 0);

/**
 * The denominator set: terminal statuses that represent an ACTUAL SendGrid
 * send attempt with a known outcome -- `excluded` is deliberately carved out
 * of the derived terminal set (see this module's own header for why a
 * pre-send-gate skip must never enter this ratio). As of this plan:
 * `sent`, `failed`.
 */
const ATTEMPTED_TERMINAL_STATUSES: readonly SendStatus[] = TERMINAL_STATUSES.filter((status) => status !== "excluded");

export type SendStatusCounts = Partial<Record<SendStatus, number>>;

export interface SendsScanClient {
  query<T = Record<string, unknown>>(queryText: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

interface RawStatusCountRow {
  status: string;
  count: string;
}

/**
 * The global per-status count of `sends` rows queued within
 * `windowStart..now`, across EVERY workspace -- the same query shape
 * `readOldestReconcilingSince` (`oldest-job-age-watchdog.ts`) uses for its
 * own platform-wide aggregate. `client` is always the scan-role connection
 * in production (`checkFailedSendShareHealthAndAlert` wraps this call in
 * `withCrossWorkspaceScan` itself) -- a tenant-scoped connection cannot
 * answer this platform-wide question at all under `sends`'s fail-closed RLS
 * predicate.
 */
export async function readSendStatusCountsSince(client: SendsScanClient, windowStart: Date): Promise<SendStatusCounts> {
  const { rows } = await client.query<RawStatusCountRow>(`SELECT status, COUNT(*)::text AS count FROM sends WHERE queued_at >= $1 GROUP BY status`, [
    windowStart,
  ]);

  const counts: SendStatusCounts = {};
  for (const row of rows) {
    counts[row.status as SendStatus] = Number(row.count);
  }
  return counts;
}

export interface FailedSendShareEvaluation {
  healthy: boolean;
  /** Human-readable line naming the observed failed/denominator counts and share. Never a workspace id, contact email, or send id (T-15-42): built ONLY from integers. */
  reasons: string[];
}

export interface FailedSendShareThresholds {
  minSampleSize: number;
  shareThreshold: number;
}

/**
 * Pure -- no I/O. Denominator = the sum of `ATTEMPTED_TERMINAL_STATUSES`
 * counts only (`sent` + `failed`) -- every other status (`dispatching`,
 * `reconciling`, `unknown`, `excluded`) is excluded from BOTH sides, per this
 * module's own header. Below `minSampleSize`, healthy unconditionally
 * regardless of how skewed the share looks. Boundary:
 * `share > shareThreshold` is unhealthy; `share === shareThreshold` is
 * healthy -- exactly at the threshold is fine, matching every other
 * watchdog's own documented boundary convention.
 */
export function evaluateFailedSendShareHealth(
  counts: SendStatusCounts,
  thresholds: FailedSendShareThresholds = {
    minSampleSize: FAILED_SEND_SHARE_MIN_SAMPLE_SIZE,
    shareThreshold: FAILED_SEND_SHARE_ALERT_THRESHOLD,
  },
): FailedSendShareEvaluation {
  const denominator = ATTEMPTED_TERMINAL_STATUSES.reduce((sum, status) => sum + (counts[status] ?? 0), 0);

  if (denominator < thresholds.minSampleSize) {
    return { healthy: true, reasons: [] };
  }

  const failed = counts.failed ?? 0;
  const share = failed / denominator;

  if (share > thresholds.shareThreshold) {
    const sharePct = (share * 100).toFixed(1);
    const thresholdPct = (thresholds.shareThreshold * 100).toFixed(1);
    return {
      healthy: false,
      reasons: [`failed-send-share: ${failed}/${denominator} terminal sends failed (${sharePct}%), exceeds threshold ${thresholdPct}%`],
    };
  }

  return { healthy: true, reasons: [] };
}

/**
 * D-OPS-13/T-15-42: plain-text body only -- counts, shares and reason lines.
 * NEVER a workspace id, contact id, send id, email address, or SendGrid key:
 * `reasons` (this function's only per-incident input) is built exclusively
 * from `evaluateFailedSendShareHealth`, which itself only ever touches
 * integers -- there is no code path by which tenant data could reach this
 * string.
 */
export function renderFailedSendShareAlertText(reasons: string[], now: Date): string {
  const lines: string[] = [];
  lines.push("Mega CRM failed-send-share alert");
  lines.push("");
  lines.push(`Checked at (UTC): ${now.toISOString()}`);
  lines.push(`Rolling window: ${FAILED_SEND_SHARE_ROLLING_WINDOW_HOURS}h`);
  lines.push("Tripped condition(s):");
  for (const reason of reasons) {
    lines.push(`  - ${reason}`);
  }
  lines.push("");
  lines.push(
    "ACTION REQUIRED: check the SendGrid account's own activity feed for the affected tenant(s), " +
      "verify the sender identity/domain is still verified, and confirm the tenant's SendGrid API key " +
      "has not been revoked or rate-limited by the provider.",
  );
  return lines.join("\n");
}

export interface FailedSendShareAlertMessage {
  to: string;
  text: string;
}

export interface FailedSendShareWatchdogDeps {
  client: OpsAlertStateClient;
  now: Date;
  operatorEmail: string;
  sendMail: (message: FailedSendShareAlertMessage) => Promise<void>;
  /** Defaults to a real `withCrossWorkspaceScan(readSendStatusCountsSince)` call bounded to the rolling window -- injectable so tests never require `SCAN_DATABASE_URL`/a live scan connection unless they want one. */
  readCounts?: () => Promise<SendStatusCounts>;
  thresholds?: FailedSendShareThresholds;
}

/**
 * Reads the platform-wide per-status send-count breakdown over the rolling
 * window, evaluates health, and -- on any unhealthy evaluation that WINS the
 * atomic per-`FAILED_SEND_SHARE_ALERT_DEDUP_HOURS`-window claim (via the
 * SHARED `claimOpsAlertSlot`, keyed by `FAILED_SEND_SHARE_ALERT_NAME`) --
 * sends the plain-text operator alert. Returns early without sending, and
 * without touching `ops_alert_state`, when healthy or when the claim is
 * refused (another replica already claimed this window, or this process
 * already sent recently).
 *
 * Mirrors every sibling OPS-13 watchdog's CR-02 release-on-failure
 * discipline: a rejected `sendMail` releases the claim (via
 * `releaseOpsAlertSlot`) before rethrowing, so the very next check -- this
 * replica or another, still inside the same dedup window -- can claim and
 * actually send. The rejection itself is never swallowed here.
 */
export async function checkFailedSendShareHealthAndAlert(deps: FailedSendShareWatchdogDeps): Promise<void> {
  const readCounts =
    deps.readCounts ??
    (() => {
      const windowStart = new Date(deps.now.getTime() - FAILED_SEND_SHARE_ROLLING_WINDOW_HOURS * 60 * 60 * 1000);
      return withCrossWorkspaceScan((client) => readSendStatusCountsSince(client, windowStart));
    });

  const counts = await readCounts();
  const result = evaluateFailedSendShareHealth(counts, deps.thresholds);

  if (result.healthy) return;

  const claimed = await claimOpsAlertSlot(deps.client, FAILED_SEND_SHARE_ALERT_NAME, deps.now, FAILED_SEND_SHARE_ALERT_DEDUP_HOURS);
  if (!claimed) return;

  const text = renderFailedSendShareAlertText(result.reasons, deps.now);
  try {
    await deps.sendMail({ to: deps.operatorEmail, text });
  } catch (err) {
    await releaseOpsAlertSlot(deps.client, FAILED_SEND_SHARE_ALERT_NAME, deps.now).catch(() => undefined);
    throw err;
  }
}

export interface StartFailedSendShareWatchdogDeps {
  client: OpsAlertStateClient;
  operatorEmail: string;
  sendMail: (message: FailedSendShareAlertMessage) => Promise<void>;
  readCounts?: () => Promise<SendStatusCounts>;
  thresholds?: FailedSendShareThresholds;
}

/**
 * Registers the `FAILED_SEND_SHARE_WATCHDOG_INTERVAL_MS` poll and returns
 * the interval handle (caller owns clearing it). NOT wired into
 * `apps/api/src/server.ts` by this module -- that boot-time call is this
 * plan's Task 3. A rejected check is logged rather than crashing the
 * interval -- this is the outermost boundary, mirroring every other
 * watchdog's own `start*Watchdog` function.
 */
export function startFailedSendShareWatchdog(deps: StartFailedSendShareWatchdogDeps): NodeJS.Timeout {
  return setInterval(() => {
    void checkFailedSendShareHealthAndAlert({ ...deps, now: new Date() }).catch((err: unknown) => {
      scrubbedConsole.error("failed-send-share-watchdog: health check failed", err);
    });
  }, FAILED_SEND_SHARE_WATCHDOG_INTERVAL_MS);
}
