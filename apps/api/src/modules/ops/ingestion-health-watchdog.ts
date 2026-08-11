import type { PoolClient } from "pg";
import { scrubbedConsole } from "@mega-crm/redaction";
import { withCrossWorkspaceScan } from "@mega-crm/tenant-context";
import {
  findStuckIngressJournalRows,
  INGRESS_JOURNAL_STUCK_THRESHOLD_MINUTES,
} from "@mega-crm/db/src/webhooks/ingress-journal.js";

/**
 * Phase 13 (CMP-08, plan 13-11): the FOURTH operator watchdog in
 * `apps/api/src/modules/ops/`, a deliberate SIBLING of `dead-letter-watchdog.ts`
 * (same shape: a periodic check, an atomic single-statement alert claim for
 * deduplication, a plain-text mail to the operator address through the
 * platform's OWN `PLATFORM_SENDGRID_API_KEY` -- never a tenant's BYO key,
 * never a Dynamic Template). Plan 13-06's replay sweep and plan 13-01's
 * `ingress_journal` (migration 0055) both already exist; this module turns
 * "ingestion is losing events" into an email.
 *
 * ONE structural departure from every prior watchdog in this directory: this
 * is the FIRST one whose health read touches an RLS-FORCED, tenant-scoped
 * table (`ingress_journal` carries real recipient PII and the same
 * fail-closed `workspace_isolation` policy every tenant table in this
 * codebase does -- migration 0055's own header). Every earlier watchdog
 * table (`partition_maintenance_runs`, `send_reconciler_runs`,
 * `dead_letter_jobs`/`dead_letter_alert_state`) is platform-operations
 * metadata with NO RLS at all, so the app's own tenant pool could always see
 * every row unconditionally. That is not true here: a platform-wide "how
 * many workspaces have stuck rows" question genuinely cannot be answered by
 * a tenant-scoped connection under the fail-closed predicate. `readIngestionHealth`
 * is therefore ALWAYS invoked through `withCrossWorkspaceScan` (the dedicated
 * `mega_crm_scan` role, migration 0055's `GRANT SELECT` + `ingress_journal_scan`
 * policy) -- `checkIngestionHealthAndAlert` wraps that call internally, so no
 * caller of this module ever has to remember to do so itself. This is the
 * FIRST time `apps/api` (as opposed to `apps/worker`) imports
 * `withCrossWorkspaceScan` -- `apps/api/src/__tests__/env-schema.test.ts`'s
 * P3 invariant ("no file under apps/api/src imports withCrossWorkspaceScan")
 * predates this plan and is narrowed to an explicit one-file allowlist in the
 * same change, with a comment recording why (see that test file).
 *
 * Operational consequence worth stating plainly (not asked for by the plan's
 * text, but true and easy to miss): unlike every prior watchdog, this one's
 * `apps/api` RUNTIME now needs `SCAN_DATABASE_URL` present in `process.env`
 * (never in `apps/api/src/env.ts`'s zod schema -- P3's letter is unchanged,
 * only its practical boot-time dependency). If it is absent in a given
 * deployment, `buildServer()`/boot still succeeds (this module is
 * parameter-driven and never reads env itself), but every
 * `INGESTION_WATCHDOG_INTERVAL_MS` tick throws inside `withCrossWorkspaceScan`'s
 * `getScanPool()`, which this module's own `startIngestionHealthWatchdog`
 * interval-catch logs via `scrubbedConsole.error` and swallows -- the
 * ingestion-loss alert then silently never fires. This is exactly the T-13-11-08
 * failure mode the plan calls out; the fix is an operational prerequisite
 * (set `SCAN_DATABASE_URL` in `apps/api`'s deployed environment), not a code
 * change.
 *
 * The claim half (`ingestion_alert_state`, migration 0058 -- created in that
 * migration's slot, one wave ahead of this plan, exactly like
 * `reputation_alert_state`) carries NO RLS and is owned by `mega_crm_app`, so
 * `claimIngestionAlertSlot`/the release-on-failure statement below use the
 * ordinary tenant pool (`deps.client` -- the same `pool` from
 * `@mega-crm/tenant-context` every sibling watchdog is wired with in
 * `apps/api/src/server.ts`) -- NOT the scan pool. One check therefore spans
 * two different roles/pools: a scan-role READ for the platform-wide
 * ingestion question, and an app-role WRITE for the platform-operations
 * alert-dedup bookkeeping. This split is deliberate, not an oversight -- see
 * `checkIngestionHealthAndAlert`'s own comment below.
 */

