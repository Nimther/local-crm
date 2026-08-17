/**
 * Phase 15 (OPS-13, plan 15-14, Task 1): the third OPS-13 alert -- answers
 * "is delivery evidence still arriving from SendGrid", as distinct from
 * `ingestion-health-watchdog.ts` (Phase 13, plan 13-11), which answers "is a
 * batch of already-arrived webhook events failing to finish processing".
 * Those are genuinely different incidents: ingestion-health-watchdog can be
 * perfectly HEALTHY (zero stuck/attempt-capped/unrecoverable rows) while
 * SendGrid has stopped sending webhooks entirely -- there is nothing stuck
 * to report because nothing new is arriving to get stuck. Conversely this
 * watchdog can be HEALTHY (a recent webhook just arrived) while a handful of
 * older batches are individually stuck mid-processing. Distinct dedup
 * windows (this module's own `WEBHOOK_LAG_ALERT_DEDUP_HOURS` vs
 * `INGESTION_ALERT_DEDUP_HOURS`) and distinct claim names in the shared
 * `ops_alert_state` table (`webhook-lag` vs a dedicated
 * `ingestion_alert_state` row) mean the two can never suppress or duplicate
 * each other's alert.
 *
 * DATA SOURCE, and why (T-15-46, the receipt-timestamp trap this plan's own
 * threat register names): the obvious first candidates -- `send_events.received_at`
 * and `ingress_journal.received_at` -- turned out to be unusable without a
 * new migration. `send_events` has no `mega_crm_scan` grant of any kind
 * (verified against every migration through 0064). `ingress_journal`'s scan
 * policy (migration 0055) is narrowed to `ingestion_completed_at IS NULL` --
 * in a healthy system a batch completes within seconds and vanishes from
 * the scan role's view entirely, making "no rows visible" indistinguishable
 * from "nothing has arrived in months". `sends`' own delivery-fact columns
 * (`deliveredAt`/`firstOpenedAt`/etc.) are written from `event.occurredAt`
 * (`setFactColumnOnce`, `packages/db/src/sends/fact-columns.ts`) -- a
 * PROVIDER-supplied timestamp, exactly what this plan's own action text
 * forbids using as the lag input, even though Phase 13 bounds it.
 *
 * `workspace_webhook_endpoints.last_event_at` is the one signal that is
 * actually right: `debounceWebhookHealth`
 * (apps/worker/src/queues/webhook-events.worker.ts) sets it to `now()` on
 * EVERY processed webhook batch, for EVERY event type, debounced to at most
 * once per 60 seconds per workspace ("never per event", that function's own
 * doc comment) -- server-set, never a provider timestamp, and touched
 * regardless of whether that batch's ingestion later completes or stays
 * incomplete. It had no scan-role grant before this plan; migration 0065
 * (HUMAN-APPROVED override of this plan's own "no new migration"
 * prohibition -- see 15-14-SUMMARY.md's Deviations section) adds a
 * COLUMN-LEVEL `GRANT SELECT (last_event_at)` plus an unrestricted scan
 * policy, deliberately narrower than a table-level grant because this table
 * also carries `path_token` (the unguessable webhook-URL trust anchor) and
 * `public_key`, neither of which this alert has any use for.
 *
 * The "outstanding sends awaiting evidence" half reuses
 * `oldest-job-age-watchdog.ts`'s own `readOldestReconcilingSince` (the
 * platform-wide `MIN(reconciling_since)` over `sends`, via the SAME
 * `sends_scan` unrestricted policy that module already established) rather
 * than reimplementing an equivalent query -- one definition of "what counts
 * as an outstanding send", shared by both watchdogs. `sends.ts`'s own
 * `reconcilingSince` doc comment names this alert directly ("Phase 15's
 * webhook-lag alert queries this column directly") as the locked design for
 * this half.
 *
 * This module deliberately imports NO env module -- every dependency (the
 * Postgres client, the mail sender, the operator address) arrives through
 * the `deps` parameter; boot wiring happens in `apps/api/src/server.ts`,
 * this plan's Task 3, never here. The FOURTH apps/api file added to
 * `env-schema.test.ts`'s P3 `withCrossWorkspaceScan` allowlist (after
 * `ingestion-health-watchdog.ts`, `oldest-job-age-watchdog.ts`,
 * `failed-send-share-watchdog.ts`).
 */

import { withCrossWorkspaceScan } from "@mega-crm/tenant-context";
import { claimOpsAlertSlot, releaseOpsAlertSlot, type OpsAlertStateClient } from "@mega-crm/db/src/ops/alert-state.js";
import { scrubbedConsole } from "@mega-crm/redaction";
import { readOldestReconcilingSince } from "./oldest-job-age-watchdog.js";

/**
 * D-OPS-13: matches `queue-depth-watchdog.ts`'s/`oldest-job-age-watchdog.ts`'s
 * own 5-minute cadence -- a cheap MAX()/MIN() aggregate pair, same class of
 * poll frequency as the other lane-health watchdogs.
 */
