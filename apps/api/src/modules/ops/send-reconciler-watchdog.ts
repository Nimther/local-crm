/**
 * 11-09 (D-14): the API-process side of the send reconciler's two-process
 * dead-man's-switch. `packages/db/src/reconciler/reconciler-run.ts` (the
 * WORKER, a different process -- see that module's own header comment) writes
 * the `send_reconciler_runs` health row; this module only ever READS it,
 * evaluates health, and -- when unhealthy -- sends a single plain-text
 * operator alert email through the platform's OWN `PLATFORM_SENDGRID_API_KEY`
 * (never a tenant's BYO key, never a Dynamic Template -- same discipline
 * `partition-watchdog.ts` already established: an emergency channel must not
 * depend on a template existing in the platform SendGrid account). This
 * module deliberately imports NO tenancy or KMS module and no env module --
 * the platform key is the only credential it can ever reach, and it never
 * reads `apps/api/src/env.ts` directly, matching P3's structural guarantee
 * (apps/api/src/__tests__/env-schema.test.ts) that this process holds no
 * scan-role credential.
 *
 * This module is a deliberate SIBLING of `partition-watchdog.ts`, not a
 * fork: same structure, same parameter-driven design (it never reads an env
 * module and is never wired into `buildServer()`; the boot wiring is
 * `apps/api/src/server.ts`'s job, task 3 of this plan) -- keeping this
 * module's dependencies entirely injected is what keeps the two watchdogs on
 * disjoint files sharing only the alert-dispatch shape.
 */

import type { ReconcilerRunClient, ReconcilerRunRow } from "@mega-crm/db/src/reconciler/reconciler-run.js";
import { readLatestReconcilerRun } from "@mega-crm/db/src/reconciler/reconciler-run.js";

/**
 * D-14: how often the watchdog polls Postgres for the latest health row.
 * Deliberately independent of the reconciler's own ~5-minute tick cadence
 * (`RECONCILER_TICK_MS`, apps/worker/src/queues/send-reconciler.worker.ts) --
 * that independence is what makes this a genuine "different process,
 * different clock" dead hand rather than a mirror of the job's own schedule
 * (mirrors `partition-watchdog.ts`'s own `WATCHDOG_INTERVAL_MS` rationale).
 */
export const RECONCILER_WATCHDOG_INTERVAL_MS = 15 * 60_000;

/**
 * D-14: six missed ticks at the reconciler's own 5-minute cadence -- long
 * enough that a single delayed tick (deploy, restart, brief outage) does not
 * itself trip a false alarm, short enough that a genuinely stopped
 * reconciler always will within half an hour.
 */
export const RECONCILER_STALE_THRESHOLD_MINUTES = 30;

/**
 * D-14: the resolution window (`RECONCILE_RESOLUTION_WINDOW_MS`,
 * ~24h, packages/delivery-core/src/reconciler.ts) plus slack. A `reconciling`
 * row older than that window should already have been resolved to `unknown`
 * by a healthy reconciler; one that has not means the reconciler is running
 * but not resolving -- a distinct failure from not running at all, and one
 * `stale_last_run` alone would never catch.
 */
export const RECONCILING_AGE_ALERT_HOURS = 30;

/**
 * D-14: bounded to at most four emails a day while unhealthy. Deliberately
 * SHORTER than `partition-watchdog.ts`'s `ALERT_DEDUP_HOURS` (20h): that
 * value tracks a once-daily job's own cadence, where a 20h dedup window
 * still lets the next day's run send a fresh alert. Copying it here would
 * leave a stopped reconciler -- whose own tick cadence is ~5 minutes, not
 * once a day -- nearly silent for a day at a time.
 */
export const RECONCILER_ALERT_DEDUP_HOURS = 6;

export type ReconcilerHealthReason =
  | "missing_health_row"
  | "stale_last_run"
  | "reconciling_backlog_aged";

export interface ReconcilerHealthResult {
  healthy: boolean;
  reasons: ReconcilerHealthReason[];
}

export interface ReconcilerHealthThresholds {
  staleThresholdMinutes: number;
  reconcilingAgeAlertHours: number;
}

/**
 * Pure -- no I/O. Unhealthy when the health row is absent (checked FIRST,
 * before any other condition), when `now - last_run_at` exceeds the stale
 * threshold, or when the oldest still-`reconciling` row observed at the last
 * tick is older than `reconcilingAgeAlertHours`. Both conditions can trip at
 * once. Every comparison is strictly greater-than at the boundary -- exactly
 * at a threshold is healthy, matching `evaluatePartitionHealth`'s documented
 * boundary convention. A missing or unreadable row evaluates unhealthy,
 * NEVER healthy -- a dead-man's switch that defaults to healthy on missing
 * data is worse than no switch at all (T-11-09-01).
 */