/** D-06: matches `webhook-replay-sweep.worker.ts`'s own 5-minute sweep cadence, so a row that just became stuck is visible to this alert within roughly one sweep tick of it becoming actionable. */
export const INGESTION_WATCHDOG_INTERVAL_MS = 5 * 60_000;

/**
 * D-06: the same 6-hour window `dead-letter-watchdog.ts`/`send-reconciler-watchdog.ts`
 * use, for the same reason -- the underlying replay sweep runs every few
 * minutes, so a window this short still catches a genuinely worsening
 * condition without re-alerting on one the platform is already actively
 * retrying.
 */
export const INGESTION_ALERT_DEDUP_HOURS = 6;

/**
 * REVIEWS.md (Codex follow-up) WARNING finding 6: 72 hours, several times
 * the 6-hour dedup window above so a fresh transition into "permanently
 * unrecoverable" can never be missed between checks. Deliberately NOT
 * "alert whenever any tombstone exists" -- plan 13-01 retains tombstones
 * INDEFINITELY (their own doc comment), so a mere-existence trigger would
 * re-fire forever on a loss the operator has already read about and cannot
 * undo -- exactly the alert-fatigue failure (T-13-11-10) that trains an
 * operator to filter this sender. Alerting on RECENCY of `payload_purged_at`
 * is what makes this alert carry news; the standing total still rides along
 * in every body that IS sent (see `renderIngestionAlertText`) so it never
 * becomes invisible between transitions.
 */
export const INGESTION_UNRECOVERABLE_ALERT_WINDOW_HOURS = 72;

/**
 * Mirrors `WEBHOOK_REPLAY_MAX_ATTEMPTS` (`apps/worker/src/queues/webhook-replay-sweep.worker.ts`)
 * by VALUE, not by import: `apps/api` has no dependency on `apps/worker` (a
 * private app, not a shared package) and this module must not create one
 * for a single constant. `findStuckIngressJournalRows` (plan 13-01) returns
 * `replay_count` on every row specifically so this watchdog can classify
 * attempt-capped rows itself, from the SAME read the sweep's own cap check
 * uses -- the two constants must be kept in sync by hand if the sweep's own
 * value ever changes. Documented in this plan's SUMMARY as a known
 * cross-app duplication, not a shared-package extraction, since the plan's
 * declared file scope does not include either `packages/db` or
 * `apps/worker`.
 */
const INGESTION_ATTEMPT_CAP_THRESHOLD = 5;

/**
 * A generous, explicit bound rather than an unbounded read: this is an
 * operator-facing COUNT query, not a batch-processing page (unlike
 * `WEBHOOK_REPLAY_SWEEP_PAGE_LIMIT = 200`, sized for a single tick's safe
 * enqueue throughput). Truncating this read would silently UNDERCOUNT the
 * very numbers this alert exists to report accurately -- a limit sized for
 * replay throughput would be exactly wrong here. 50,000 is comfortably above
 * any plausible incomplete-row backlog at this platform's current scale
 * (see PROJECT.md's 100k-1M contact target) while still bounding worst-case
 * memory during a genuine mass-loss event.
 */
const INGESTION_HEALTH_SCAN_LIMIT = 50_000;

