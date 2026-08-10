/**
 * 12-10 (WRK-10, D-08): the third operator watchdog, over `dead_letter_jobs`
 * (migration 0054). A deliberate SIBLING of `partition-watchdog.ts` and
 * `send-reconciler-watchdog.ts`, not a fork: same twice-proven shape -- a
 * periodic check, an atomic single-statement alert claim for deduplication,
 * and a plain-text mail to the operator address through the platform's OWN
 * `PLATFORM_SENDGRID_API_KEY` (never a tenant's BYO key, never a Dynamic
 * Template -- an emergency channel must not depend on a template existing in
 * the platform SendGrid account).
 *
 * Structurally different from its two siblings in one respect: there is no
 * per-tick worker-written "health row" for this watchdog to read (no
 * `dead_letter_jobs_runs` analogue) -- instead this module reads the live
 * `dead_letter_jobs` table directly every check, aggregating the
 * unacknowledged rows into a small snapshot. The alert-dedup half is still a
 * singleton row (`dead_letter_alert_state`, seeded unconditionally by
 * migration 0054), exactly mirroring `partition_maintenance_runs`' and
 * `send_reconciler_runs`' own `last_alert_sent_at` bookkeeping.
 *
 * This module deliberately imports NO tenancy or KMS module and no env
 * module -- the platform key is the only credential it can ever reach, and
 * it never reads `apps/api/src/env.ts` directly. This module is
 * parameter-driven and never wired into `buildServer()`; the boot wiring is
 * `apps/api/src/server.ts`'s job (task 2 of this plan).
 */

/**
 * D-08: how often the watchdog polls Postgres for unacknowledged dead-letter
 * rows. A terminal failure can land at any moment (unlike the daily
 * partition job or the reconciler's ~5-minute tick), and the check itself is
 * a single indexed count query (`dead_letter_jobs_failed_at_idx`, migration
 * 0054) -- cheap enough to poll frequently without becoming its own load
 * concern.
 */
export const DEAD_LETTER_WATCHDOG_INTERVAL_MS = 5 * 60_000;

/**
 * D-08: matches `send-reconciler-watchdog.ts`'s shorter `RECONCILER_ALERT_DEDUP_HOURS`
 * window (6h), NOT `partition-watchdog.ts`'s daily `ALERT_DEDUP_HOURS` (20h)
 * -- the dead-letter signal is event-driven (a job can exhaust its attempts
 * at any time of day) rather than tied to a once-daily job's own cadence, so
 * copying the 20h window would leave a fresh terminal failure arriving
 * shortly after an earlier alert nearly silent for most of a day.
 */
export const DEAD_LETTER_ALERT_DEDUP_HOURS = 6;