export function evaluateReconcilerHealth(
  row: ReconcilerRunRow | null,
  now: Date,
  thresholds: ReconcilerHealthThresholds,
): ReconcilerHealthResult {
  if (!row) {
    return { healthy: false, reasons: ["missing_health_row"] };
  }

  const reasons: ReconcilerHealthReason[] = [];

  const ageMs = now.getTime() - row.lastRunAt.getTime();
  const staleThresholdMs = thresholds.staleThresholdMinutes * 60 * 1000;
  if (ageMs > staleThresholdMs) {
    reasons.push("stale_last_run");
  }

  if (row.oldestReconcilingSince) {
    const backlogAgeMs = now.getTime() - row.oldestReconcilingSince.getTime();
    const backlogThresholdMs = thresholds.reconcilingAgeAlertHours * 60 * 60 * 1000;
    if (backlogAgeMs > backlogThresholdMs) {
      reasons.push("reconciling_backlog_aged");
    }
  }

  return { healthy: reasons.length === 0, reasons };
}

/**
 * D-14/T-11-09-02: plain-text body only -- table name, tick counters, ages
 * and timestamps, and reason names only. Carries an ACTION REQUIRED line
 * naming what an operator should check: whether apps/worker is running,
 * whether the send-reconciler scheduler is registered in Redis, and the
 * send_reconciler_runs row itself. NEVER a workspace id, contact id, send
 * id, email address, connection string, or any part of a SendGrid key --
 * this function never receives any of those (the operator's own address is
 * a separate parameter to `checkReconcilerHealthAndAlert`, never embedded in
 * this text), so by construction there is no `@` character, no UUID-shaped
 * substring, and no occurrence of `Bearer` anywhere in the output.
 */
export function renderReconcilerAlertText(
  row: ReconcilerRunRow | null,
  reasons: ReconcilerHealthReason[],
  now: Date,
): string {
  const lines: string[] = [];
  lines.push("Mega CRM send reconciler alert");
  lines.push("");
  lines.push(`Checked at (UTC): ${now.toISOString()}`);
  lines.push(`Tripped condition(s): ${reasons.join(", ")}`);
  lines.push("");

  if (!row) {
    lines.push(
      "No send_reconciler_runs row was found -- the send reconciler may never have run.",
    );
    lines.push("");
    lines.push(
      "ACTION REQUIRED: check whether apps/worker is running, whether the send-reconciler " +
        "scheduler is registered in Redis, and inspect the send_reconciler_runs row directly.",
    );
    return lines.join("\n");
  }

  lines.push(`last_run_at (UTC): ${row.lastRunAt.toISOString()}`);
  lines.push(
    `This tick: candidates_scanned=${row.candidatesScanned}, rows_resolved=${row.rowsResolved}, ` +
      `rows_marked_unknown=${row.rowsMarkedUnknown}, stale_dispatching_swept=${row.staleDispatchingSwept}`,
  );

  if (row.oldestReconcilingSince) {
    const ageHours = (now.getTime() - row.oldestReconcilingSince.getTime()) / (60 * 60 * 1000);
    lines.push(
      `oldest_reconciling_since (UTC): ${row.oldestReconcilingSince.toISOString()} (${ageHours.toFixed(1)}h old)`,
    );
  } else {
    lines.push("oldest_reconciling_since: none -- no outstanding ambiguous send");
  }

  lines.push("");
  lines.push(
    "ACTION REQUIRED: check whether apps/worker is running, whether the send-reconciler " +
      "scheduler is registered in Redis, and inspect the send_reconciler_runs row directly.",
  );

  return lines.join("\n");
}

export interface ReconcilerAlertMessage {
  to: string;
  text: string;
}

export interface ReconcilerWatchdogDeps {
  client: ReconcilerRunClient;
  now: Date;
  operatorEmail: string;
  sendMail: (message: ReconcilerAlertMessage) => Promise<void>;
}

