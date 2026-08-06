/**
 * 09-01 (DB-02, D-01/D-02/D-04): the API-process side of the two-process
 * dead-man's-switch. `packages/db/src/partitions/maintenance-run.ts` (the
 * WORKER, a different process -- D-02's own stated principle) writes the
 * `partition_maintenance_runs` health row; this module only ever READS it,
 * evaluates health, and -- when unhealthy -- sends a single plain-text
 * operator alert email through the platform's OWN `PLATFORM_SENDGRID_API_KEY`
 * (never a tenant's BYO key, never a Dynamic Template -- D-04: an emergency
 * channel must not depend on a template existing in the platform SendGrid
 * account). This module deliberately imports NO tenancy or KMS module and
 * names no tenant-key table (threat T-09-04) -- the platform key is the only
 * credential it can ever reach.
 *
 * This module is intentionally parameter-driven: it never reads
 * `apps/api/src/env.ts` and is never wired into `apps/api/src/server.ts`.
 * Both are 09-02's job -- keeping this module's dependencies entirely
 * injected is what keeps the two plans on disjoint files.
 */

import { BUFFER_ALERT_THRESHOLD_MONTHS, type PartitionClient } from "@mega-crm/db/src/partitions/ensure-partitions.js";
import { readLatestMaintenanceRun, type PartitionMaintenanceRunRow } from "@mega-crm/db/src/partitions/maintenance-run.js";

/**
 * D-02: how often the watchdog polls Postgres for the latest health row.
 * Deliberately independent of the daily maintenance job's own cadence --
 * this is what makes the watchdog a genuine "different process, different
 * clock" dead hand rather than a mirror of the job's own schedule.
 */
export const WATCHDOG_INTERVAL_MS = 15 * 60_000;

/**
 * D-02: "~26h for a once-daily 03:00 UTC cron" -- one missed run plus slack,
 * so a single delayed tick (deploy, restart, brief outage) does not itself
 * trip a false alarm, but two consecutive missed runs always will.
 */
export const STALE_THRESHOLD_HOURS = 26;

export type PartitionHealthReason =
  | "missing_health_row"
  | "stale_last_run"
  | "low_buffer"
  | "events_default_nonzero"
  | "send_events_default_nonzero";

export interface PartitionHealthResult {
  healthy: boolean;
  reasons: PartitionHealthReason[];
}

export interface PartitionHealthThresholds {
  staleThresholdHours: number;
  bufferAlertThresholdMonths: number;
}

/**
 * Pure -- no I/O. Unhealthy when the health row is absent, when
 * `now - last_run_at` exceeds the stale threshold, when
 * `buffer_months_remaining` is below the configured threshold (the
 * comparison is INCLUSIVE at the boundary: exactly at the threshold is
 * healthy, one below is not), or when either DEFAULT partition's row count
 * is above zero. A missing or unreadable row evaluates unhealthy, NEVER
 * healthy -- a dead-man's switch that defaults to healthy on missing data is
 * worse than no switch at all (threat T-09-07).
 */
export function evaluatePartitionHealth(
  row: PartitionMaintenanceRunRow | null,
  now: Date,
  thresholds: PartitionHealthThresholds,
): PartitionHealthResult {
  if (!row) {
    return { healthy: false, reasons: ["missing_health_row"] };
  }

  const reasons: PartitionHealthReason[] = [];

  const ageMs = now.getTime() - row.lastRunAt.getTime();
  const staleThresholdMs = thresholds.staleThresholdHours * 60 * 60 * 1000;
  if (ageMs > staleThresholdMs) {
    reasons.push("stale_last_run");
  }

  if (row.bufferMonthsRemaining < thresholds.bufferAlertThresholdMonths) {
    reasons.push("low_buffer");
  }

  if (row.eventsDefaultCount > 0) {
    reasons.push("events_default_nonzero");
  }

  if (row.sendEventsDefaultCount > 0) {
    reasons.push("send_events_default_nonzero");
  }

  return { healthy: reasons.length === 0, reasons };
}