export interface DeadLetterJobsClient {
  query<T = Record<string, unknown>>(queryText: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface DeadLetterHealthSnapshot {
  unacknowledgedCount: number;
  queueNames: string[];
  oldestFailedAt: Date | null;
}

interface RawDeadLetterHealthRow {
  unacknowledged_count: number | string;
  queue_names: string[] | null;
  oldest_failed_at: Date | null;
}

/**
 * Reads the unacknowledged rows -- count, distinct queue names and oldest
 * failure timestamp -- in a single query. Rows whose `acknowledged_at`
 * column is set are excluded by the `WHERE` clause, never counted and never
 * considered for the alert decision. `count(*)` always returns exactly one
 * row even over zero matching rows (`unacknowledgedCount` is `0`, not an
 * absent row), so this never needs a "row missing" branch the way the
 * siblings' singleton health-row readers do.
 */
export async function readDeadLetterHealth(client: DeadLetterJobsClient): Promise<DeadLetterHealthSnapshot> {
  const { rows } = await client.query<RawDeadLetterHealthRow>(
    `SELECT count(*)::int AS unacknowledged_count,
            array_remove(array_agg(DISTINCT queue_name), NULL) AS queue_names,
            min(failed_at) AS oldest_failed_at
       FROM dead_letter_jobs
      WHERE acknowledged_at IS NULL`,
  );
  const row = rows[0];
  return {
    unacknowledgedCount: row ? Number(row.unacknowledged_count) : 0,
    queueNames: row?.queue_names ?? [],
    oldestFailedAt: row?.oldest_failed_at ?? null,
  };
}

/**
 * D-08/T-12-10-01: plain-text body only -- the unacknowledged row count, the
 * affected queue names and the oldest failure timestamp. Deliberately never
 * includes any job payload field: the stored payload is already redacted
 * (`@mega-crm/redaction`'s `scrub`, the worker-side dead-letter writer), but
 * this alert is a notification, not an export -- keeping it free of job data
 * means the mail carries nothing that would ever need redacting in the first
 * place.
 */
export function renderDeadLetterAlertText(snapshot: DeadLetterHealthSnapshot, now: Date): string {
  const lines: string[] = [];
  lines.push("Mega CRM dead-letter alert");
  lines.push("");
  lines.push(`Checked at (UTC): ${now.toISOString()}`);
  lines.push(`Unacknowledged dead-letter rows: ${snapshot.unacknowledgedCount}`);
  lines.push(`Affected queue(s): ${snapshot.queueNames.join(", ")}`);
  if (snapshot.oldestFailedAt) {
    lines.push(`Oldest failure at (UTC): ${snapshot.oldestFailedAt.toISOString()}`);
  }
  lines.push("");
  lines.push(
    "ACTION REQUIRED: inspect the dead_letter_jobs table directly (no dashboard exists yet -- " +
      "see docs/runbooks) and acknowledge rows once the underlying failure has been handled.",
  );

  return lines.join("\n");
}

export interface DeadLetterAlertMessage {
  to: string;
  text: string;
}

export interface DeadLetterWatchdogDeps {
  client: DeadLetterJobsClient;
  now: Date;
  operatorEmail: string;
  sendMail: (message: DeadLetterAlertMessage) => Promise<void>;
}

/**
 * A single conditional `UPDATE ... RETURNING` -- deliberately NOT a `SELECT`
 * followed by a separate `UPDATE`, for the exact multi-replica reasoning
 * `claimAlertSlot` (`partition-watchdog.ts`) and `claimReconcilerAlertSlot`
 * (`send-reconciler-watchdog.ts`) both document: `apps/api` runs as multiple
 * replicas, and an in-memory dedup flag or a read-then-write pair would let N
 * replicas each independently decide "I should send" and all send. A single
 * statement makes Postgres's own row-level locking the arbiter -- two
 * concurrent claims against the same row can never both succeed, because the
 * first commit's new `last_alert_sent_at` value makes the second claim's own
 * WHERE clause re-evaluate to false once it proceeds.
 *
 * Also sets `last_seen_failed_at` to the newest failure timestamp this claim
 * observed (migration 0054's own stated intent for that column: "what was
 * the newest failure it had seen at that time"). This is an extra `SET`
 * column on the same single statement -- it does not turn this into a
 * read-then-write, and it is deliberately excluded from the `WHERE`
 * predicate and from the release-on-failure statement below: it is a
 * diagnostic value, not part of the dedup arbiter.
 *
 * The caller sends only when this resolves `true` (the UPDATE actually
 * matched and returned a row).
 */
export async function claimDeadLetterAlertSlot(
  client: DeadLetterJobsClient,
  now: Date,
  dedupHours: number,
  newestFailedAt: Date | null = null,
): Promise<boolean> {
  const { rows } = await client.query(
    `UPDATE dead_letter_alert_state
        SET last_alert_sent_at = $1::timestamptz,
            last_seen_failed_at = $3::timestamptz,
            updated_at = now()
      WHERE id = 1
        AND (last_alert_sent_at IS NULL OR last_alert_sent_at < $1::timestamptz - make_interval(hours => $2))
      RETURNING last_alert_sent_at`,
    [now, dedupHours, newestFailedAt],
  );
  return rows.length > 0;
}

/**
 * Reads the current unacknowledged-row snapshot and, when non-empty, sends a
 * single plain-text operator alert -- at most once per
 * `DEAD_LETTER_ALERT_DEDUP_HOURS` window. Returns early without sending, and
 * without touching `dead_letter_alert_state` at all, when the snapshot is
 * empty (D-08: "with no unacknowledged dead-letter rows the watchdog sends
 * nothing"), or when the atomic claim is refused (another replica already
 * claimed this window, or this process already sent recently).
 *
 * CR-02 (mirrors `checkPartitionHealthAndAlert`/`checkReconcilerHealthAndAlert`):
 * `claimDeadLetterAlertSlot` necessarily commits `last_alert_sent_at` BEFORE
 * `sendMail` is attempted -- that ordering is what makes the claim atomic
 * across replicas in the first place. A rejected `sendMail` must not leave
 * that claim in place, though: this releases the slot (resetting
 * `last_alert_sent_at` back to `NULL`) before rethrowing, so the very next
 * check -- this replica or another, still inside the same dedup window --
 * can claim and actually send. The release is itself guarded
 * (`WHERE ... last_alert_sent_at = $1`) to only clear the exact value THIS
 * call just set, and deliberately leaves `last_seen_failed_at` untouched (it
 * is a diagnostic value, not part of the dedup arbiter this release
 * protects). A `sendMail` rejection is left to propagate, never caught here
 * to be swallowed -- the caller decides what to do with a failed send.
 */
export async function checkDeadLetterHealthAndAlert(deps: DeadLetterWatchdogDeps): Promise<void> {
  const snapshot = await readDeadLetterHealth(deps.client);
  if (snapshot.unacknowledgedCount === 0) return;

  const claimed = await claimDeadLetterAlertSlot(
    deps.client,
    deps.now,
    DEAD_LETTER_ALERT_DEDUP_HOURS,
    snapshot.oldestFailedAt,
  );
  if (!claimed) return;

  const text = renderDeadLetterAlertText(snapshot, deps.now);
  try {
    await deps.sendMail({ to: deps.operatorEmail, text });
  } catch (err) {
    await deps.client
      .query(
        `UPDATE dead_letter_alert_state
            SET last_alert_sent_at = NULL
          WHERE id = 1
            AND last_alert_sent_at = $1::timestamptz`,
        [deps.now],
      )
      .catch(() => undefined);
    throw err;
  }
}

export interface StartDeadLetterWatchdogDeps {
  client: DeadLetterJobsClient;
  operatorEmail: string;
  sendMail: (message: DeadLetterAlertMessage) => Promise<void>;
}

/**
 * Registers the `DEAD_LETTER_WATCHDOG_INTERVAL_MS` poll and returns the
 * interval handle (caller owns clearing it). NOT wired into
 * `apps/api/src/server.ts` by this module -- that boot-time call is task 2's
 * job. A rejected check (e.g. a failed send) is logged rather than crashing
 * the interval -- there is no caller here to propagate to; this is the
 * outermost boundary, mirroring `startPartitionWatchdog`/`startSendReconcilerWatchdog`.
 */
export function startDeadLetterWatchdog(deps: StartDeadLetterWatchdogDeps): NodeJS.Timeout {
  return setInterval(() => {
    void checkDeadLetterHealthAndAlert({ ...deps, now: new Date() }).catch((err: unknown) => {
      console.error("dead-letter-watchdog: health check failed", err);
    });
  }, DEAD_LETTER_WATCHDOG_INTERVAL_MS);
}
