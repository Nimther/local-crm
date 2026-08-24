/**
 * Phase 22 (PRG-01/PRG-03, D-08, plan 22-08): the tenth operator watchdog,
 * and the API-process side of a two-process dead-man's switch over the
 * workspace physical-purge state machine. `apps/worker/src/queues/
 * workspace-purge.worker.ts` (a DIFFERENT process) writes every
 * `purge_records` row's progress; this module only ever READS that table,
 * evaluates health, and -- when unhealthy -- sends a single plain-text
 * operator alert through the platform's OWN `PLATFORM_SENDGRID_API_KEY`
 * (never a tenant's BYO key, never a Dynamic Template), mirroring every
 * sibling watchdog in this directory.
 *
 * Structurally a deliberate SIBLING of `partition-watchdog.ts` (the
 * evaluate-then-claim-then-send shape) and `failed-send-share-watchdog.ts`
 * (the SHARED `claimOpsAlertSlot`/`releaseOpsAlertSlot` primitive over
 * `ops_alert_state`, rather than a private singleton-row claim) -- not a
 * fork of either. This module deliberately imports NO env module and is
 * never wired into `buildServer()`; boot wiring is `apps/api/src/server.ts`'s
 * job (this plan's Task 2).
 *
 * THE HEALTH PREDICATE IS DELIBERATELY NARROW, matching
 * `workspace-purge.worker.ts`'s own state machine exactly (see that file's
 * header comment on `PurgeRecordStatus`):
 *   - `pending`  -- not yet announced, nothing to watch. Healthy.
 *   - `reported` -- census written, destruction starts next tick (D-07's
 *     announce-then-act guarantee). A row sitting here for a whole tick is
 *     the design working, not a stall. Healthy, unconditionally, regardless
 *     of `reported_at`'s age.
 *   - `purging`  -- unhealthy ONLY when `last_progress_at` (or, before the
 *     first heartbeat commits, `first_destructive_batch_at`) is older than
 *     `WORKSPACE_PURGE_STUCK_THRESHOLD_HOURS`. A large tenant can legitimately
 *     take a long time; what must never stall is the PER-BATCH heartbeat
 *     `advanceWorkspacePurgeCheckpoint` writes on every commit.
 *   - `complete` -- terminal success. Healthy. Success is observable via the
 *     durable row and the worker's own structured completion log line, NEVER
 *     via an alert -- alerting on success would train operators to ignore
 *     this channel (D-08).
 *   - `failed`   -- always unhealthy, carrying the recorded `purge_error`.
 *
 * **THIS READ-ONLY RULE IS LOAD-BEARING FOR THE PHASE'S STATE MACHINE, NOT
 * MERELY TIDY.** Per `workspace-purge.worker.ts`'s own header comment on its
 * destructive selector: `failed` is TERMINAL for automation -- the selector
 * matches `reported` and `purging` ONLY, and the sole exit from `failed` is
 * an operator explicitly issuing `UPDATE purge_records SET status =
 * 'purging', purge_error = NULL WHERE workspace_id = $1` (the exact statement
 * `docs/runbooks/workspace-purge-stuck-alert.md` prescribes). A watchdog that
 * "helpfully" flipped a `failed` row back to `purging` on its own would
 * auto-resume a PRG-05 restore refusal -- `WorkspaceRestoredError`'s own
 * mid-walk guard against a workspace an operator has since un-deleted -- and
 * destroy a live tenant's data, exactly the outcome that terminal state
 * exists to prevent. This module is therefore the NOTIFIER of that state,
 * never its resolver: it never transitions a `purge_records` row, never
 * re-enqueues a job, and never touches any tenant table.
 */

import { claimOpsAlertSlot, releaseOpsAlertSlot, type OpsAlertStateClient } from "@mega-crm/db/src/ops/alert-state.js";
import { scrubbedConsole } from "@mega-crm/redaction";

/**
 * D-08: how often the watchdog polls Postgres for unhealthy `purge_records`
 * rows. Matches `failed-send-share-watchdog.ts`'s 15-minute cadence class --
 * frequent enough to catch a genuinely stalled purge without becoming its
 * own load concern (the read below is a single indexed-status query over a
 * small platform table, never a per-tenant scan).
 */
export const WORKSPACE_PURGE_WATCHDOG_INTERVAL_MS = 15 * 60_000;