export const WEBHOOK_LAG_WATCHDOG_INTERVAL_MS = 5 * 60_000;

/** D-OPS-13: the same 6-hour event-driven dedup convention every OPS-13/dead-letter/reconciler watchdog shares. */
export const WEBHOOK_LAG_ALERT_DEDUP_HOURS = 6;

/** The `ops_alert_state.alert_name` this watchdog claims under -- independent of the other three OPS-13 alerts' own names/windows. */
export const WEBHOOK_LAG_ALERT_NAME = "webhook-lag";

/**
 * FLAGGED ASSUMPTION (15-14-PLAN.md's own flagged-assumption note): a first
 * estimate, not validated against a real production load test.
 * `debounceWebhookHealth` writes at most once per 60 seconds per workspace
 * whenever a batch arrives, so under genuinely healthy delivery this value
 * should almost never approach even a fraction of this threshold. 60
 * minutes is generous enough to tolerate a quiet stretch between
 * legitimately infrequent webhook batches (a small tenant with modest send
 * volume) and a brief worker restart, while still catching a genuinely
 * stopped SendGrid Event Webhook (a de-provisioned webhook, a revoked
 * signing key, a suspended account) well within SendGrid's own ~24h retry
 * window for anything that WAS still being attempted. Tune from real
 * operation once this system has one.
 */
export const WEBHOOK_LAG_ALERT_MINUTES = 60;

