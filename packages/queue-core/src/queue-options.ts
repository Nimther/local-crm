/**
 * Single source for the send lane's BullMQ timing/retry numbers (Phase 11,
 * D-15, DLV-06/DLV-09) and the retention-parameterised job-options factory
 * (Phase 12, WRK-11, D-10). Previously `apps/worker/src/queues/queue-options.ts`
 * was written expressly to be absorbed here -- its own doc comments named
 * three literal copies of `{attempts: 5, backoff: {type: "exponential",
 * delay: 2000}}` (`campaign-broadcast-producer.ts`, `campaign-queues.ts`,
 * `flows/flow-queues.ts`); this consolidation collapsed the worker-side
 * copies into imports of `buildJobOptions` and these constants (the
 * application-side copies close in plan 12-11).
 */

/**
 * Explicit BullMQ `lockDuration` for both send Workers (D-15) -- replacing
 * BullMQ's implicit 30s default. A value this load-bearing must be visible,
 * versioned configuration, not a library default nobody chose on purpose
 * (Phase 9 D-12 convention: a change here must be visible in a diff).
 *
 * RESEARCH.md Pitfall 5 / ARCHITECTURE.md §9: BullMQ's lock-renewal timer is
 * independent of the job processor's own promise -- a hung `sendTenantMailV3`
 * call that outlives this lock lets BullMQ's stalled-checker redeliver the
 * job to a SECOND live worker while the FIRST worker's call is still
 * pending, producing two live processors racing to write the same `sends`
 * row. `send-timing-invariant.test.ts` asserts
 * `SENDGRID_TIMEOUT_MS + CLAIM_TX_MARGIN_MS + RECORD_TX_MARGIN_MS <
 * SEND_LOCK_DURATION_MS` against the real exported values below, so any
 * future edit to any of the four numbers re-runs this specific invariant.
 */
export const SEND_LOCK_DURATION_MS = 60_000;

/** Budget for the claim transaction (unit 1) that runs BEFORE the SendGrid call. */
export const CLAIM_TX_MARGIN_MS = 5_000;

/** Budget for the terminal-write transaction (unit 3) that runs AFTER the SendGrid call. */
export const RECORD_TX_MARGIN_MS = 5_000;

/**
 * Bounded provider-backoff retry budget (D-10) -- the shared attempts/backoff
 * shape every worker-side and application-side queue's job options are built
 * from via `buildJobOptions` below.
 */
export const SEND_JOB_MAX_ATTEMPTS = 5;
export const SEND_JOB_BACKOFF_DELAY_MS = 2_000;

/** BullMQ's exponential backoff series between `attempts` redeliveries: `delay*2^0 + delay*2^1 + ... `. */
function computeExponentialBackoffSumMs(attempts: number, delayMs: number): number {
  let sum = 0;
  for (let i = 0; i < attempts - 1; i += 1) {
    sum += delayMs * 2 ** i;
  }
  return sum;
}

/**
 * Floor for a stale-`dispatching` sweep threshold (D-08) -- the longest a
 * legitimately in-flight job could still be retrying before BullMQ gives up
 * entirely on it: `SEND_JOB_MAX_ATTEMPTS` redeliveries, each potentially
 * holding the lock for up to `SEND_LOCK_DURATION_MS`, separated by the
 * exponential backoff series between them, PLUS one extra `SEND_LOCK_DURATION_MS`
 * of margin so this value is strictly GREATER than the raw attempt budget,
 * not merely equal to it (a sweep threshold equal to the exact floor would
 * have zero slack against clock skew/scheduling jitter).
 *
 * 11-07/11-08's stale-`dispatching` sweep threshold MUST exceed this value
 * with its own additional margin -- computed here (not hand-typed) so a
 * change to any constant above changes this floor automatically, and any
 * consumer importing it sees the new value instead of silently disagreeing
 * with a stale, separately-maintained number.
 */
export const SEND_MAX_JOB_LIFETIME_MS =
  SEND_JOB_MAX_ATTEMPTS * SEND_LOCK_DURATION_MS +
  computeExponentialBackoffSumMs(SEND_JOB_MAX_ATTEMPTS, SEND_JOB_BACKOFF_DELAY_MS) +
  SEND_LOCK_DURATION_MS;