/**
 * FLAGGED ASSUMPTION (matching every OPS-13 threshold's own note -- no purge
 * has ever run at production scale here): `advanceWorkspacePurgeCheckpoint`
 * heartbeats on every batch commit within a single tick, so a HEALTHY purge's
 * `last_progress_at` should move on the order of seconds to minutes, not
 * hours -- even for a large tenant. 6 hours is generous enough that a single
 * slow batch (large table, contended lock) or a brief worker restart never
 * trips a false alarm, while still catching a genuinely wedged purge
 * (missing `AUTH_DATABASE_URL`, an unavailable database, a held advisory
 * lock) within the same working day it starts. Tune from real operation once
 * this system has one.
 */
export const WORKSPACE_PURGE_STUCK_THRESHOLD_HOURS = 6;

/**
 * D-08: matches `dead-letter-watchdog.ts`'s and `failed-send-share-watchdog.ts`'s
 * shared 6-hour event-driven dedup window -- a stuck or failed purge is an
 * event that can start at any moment, not tied to a once-daily job's own
 * cadence the way `partition-watchdog.ts`'s 20-hour window is.
 */
export const WORKSPACE_PURGE_ALERT_DEDUP_HOURS = 6;

/**
 * The `ops_alert_state.alert_name` this watchdog claims under. The literal
 * is picked so `scripts/check-runbook-coverage.mjs`'s `expectedRunbookPathFor`
 * derives exactly `docs/runbooks/workspace-purge-stuck-alert.md` (this
 * plan's Task 2 output) -- declaring the name and shipping the runbook are
 * therefore one change, per this plan's own document contract.
 */
export const WORKSPACE_PURGE_STUCK_ALERT_NAME = "workspace-purge-stuck";

/** The subset of `purge_records` columns the health predicate reads. */
export interface WorkspacePurgeRecordRow {
  workspaceId: string;
  status: string;
  reportedAt: Date | null;
  firstDestructiveBatchAt: Date | null;
  lastProgressAt: Date | null;
  purgeError: string | null;
}

export type WorkspacePurgeUnhealthyReason = "stuck" | "failed";

/**
 * One unhealthy workspace's contribution to the alert -- an id, never a
 * name; a reason; the relevant timestamp; and, for `failed`, the recorded
 * error. Nothing here is tenant PII (D-10) -- `workspaceId` is the platform's
 * own identifier, not the tombstoned organization's name.
 */
export interface WorkspacePurgeUnhealthyEntry {
  workspaceId: string;
  reason: WorkspacePurgeUnhealthyReason;
  since: Date | null;
  error: string | null;
}

export type WorkspacePurgeHealthResult =
  | { healthy: true; entries: [] }
  | { healthy: false; entries: WorkspacePurgeUnhealthyEntry[] };

export interface WorkspacePurgeHealthThresholds {
  stuckThresholdHours: number;
}

const DEFAULT_THRESHOLDS: WorkspacePurgeHealthThresholds = {
  stuckThresholdHours: WORKSPACE_PURGE_STUCK_THRESHOLD_HOURS,
};

/**
 * Pure -- no I/O. See this module's own header for the full state-machine
 * rationale. `pending`/`reported`/`complete` are ALWAYS healthy regardless of
 * any timestamp on the row -- `reported` in particular must never alert on
 * age, since sitting there for a whole tick is D-07's own announce-then-act
 * design working as intended. `purging` is unhealthy only past the stuck
 * threshold, measured from `last_progress_at` (falling back to
 * `first_destructive_batch_at` when no heartbeat has landed yet -- the very
 * first batch of a purge). `failed` is unconditionally unhealthy. Multiple
 * unhealthy records fold into ONE result carrying every entry, never one
 * result per record -- the caller claims and sends at most once per check,
 * regardless of how many workspaces are unhealthy.
 */
export function evaluateWorkspacePurgeHealth(
  records: readonly WorkspacePurgeRecordRow[],
  now: Date,
  thresholds: WorkspacePurgeHealthThresholds = DEFAULT_THRESHOLDS,
): WorkspacePurgeHealthResult {
  const entries: WorkspacePurgeUnhealthyEntry[] = [];
  const thresholdMs = thresholds.stuckThresholdHours * 60 * 60 * 1000;

  for (const record of records) {
    if (record.status === "failed") {
      entries.push({
        workspaceId: record.workspaceId,
        reason: "failed",
        since: record.lastProgressAt ?? record.firstDestructiveBatchAt ?? record.reportedAt,
        error: record.purgeError,
      });
      continue;
    }

    if (record.status === "purging") {
      const reference = record.lastProgressAt ?? record.firstDestructiveBatchAt;
      if (reference && now.getTime() - reference.getTime() > thresholdMs) {
        entries.push({
          workspaceId: record.workspaceId,
          reason: "stuck",
          since: reference,
          error: null,
        });
      }
      continue;
    }

    // pending, reported, complete: always healthy -- see this module's own
    // header for why `reported`'s age is deliberately never examined.
  }

  return entries.length === 0 ? { healthy: true, entries: [] } : { healthy: false, entries };
}