/**
 * D-04: plain-text body only -- table names, per-table buffer months, both
 * DEFAULT counts, `last_run_at`, and an explicit instruction to run the
 * DEFAULT-relocation procedure when a DEFAULT count is above zero (closes
 * D-10's detection -> operator -> script loop). Carries ONLY table names,
 * month/count numbers and timestamps -- never row contents, workspace ids,
 * contact ids, connection strings, or any part of the SendGrid key (threat
 * T-09-03).
 */
export function renderOperatorAlertText(
  row: PartitionMaintenanceRunRow | null,
  reasons: PartitionHealthReason[],
  now: Date,
): string {
  const lines: string[] = [];
  lines.push("Mega CRM partition maintenance alert");
  lines.push("");
  lines.push(`Checked at (UTC): ${now.toISOString()}`);
  lines.push(`Tripped condition(s): ${reasons.join(", ")}`);
  lines.push("");

  if (!row) {
    lines.push(
      "No partition_maintenance_runs row was found -- the partition maintenance job may never have run.",
    );
    return lines.join("\n");
  }

  lines.push(`Last run at (UTC): ${row.lastRunAt.toISOString()}`);
  lines.push(
    `events: buffer ${row.eventsBufferMonths} month(s) remaining, ${row.eventsDefaultCount} row(s) in events_default`,
  );
  lines.push(
    `send_events: buffer ${row.sendEventsBufferMonths} month(s) remaining, ${row.sendEventsDefaultCount} row(s) in send_events_default`,
  );

  if (row.eventsDefaultCount > 0 || row.sendEventsDefaultCount > 0) {
    lines.push("");
    lines.push(
      "ACTION REQUIRED: one or both DEFAULT partitions hold rows. Run the DEFAULT-relocation " +
        "procedure (npm run relocate:default-partition-rows -- see docs/runbooks/relocate-default-partition-rows.md).",
    );
  }

  return lines.join("\n");
}

export interface OperatorAlertMessage {
  to: string;
  text: string;
}

export interface PartitionWatchdogDeps {
  client: PartitionClient;
  now: Date;
  operatorEmail: string;
  sendMail: (message: OperatorAlertMessage) => Promise<void>;
}

/**
 * Reads the latest health row, evaluates it, and -- on any unhealthy
 * evaluation -- sends the plain-text operator alert. A `sendMail` rejection
 * is left to propagate (never caught here): the watchdog's own caller
 * decides what to do with a failed send, and swallowing it here would make a
 * failed alert indistinguishable from a healthy run.
 *
 * 09-01 task 1: sends on EVERY unhealthy evaluation. The atomic
 * once-per-day claim (D-03's actual cadence target) is added in task 2 via
 * `claimAlertSlot`.
 */
export async function checkPartitionHealthAndAlert(deps: PartitionWatchdogDeps): Promise<void> {
  const row = await readLatestMaintenanceRun(deps.client);
  const result = evaluatePartitionHealth(row, deps.now, {
    staleThresholdHours: STALE_THRESHOLD_HOURS,
    bufferAlertThresholdMonths: BUFFER_ALERT_THRESHOLD_MONTHS,
  });

  if (result.healthy) return;

  const text = renderOperatorAlertText(row, result.reasons, deps.now);
  await deps.sendMail({ to: deps.operatorEmail, text });
}

export interface StartPartitionWatchdogDeps {
  client: PartitionClient;
  operatorEmail: string;
  sendMail: (message: OperatorAlertMessage) => Promise<void>;
}

/**
 * Registers the `WATCHDOG_INTERVAL_MS` poll and returns the interval handle
 * (caller owns clearing it). NOT wired into `apps/api/src/server.ts` by this
 * plan -- that boot-time call is 09-02's. A rejected check (e.g. a failed
 * send) is logged rather than crashing the interval -- there is no caller
 * here to propagate to; this is the outermost boundary.
 */
export function startPartitionWatchdog(deps: StartPartitionWatchdogDeps): NodeJS.Timeout {
  return setInterval(() => {
    void checkPartitionHealthAndAlert({ ...deps, now: new Date() }).catch((err: unknown) => {
      console.error("partition-watchdog: health check failed", err);
    });
  }, WATCHDOG_INTERVAL_MS);
}