/**
 * Bounded failed-job retention (Phase 12, WRK-09, D-10, Pitfall 7): the age,
 * in seconds, that a queue built with `STANDARD_JOB_RETENTION` keeps a
 * failed job in Redis before BullMQ removes it. Three points fix this at
 * seven days rather than any shorter number:
 *
 * 1. Anything feeding the reconciliation or dead-letter path must outlive
 *    the delivery reconciliation window with REAL margin, so the unit here
 *    is days, not minutes -- `RECONCILE_RESCAN_HORIZON_MS`
 *    (`@mega-crm/delivery-core`, 72h) is the widest of the reconciler's two
 *    windows, and seven days (168h) clears it with a ~2.33x margin, which
 *    also clears the narrower 24h `RECONCILE_RESOLUTION_WINDOW_MS`.
 * 2. Seven days gives an operator a full working week to inspect or replay
 *    a failed job directly in Redis, while the durable `dead_letter_jobs`
 *    row (`packages/queue-core/src/dead-letter-writer.ts`) remains the
 *    authoritative, permanent record regardless of when Redis ages this
 *    copy out.
 * 3. Bounding this value is ONLY safe because terminal failures are
 *    recorded in Postgres first: `attachSharedErrorListeners`
 *    (`packages/queue-core/src/error-listeners.ts`, WRK-08, wired to every
 *    worker in `apps/worker/src/server.ts`) invokes the dead-letter writer
 *    on every `worker.on("failed", ...)` terminal failure BEFORE this
 *    retention age can ever elapse. If that listener or the writer is ever
 *    removed from a queue, this bound must be reverted to `false` first,
 *    not after -- see `apps/worker/src/queues/__tests__/failed-job-retention.test.ts`'s
 *    header comment for the same ordering rule, enforced there.
 */
export const FAILED_JOB_RETENTION_SECONDS = 7 * 24 * 60 * 60;

/**
 * Retention shapes (Phase 12, WRK-09/WRK-11, D-10, Pitfall 6): `STANDARD_JOB_RETENTION`
 * is the shape most queues use today, now with the bounded
 * `FAILED_JOB_RETENTION_SECONDS` age above; `FLOW_RUN_ADVANCE_RETENTION` is
 * `flow-run-advance`'s own deliberately DIFFERENT shape (CR-01 fix, 06-12) --
 * see that queue's own comment at its call site
 * (`apps/worker/src/queues/flows/flow-queues.ts`) for why its retention
 * differs. `removeOnComplete: true` there means a completed advance job is
 * removed immediately so a future wake for the SAME run can never be
 * shadowed by a still-retained completed job under a reused id (BullMQ's
 * `Queue.add()` no-ops while a job with the given id exists in ANY state).
 *
 * `buildJobOptions` takes retention as a REQUIRED parameter, with no
 * default, typed as the union of EXACTLY these two shapes -- a factory that
 * baked in one retention shape, or accepted an arbitrary third one, would
 * let the differentiated policy be lost silently and reintroduce the
 * shadowed-wake bug this repository already fixed once.
 */
export const STANDARD_JOB_RETENTION = {
  removeOnComplete: { age: 86_400 },
  removeOnFail: { age: FAILED_JOB_RETENTION_SECONDS },
} as const;

export const FLOW_RUN_ADVANCE_RETENTION = {
  removeOnComplete: true,
  removeOnFail: { age: 86_400 },
} as const;

type JobRetention = typeof STANDARD_JOB_RETENTION | typeof FLOW_RUN_ADVANCE_RETENTION;

export interface BuiltJobOptions {
  attempts: number;
  backoff: { type: "exponential"; delay: number };
  removeOnComplete: JobRetention["removeOnComplete"];
  removeOnFail: JobRetention["removeOnFail"];
}

/**
 * Builds a queue's `defaultJobOptions` (or a per-job options object) from
 * the shared attempts/backoff shape plus a per-queue retention choice.
 * Behavior (attempts/backoff) is identical for every caller -- only
 * retention varies, and only between the two shapes named above.
 */
export function buildJobOptions(retention: JobRetention): BuiltJobOptions {
  return {
    attempts: SEND_JOB_MAX_ATTEMPTS,
    backoff: { type: "exponential", delay: SEND_JOB_BACKOFF_DELAY_MS },
    ...retention,
  };
}