export interface WebhookEndpointsScanClient {
  query<T = Record<string, unknown>>(queryText: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/**
 * The platform-wide newest `last_event_at` across every workspace's
 * `workspace_webhook_endpoints` row -- `client` is always the scan-role
 * connection in production (`checkWebhookLagHealthAndAlert` wraps this call
 * in `withCrossWorkspaceScan` itself, mirroring every sibling watchdog's own
 * convention) -- a tenant-scoped connection cannot answer this
 * platform-wide question at all under this table's fail-closed RLS
 * predicate, and even the scan role can only ever see the ONE column this
 * migration grants (`last_event_at`) -- see this module's own header.
 * Returns `null` when no webhook batch has EVER been recorded for any
 * workspace (either genuinely zero rows, or every row's `last_event_at` is
 * still its pre-webhook `NULL` default).
 */
export async function readNewestWebhookEventAt(client: WebhookEndpointsScanClient): Promise<Date | null> {
  const { rows } = await client.query<{ newest_last_event_at: Date | null }>(
    `SELECT MAX(last_event_at) AS newest_last_event_at FROM workspace_webhook_endpoints`,
  );
  return rows[0]?.newest_last_event_at ?? null;
}

export interface WebhookLagEvaluation {
  healthy: boolean;
  /** Human-readable lines -- ages in minutes and reason names only. Never a workspace id, contact email, or send id (T-15-42). */
  reasons: string[];
}

/**
 * Pure -- no I/O. The healthy-when-quiet rule is what makes this alert
 * usable at all: a system with NO sends outstanding awaiting evidence is
 * not lagging, it is idle, regardless of how old the newest webhook event
 * is -- checked FIRST, before the lag comparison even runs. Only once an
 * outstanding send exists does the newest-event age matter; a NEVER-recorded
 * event with outstanding sends is its own distinct unhealthy reason (never
 * conflated with "recorded once, long ago"). Boundary:
 * `lagMinutes > thresholds.lagAlertMinutes` is unhealthy;
 * `lagMinutes === thresholds.lagAlertMinutes` is healthy -- exactly at the
 * threshold is fine, matching every other watchdog's own documented
 * boundary convention.
 */
export function evaluateWebhookLagHealth(
  newestWebhookEventAt: Date | null,
  oldestReconcilingSince: Date | null,
  now: Date,
  thresholds: { lagAlertMinutes: number } = { lagAlertMinutes: WEBHOOK_LAG_ALERT_MINUTES },
): WebhookLagEvaluation {
  const hasOutstandingSends = oldestReconcilingSince !== null;
  if (!hasOutstandingSends) {
    return { healthy: true, reasons: [] };
  }

  if (newestWebhookEventAt === null) {
    return {
      healthy: false,
      reasons: ["webhook events have never been recorded, but sends are outstanding awaiting delivery evidence"],
    };
  }

  const lagMinutes = (now.getTime() - newestWebhookEventAt.getTime()) / 60_000;
  if (lagMinutes > thresholds.lagAlertMinutes) {
    return {
      healthy: false,
      reasons: [
        `newest webhook event is ${lagMinutes.toFixed(1)}min old, exceeds threshold ${thresholds.lagAlertMinutes}min, with sends outstanding awaiting delivery evidence`,
      ],
    };
  }

  return { healthy: true, reasons: [] };
}

/**
 * D-OPS-13/T-15-42: plain-text body only -- ages in minutes and reason
 * lines. NEVER a workspace id, contact id, send id, email address, or
 * SendGrid key: `reasons` (this function's only per-incident input) is
 * built exclusively from `evaluateWebhookLagHealth`, which itself only ever
 * touches timestamps and durations -- there is no code path by which tenant
 * data could reach this string.
 */
export function renderWebhookLagAlertText(reasons: string[], now: Date): string {
  const lines: string[] = [];
  lines.push("Mega CRM webhook-lag alert");
  lines.push("");
  lines.push(`Checked at (UTC): ${now.toISOString()}`);
  lines.push("Tripped condition(s):");
  for (const reason of reasons) {
    lines.push(`  - ${reason}`);
  }
  lines.push("");
  lines.push(
    "ACTION REQUIRED: check whether the affected tenant(s)' SendGrid Event Webhook is still provisioned and " +
      "enabled, whether the platform's webhook receipt endpoint is reachable from SendGrid, and whether " +
      "apps/worker's webhook-events queue is running and consuming.",
  );
  return lines.join("\n");
}

export interface WebhookLagAlertMessage {
  to: string;
  text: string;
}

export interface WebhookLagSignals {
  newestWebhookEventAt: Date | null;
  oldestReconcilingSince: Date | null;
}

export interface WebhookLagWatchdogDeps {
  client: OpsAlertStateClient;
  now: Date;
  operatorEmail: string;
  sendMail: (message: WebhookLagAlertMessage) => Promise<void>;
  /** Defaults to a real `withCrossWorkspaceScan` call reading both signals off ONE scan-role connection -- injectable so tests never require `SCAN_DATABASE_URL`/a live scan connection unless they want one. */
  readSignals?: () => Promise<WebhookLagSignals>;
  thresholds?: { lagAlertMinutes: number };
}

/**
 * Reads both signals (the newest webhook receipt, platform-wide; the oldest
 * outstanding `reconciling_since`, platform-wide) off ONE scan-role
 * connection, evaluates health, and -- on any unhealthy evaluation that
 * WINS the atomic per-`WEBHOOK_LAG_ALERT_DEDUP_HOURS`-window claim (via the
 * SHARED `claimOpsAlertSlot`, keyed by `WEBHOOK_LAG_ALERT_NAME`) -- sends
 * the plain-text operator alert. Returns early without sending, and without
 * touching `ops_alert_state`, when healthy or when the claim is refused
 * (another replica already claimed this window, or this process already
 * sent recently).
 *
 * Mirrors every sibling OPS-13 watchdog's CR-02 release-on-failure
 * discipline: a rejected `sendMail` releases the claim (via
 * `releaseOpsAlertSlot`) before rethrowing, so the very next check -- this
 * replica or another, still inside the same dedup window -- can claim and
 * actually send.
 */
export async function checkWebhookLagHealthAndAlert(deps: WebhookLagWatchdogDeps): Promise<void> {
  const readSignals =
    deps.readSignals ??
    (() =>
      withCrossWorkspaceScan(async (client) => {
        const [newestWebhookEventAt, oldestReconcilingSince] = await Promise.all([
          readNewestWebhookEventAt(client),
          readOldestReconcilingSince(client),
        ]);
        return { newestWebhookEventAt, oldestReconcilingSince };
      }));

  const signals = await readSignals();
  const result = evaluateWebhookLagHealth(signals.newestWebhookEventAt, signals.oldestReconcilingSince, deps.now, deps.thresholds);

  if (result.healthy) return;

  const claimed = await claimOpsAlertSlot(deps.client, WEBHOOK_LAG_ALERT_NAME, deps.now, WEBHOOK_LAG_ALERT_DEDUP_HOURS);
  if (!claimed) return;

  const text = renderWebhookLagAlertText(result.reasons, deps.now);
  try {
    await deps.sendMail({ to: deps.operatorEmail, text });
  } catch (err) {
    await releaseOpsAlertSlot(deps.client, WEBHOOK_LAG_ALERT_NAME, deps.now).catch(() => undefined);
    throw err;
  }
}

export interface StartWebhookLagWatchdogDeps {
  client: OpsAlertStateClient;
  operatorEmail: string;
  sendMail: (message: WebhookLagAlertMessage) => Promise<void>;
  readSignals?: () => Promise<WebhookLagSignals>;
  thresholds?: { lagAlertMinutes: number };
}

/**
 * Registers the `WEBHOOK_LAG_WATCHDOG_INTERVAL_MS` poll and returns the
 * interval handle (caller owns clearing it). NOT wired into
 * `apps/api/src/server.ts` by this module -- that boot-time call is this
 * plan's Task 3. A rejected check is logged rather than crashing the
 * interval -- this is the outermost boundary, mirroring every other
 * watchdog's own `start*Watchdog` function.
 */
export function startWebhookLagWatchdog(deps: StartWebhookLagWatchdogDeps): NodeJS.Timeout {
  return setInterval(() => {
    void checkWebhookLagHealthAndAlert({ ...deps, now: new Date() }).catch((err: unknown) => {
      scrubbedConsole.error("webhook-lag-watchdog: health check failed", err);
    });
  }, WEBHOOK_LAG_WATCHDOG_INTERVAL_MS);
}