/**
 * D-08/D-10: plain-text body only -- workspace ids, statuses, the relevant
 * timestamps, the recorded error, and a pointer to the runbook. NEVER a
 * workspace name or any tenant contact data: the tombstone
 * (`workspace-purge.worker.ts`'s own tombstone step) exists specifically to
 * erase the workspace's identifying name, and an alert that reproduced it
 * would put it right back into an operator's mailbox.
 */
export function renderWorkspacePurgeAlertText(entries: readonly WorkspacePurgeUnhealthyEntry[], now: Date): string {
  const lines: string[] = [];
  lines.push("Mega CRM workspace-purge-stuck alert");
  lines.push("");
  lines.push(`Checked at (UTC): ${now.toISOString()}`);
  lines.push(`Unhealthy purge(s): ${entries.length}`);
  lines.push("");

  for (const entry of entries) {
    const sinceText = entry.since ? entry.since.toISOString() : "unknown";
    if (entry.reason === "failed") {
      lines.push(`workspace ${entry.workspaceId}: status failed (no progress since ${sinceText}) -- error: ${entry.error ?? "(none recorded)"}`);
    } else {
      lines.push(`workspace ${entry.workspaceId}: status purging, no progress since ${sinceText}`);
    }
  }

  lines.push("");
  lines.push(
    "ACTION REQUIRED: see docs/runbooks/workspace-purge-stuck-alert.md for how to confirm the " +
      "condition and the documented recovery steps -- a `failed` row is NEVER auto-resumed.",
  );

  return lines.join("\n");
}

export interface WorkspacePurgeAlertMessage {
  to: string;
  text: string;
}