export interface IngestionAlertStateClient {
  query<T = Record<string, unknown>>(queryText: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface IngestionHealthSnapshot {
  /** Incomplete rows that are neither attempt-capped nor tombstoned -- the platform is still actively retrying. */
  stuckCount: number;
  /** Incomplete, non-tombstoned rows whose `replay_count` has reached `INGESTION_ATTEMPT_CAP_THRESHOLD` -- the payload still exists; an operator can act via the range-replay CLI. */
  attemptCappedCount: number;
  /** Rows whose `payload_purged_at` is non-null -- a confirmed, permanent ingestion loss for that batch. Mutually exclusive with the two counts above (classified first). */
  unrecoverableCount: number;
  /** Subset of `unrecoverableCount` whose `payload_purged_at` falls within `INGESTION_UNRECOVERABLE_ALERT_WINDOW_HOURS` of `now` -- this is what drives the alert TRIGGER (see module header); the full `unrecoverableCount` is still always reported in the body. */
  recentlyPurgedCount: number;
  /** The earliest `received_at` across every row this read returned, or `null` when there are none. */
  oldestReceivedAt: Date | null;
  /** Distinct `workspace_id`s across every row this read returned. */
  affectedWorkspaceIds: string[];
}

/**
 * Reads incomplete `ingress_journal` rows past the stuck threshold and
 * partitions them into three MUTUALLY EXCLUSIVE counts -- REVIEWS.md (Codex)
 * WARNING finding 6. Classification order matters and is fixed: a purged row
 * that also happens to be attempt-capped is unrecoverable, never
 * double-counted as attempt-capped too (a purged row has no payload left to
 * cap retries against in the first place).
 *
 * `client` is always the scan-role connection in production
 * (`checkIngestionHealthAndAlert` wraps this call in `withCrossWorkspaceScan`
 * itself) -- see this module's own header for why a tenant-scoped connection
 * cannot answer this platform-wide question at all under `ingress_journal`'s
 * fail-closed RLS predicate.
 */
export async function readIngestionHealth(client: PoolClient, now: Date): Promise<IngestionHealthSnapshot> {
  const rows = await findStuckIngressJournalRows(client, INGRESS_JOURNAL_STUCK_THRESHOLD_MINUTES, INGESTION_HEALTH_SCAN_LIMIT);

  const purgedWindowStart = new Date(now.getTime() - INGESTION_UNRECOVERABLE_ALERT_WINDOW_HOURS * 60 * 60 * 1000);
  const workspaceIds = new Set<string>();

  let stuckCount = 0;
  let attemptCappedCount = 0;
  let unrecoverableCount = 0;
  let recentlyPurgedCount = 0;
  let oldestReceivedAt: Date | null = null;

  for (const row of rows) {
    workspaceIds.add(row.workspaceId);
    if (oldestReceivedAt === null || row.receivedAt < oldestReceivedAt) {
      oldestReceivedAt = row.receivedAt;
    }

    // Classification order is fixed (see this function's own doc comment):
    // unrecoverable (tombstoned) FIRST, then attempt-capped, then stuck.
    if (row.payloadPurgedAt !== null) {
      unrecoverableCount += 1;
      if (row.payloadPurgedAt >= purgedWindowStart) {
        recentlyPurgedCount += 1;
      }
      continue;
    }
    if (row.replayCount >= INGESTION_ATTEMPT_CAP_THRESHOLD) {
      attemptCappedCount += 1;
      continue;
    }
    stuckCount += 1;
  }

  return {
    stuckCount,
    attemptCappedCount,
    unrecoverableCount,
    recentlyPurgedCount,
    oldestReceivedAt,
    affectedWorkspaceIds: [...workspaceIds],
  };
}

/**
 * D-06/T-13-11-02: plain-text body naming all three counts (always, whenever
 * an email is sent -- even the tombstone-only trigger case reports the
 * FULL standing tombstone total, not only the recently-purged ones), the
 * oldest row's age, and the affected workspace ids. Workspace ids are
 * included deliberately (the plan's own instruction: "Include workspace ids
 * but no payload content, no recipient address, and no contact identifier")
 * -- this is a notification telling an operator where to look, not an
 * export.
 */
export function renderIngestionAlertText(snapshot: IngestionHealthSnapshot, now: Date): string {
  const lines: string[] = [];
  lines.push("Mega CRM ingestion health alert");
  lines.push("");
  lines.push(`Checked at (UTC): ${now.toISOString()}`);
  lines.push(`Stuck rows (still retrying): ${snapshot.stuckCount}`);
  lines.push(`Attempt-capped rows (payload present, retries exhausted): ${snapshot.attemptCappedCount}`);
  lines.push(`Permanently unrecoverable rows (payload purged): ${snapshot.unrecoverableCount}`);
  lines.push(`  of which purged in the last ${INGESTION_UNRECOVERABLE_ALERT_WINDOW_HOURS}h: ${snapshot.recentlyPurgedCount}`);
  if (snapshot.oldestReceivedAt) {
    lines.push(`Oldest affected row received at (UTC): ${snapshot.oldestReceivedAt.toISOString()}`);
  }
  lines.push(`Affected workspace(s): ${snapshot.affectedWorkspaceIds.join(", ")}`);
  lines.push("");
  lines.push(
    "ACTION REQUIRED: stuck/attempt-capped rows are candidates for the range-replay CLI " +
      "(scripts/replay-webhook-journal.ts); permanently unrecoverable rows have no payload left " +
      "to replay and represent confirmed ingestion loss for the affected workspace(s).",
  );

  return lines.join("\n");
}

export interface IngestionAlertMessage {
  to: string;
  text: string;
}

export interface IngestionHealthWatchdogDeps {
  /** The ordinary app-role pool (e.g. `@mega-crm/tenant-context`'s `pool`) -- used ONLY for the `ingestion_alert_state` claim, never for the `ingress_journal` read (see module header). */
  client: IngestionAlertStateClient;
  now: Date;
  operatorEmail: string;
  sendMail: (message: IngestionAlertMessage) => Promise<void>;
}

/**
 * A single conditional `UPDATE ... RETURNING` -- deliberately NOT a `SELECT`
 * followed by a separate `UPDATE`, for the exact multi-replica reasoning
 * every sibling watchdog's own `claimXAlertSlot` documents: `apps/api` runs
 * as multiple replicas, and a read-then-write pair would let N replicas each
 * independently decide "I should send" and all send. `last_seen_stuck_at` is
 * an extra `SET` column on the SAME single statement, mirroring
 * `claimDeadLetterAlertSlot`'s `last_seen_failed_at` -- a diagnostic value
 * (the oldest affected row's `received_at` this claim observed), deliberately
 * excluded from the `WHERE` predicate and from the release-on-failure
 * statement below.
 */
export async function claimIngestionAlertSlot(
  client: IngestionAlertStateClient,
  now: Date,
  dedupHours: number,
  oldestReceivedAt: Date | null = null,
): Promise<boolean> {
  const { rows } = await client.query(
    `UPDATE ingestion_alert_state
        SET last_alert_sent_at = $1::timestamptz,
            last_seen_stuck_at = $3::timestamptz,
            updated_at = now()
      WHERE id = 1
        AND (last_alert_sent_at IS NULL OR last_alert_sent_at < $1::timestamptz - make_interval(hours => $2))
      RETURNING last_alert_sent_at`,
    [now, dedupHours, oldestReceivedAt],
  );
  return rows.length > 0;
}

/**
 * Reads the current ingestion-health snapshot and, when the TRIGGER condition
 * is met, sends a single plain-text operator alert -- at most once per
 * `INGESTION_ALERT_DEDUP_HOURS` window. The trigger is deliberately narrower
 * than "reporting": `stuckCount > 0 || attemptCappedCount > 0 || recentlyPurgedCount > 0`
 * (see `INGESTION_UNRECOVERABLE_ALERT_WINDOW_HOURS`'s own doc comment for why
 * the trigger uses RECENCY of a purge rather than the mere existence of a
 * tombstone). Returns early without sending, and without touching
 * `ingestion_alert_state` at all, when nothing has crossed the trigger, or
 * when the atomic claim is refused (another replica already claimed this
 * window, or this process already sent recently).
 *
 * The read and the claim run on two DIFFERENT connections/roles -- this is
 * the deliberate departure this module's own header explains: `ingress_journal`
 * is RLS-forced and needs the scan role (`withCrossWorkspaceScan`, wrapped
 * HERE so no caller has to remember it); `ingestion_alert_state` carries no
 * RLS and is written through the ordinary app-role `deps.client`. Wrapping
 * the scan call inside this function (rather than requiring the caller to
 * pass an already-scanned client) is what keeps `startIngestionHealthWatchdog`'s
 * own wiring identical in SHAPE to every sibling watchdog's `{ client,
 * operatorEmail, sendMail }` deps, even though the read underneath it is
 * structurally different.
 *
 * CR-02 (mirrors every sibling's `checkXHealthAndAlert`): `claimIngestionAlertSlot`
 * necessarily commits `last_alert_sent_at` BEFORE `sendMail` is attempted --
 * that ordering is what makes the claim atomic across replicas. A rejected
 * `sendMail` releases the slot (guarded to only clear the exact value THIS
 * call just set) before rethrowing, so the very next check -- this replica or
 * another, still inside the same dedup window -- can claim and actually send.
 */
export async function checkIngestionHealthAndAlert(deps: IngestionHealthWatchdogDeps): Promise<void> {
  const snapshot = await withCrossWorkspaceScan((scanClient) => readIngestionHealth(scanClient, deps.now));

  const shouldAlert = snapshot.stuckCount > 0 || snapshot.attemptCappedCount > 0 || snapshot.recentlyPurgedCount > 0;
  if (!shouldAlert) return;

  const claimed = await claimIngestionAlertSlot(deps.client, deps.now, INGESTION_ALERT_DEDUP_HOURS, snapshot.oldestReceivedAt);
  if (!claimed) return;

  const text = renderIngestionAlertText(snapshot, deps.now);
  try {
    await deps.sendMail({ to: deps.operatorEmail, text });
  } catch (err) {
    await deps.client
      .query(
        `UPDATE ingestion_alert_state
            SET last_alert_sent_at = NULL
          WHERE id = 1
            AND last_alert_sent_at = $1::timestamptz`,
        [deps.now],
      )
      .catch(() => undefined);
    throw err;
  }
}

export interface StartIngestionHealthWatchdogDeps {
  client: IngestionAlertStateClient;
  operatorEmail: string;
  sendMail: (message: IngestionAlertMessage) => Promise<void>;
}

/**
 * Registers the `INGESTION_WATCHDOG_INTERVAL_MS` poll and returns the
 * interval handle (caller owns clearing it). NOT wired into
 * `apps/api/src/server.ts` by this module -- that boot-time call is task 3's
 * job. A rejected check (e.g. a scan-permission failure, or a failed send) is
 * logged rather than crashing the interval -- there is no caller here to
 * propagate to; this is the outermost boundary, mirroring every sibling
 * watchdog's own `startXWatchdog`.
 */
export function startIngestionHealthWatchdog(deps: StartIngestionHealthWatchdogDeps): NodeJS.Timeout {
  return setInterval(() => {
    void checkIngestionHealthAndAlert({ ...deps, now: new Date() }).catch((err: unknown) => {
      scrubbedConsole.error("ingestion-health-watchdog: health check failed", err);
    });
  }, INGESTION_WATCHDOG_INTERVAL_MS);
}