/**
 * A single conditional `UPDATE ... RETURNING` -- deliberately NOT a `SELECT`
 * followed by a separate `UPDATE`, for the exact multi-replica reasoning
 * `claimAlertSlot` (`partition-watchdog.ts`) documents: `apps/api` runs as
 * multiple replicas, and an in-memory dedup flag or a read-then-write pair
 * would let N replicas each independently decide "I should send" and all
 * send. A single statement makes Postgres's own row-level locking the
 * arbiter -- two concurrent claims against the same row can never both
 * succeed, because the first commit's new `last_alert_sent_at` value makes
 * the second claim's own WHERE clause re-evaluate to false once it proceeds.
 *
 * The caller sends only when this resolves `true` (the UPDATE actually
 * matched and returned a row).
 */
export async function claimReconcilerAlertSlot(
  client: ReconcilerRunClient,
  now: Date,
  dedupHours: number,
): Promise<boolean> {
  const { rows } = await client.query(
    `UPDATE send_reconciler_runs
        SET last_alert_sent_at = $1::timestamptz
      WHERE id = 1
        AND (last_alert_sent_at IS NULL OR last_alert_sent_at < $1::timestamptz - make_interval(hours => $2))
      RETURNING last_alert_sent_at`,
    [now, dedupHours],
  );
  return rows.length > 0;
}

/**
 * Reads the latest health row, evaluates it, and -- on any unhealthy
 * evaluation that WINS the atomic per-`RECONCILER_ALERT_DEDUP_HOURS`-window
 * claim -- sends the plain-text operator alert. Returns early without
 * sending, and without touching `last_alert_sent_at`, when the claim is
 * refused (another replica already claimed this window, or this process
 * already sent recently). A `sendMail` rejection is left to propagate (never
 * caught here to be swallowed): the caller decides what to do with a failed
 * send, and swallowing it here would make a failed alert indistinguishable
 * from a healthy run.
 *
 * CR-02 (mirrors `checkPartitionHealthAndAlert`): `claimReconcilerAlertSlot`
 * necessarily commits `last_alert_sent_at` BEFORE `sendMail` is attempted --
 * that ordering is what makes the claim atomic across replicas in the first
 * place. A rejected `sendMail` must not leave that claim in place, though:
 * this releases the slot (resetting `last_alert_sent_at` back to `NULL`)
 * before rethrowing, so the very next check -- this replica or another,
 * still inside the same dedup window -- can claim and actually send. The
 * release is itself guarded (`WHERE ... last_alert_sent_at = $1`) to only
 * clear the exact value THIS call just set: if a concurrent replica somehow
 * already claimed a NEWER window by the time this runs, that newer claim is
 * never clobbered.
 */
export async function checkReconcilerHealthAndAlert(deps: ReconcilerWatchdogDeps): Promise<void> {
  const row = await readLatestReconcilerRun(deps.client);
  const result = evaluateReconcilerHealth(row, deps.now, {
    staleThresholdMinutes: RECONCILER_STALE_THRESHOLD_MINUTES,
    reconcilingAgeAlertHours: RECONCILING_AGE_ALERT_HOURS,
  });

  if (result.healthy) return;

  const claimed = await claimReconcilerAlertSlot(deps.client, deps.now, RECONCILER_ALERT_DEDUP_HOURS);
  if (!claimed) return;

  const text = renderReconcilerAlertText(row, result.reasons, deps.now);
  try {
    await deps.sendMail({ to: deps.operatorEmail, text });
  } catch (err) {
    await deps.client
      .query(
        `UPDATE send_reconciler_runs
            SET last_alert_sent_at = NULL
          WHERE id = 1
            AND last_alert_sent_at = $1::timestamptz`,
        [deps.now],
      )
      .catch(() => undefined);
    throw err;
  }
}

export interface StartSendReconcilerWatchdogDeps {
  client: ReconcilerRunClient;
  operatorEmail: string;
  sendMail: (message: ReconcilerAlertMessage) => Promise<void>;
}

/**
 * Registers the `RECONCILER_WATCHDOG_INTERVAL_MS` poll and returns the
 * interval handle (caller owns clearing it). NOT wired into
 * `apps/api/src/server.ts` by this module -- that boot-time call is task 3's
 * job. A rejected check (e.g. a failed send) is logged rather than crashing
 * the interval -- there is no caller here to propagate to; this is the
 * outermost boundary, mirroring `startPartitionWatchdog`.
 */
export function startSendReconcilerWatchdog(deps: StartSendReconcilerWatchdogDeps): NodeJS.Timeout {
  return setInterval(() => {
    void checkReconcilerHealthAndAlert({ ...deps, now: new Date() }).catch((err: unknown) => {
      console.error("send-reconciler-watchdog: health check failed", err);
    });
  }, RECONCILER_WATCHDOG_INTERVAL_MS);
}
