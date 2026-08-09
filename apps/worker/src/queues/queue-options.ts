/**
 * Single source for the send lane's BullMQ timing/retry numbers (Phase 11,
 * D-15, DLV-06/DLV-09). Deliberately its own file so Phase 12's WRK-11
 * queue-options consolidation absorbs THIS file rather than duplicating it
 * -- see `SEND_JOB_MAX_ATTEMPTS`/`SEND_JOB_BACKOFF_DELAY_MS` below for the
 * three existing literal copies WRK-11 is expected to collapse into an
 * import of these constants (not done here -- this plan only introduces the
 * shared destination).
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
 * Bounded provider-backoff retry budget (D-10) -- mirrors the THREE existing
 * literal copies of `{ attempts: 5, backoff: { type: "exponential", delay:
 * 2000 } }`:
 *   - `apps/worker/src/queues/campaign-broadcast-producer.ts`
 *   - `apps/api/src/modules/campaigns/campaign-queues.ts`
 *   - `apps/worker/src/queues/flows/flow-queues.ts`
 * Phase 12's WRK-11 is where those three collapse into an import of THESE
 * constants -- do not move them now; this plan only introduces the shared
 * destination they will eventually point at.
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