/** Structural client shape for reading `purge_records` -- the same `{ query }` shape `OpsAlertStateClient` already uses. */
export interface WorkspacePurgeRecordsClient {
  query<T = Record<string, unknown>>(queryText: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

interface RawWorkspacePurgeRecordRow {
  workspaceId: string;
  status: string;
  reportedAt: Date | null;
  firstDestructiveBatchAt: Date | null;
  lastProgressAt: Date | null;
  purgeError: string | null;
}

/**
 * Reads only the rows the predicate can ever call unhealthy (`purging` and
 * `failed`) -- `pending`/`reported`/`complete` are unconditionally healthy
 * (see this module's own header), so there is no reason to fetch them here.
 * `purge_records` carries no RLS (migration 0068's own header comment), so
 * this runs on the plain platform pool -- no `withTenant`/scan-role
 * connection is needed, unlike `sends`.
 */
export async function readWorkspacePurgeRecords(client: WorkspacePurgeRecordsClient): Promise<WorkspacePurgeRecordRow[]> {
  const { rows } = await client.query<RawWorkspacePurgeRecordRow>(
    `SELECT workspace_id AS "workspaceId",
            status,
            reported_at AS "reportedAt",
            first_destructive_batch_at AS "firstDestructiveBatchAt",
            last_progress_at AS "lastProgressAt",
            purge_error AS "purgeError"
       FROM purge_records
      WHERE status IN ('purging', 'failed')`,
  );
  return rows;
}

export interface WorkspacePurgeWatchdogDeps {
  client: OpsAlertStateClient;
  now: Date;
  operatorEmail: string;
  sendMail: (message: WorkspacePurgeAlertMessage) => Promise<void>;
  /** Defaults to a real `readWorkspacePurgeRecords(deps.client)` call -- injectable so tests never need a live purge_records fixture. */
  readRecords?: () => Promise<WorkspacePurgeRecordRow[]>;
  thresholds?: WorkspacePurgeHealthThresholds;
}

/**
 * Unconditionally clears this alert's claim -- deliberately NOT
 * `releaseOpsAlertSlot` (that helper's own guard only clears the EXACT value
 * a matching `claimOpsAlertSlot` call just set, which fits its one
 * documented use -- undoing a claim after a failed send, in the SAME call
 * that made it). This function exists for a genuinely different case this
 * watchdog needs and no sibling does: a purge that WAS unhealthy and has
 * since recovered (an operator fixed the stuck cause, or issued the `failed`
 * recovery statement) should re-arm the dead-man's switch immediately rather
 * than sit inside a stale dedup window that could mask a fresh, unrelated
 * incident for up to `WORKSPACE_PURGE_ALERT_DEDUP_HOURS`.
 */
async function releaseWorkspacePurgeAlertSlotUnconditionally(client: OpsAlertStateClient): Promise<void> {
  await client.query(`UPDATE ops_alert_state SET last_alert_sent_at = NULL, updated_at = now() WHERE alert_name = $1`, [
    WORKSPACE_PURGE_STUCK_ALERT_NAME,
  ]);
}

/**
 * Reads the current `purging`/`failed` rows, evaluates health, and --
 * on any unhealthy evaluation that WINS the atomic per-
 * `WORKSPACE_PURGE_ALERT_DEDUP_HOURS`-window claim (via the SHARED
 * `claimOpsAlertSlot`, keyed by `WORKSPACE_PURGE_STUCK_ALERT_NAME`) -- sends
 * the plain-text operator alert. On a HEALTHY evaluation, unconditionally
 * releases any existing claim so the very next genuine incident alerts
 * immediately rather than waiting out a stale dedup window (see
 * `releaseWorkspacePurgeAlertSlotUnconditionally`'s own doc comment).
 *
 * Mirrors `failed-send-share-watchdog.ts`'s CR-02 release-on-send-failure
 * discipline exactly for the unhealthy path: `claimOpsAlertSlot` necessarily
 * commits `last_alert_sent_at` BEFORE `sendMail` is attempted (that ordering
 * is what makes the claim atomic across replicas); a rejected `sendMail`
 * releases the claim (via `releaseOpsAlertSlot`, guarded to the exact value
 * this call just set) before rethrowing, so the very next check can claim
 * and actually send. The rejection itself is never swallowed here.
 */
export async function checkWorkspacePurgeHealthAndAlert(deps: WorkspacePurgeWatchdogDeps): Promise<void> {
  const readRecords = deps.readRecords ?? (() => readWorkspacePurgeRecords(deps.client));
  const records = await readRecords();
  const result = evaluateWorkspacePurgeHealth(records, deps.now, deps.thresholds);

  if (result.healthy) {
    await releaseWorkspacePurgeAlertSlotUnconditionally(deps.client);
    return;
  }

  const claimed = await claimOpsAlertSlot(deps.client, WORKSPACE_PURGE_STUCK_ALERT_NAME, deps.now, WORKSPACE_PURGE_ALERT_DEDUP_HOURS);
  if (!claimed) return;

  const text = renderWorkspacePurgeAlertText(result.entries, deps.now);
  try {
    await deps.sendMail({ to: deps.operatorEmail, text });
  } catch (err) {
    await releaseOpsAlertSlot(deps.client, WORKSPACE_PURGE_STUCK_ALERT_NAME, deps.now).catch(() => undefined);
    throw err;
  }
}

export interface StartWorkspacePurgeWatchdogDeps {
  client: OpsAlertStateClient;
  operatorEmail: string;
  sendMail: (message: WorkspacePurgeAlertMessage) => Promise<void>;
  readRecords?: () => Promise<WorkspacePurgeRecordRow[]>;
  thresholds?: WorkspacePurgeHealthThresholds;
}

/**
 * Registers the `WORKSPACE_PURGE_WATCHDOG_INTERVAL_MS` poll and returns the
 * interval handle (caller owns clearing it). NOT wired into
 * `apps/api/src/server.ts` by this module -- that boot-time call is this
 * plan's Task 2. A rejected check is logged rather than crashing the
 * interval -- this is the outermost boundary, mirroring every other
 * watchdog's own `start*Watchdog` function.
 */
export function startWorkspacePurgeWatchdog(deps: StartWorkspacePurgeWatchdogDeps): NodeJS.Timeout {
  return setInterval(() => {
    void checkWorkspacePurgeHealthAndAlert({ ...deps, now: new Date() }).catch((err: unknown) => {
      scrubbedConsole.error("purge-watchdog: health check failed", err);
    });
  }, WORKSPACE_PURGE_WATCHDOG_INTERVAL_MS);
}
