import type { SendStatus } from "./send-state-machine.js";

/**
 * Pure, I/O-free reconciliation verdict function (Phase 11, DLV-03/DLV-04,
 * plan 11-08). ARCHITECTURE.md ##9 ("The send delivery state machine") is
 * the transition authority this module is the executable classifier for --
 * every verdict below corresponds to exactly one transition already named
 * in that matrix and in `send-state-machine.ts`'s `SEND_STATUS_TRANSITIONS`.
 * This module decides WHAT should happen to a candidate row;
 * `apps/worker/src/queues/send-reconciler.worker.ts`'s `resolveOneSend` is
 * the only place a verdict becomes a write, and that write happens inside
 * the row's own `FOR UPDATE SKIP LOCKED` lock.
 *
 * `now` is always a parameter, never `Date.now()` read inside this module --
 * every window boundary must be testable without fake timers
 * (`reconciler-classify.test.ts` arranges fixed `Date` values around each
 * threshold).
 */

/**
 * Resolution window (D-07): how long a `reconciling` row may sit with no
 * webhook evidence before this module calls it honestly unresolvable.
 * SendGrid's normal acceptance-to-webhook path (`processed`/`delivered`/
 * bounce/etc.) completes in seconds to low minutes; a full day with no event
 * of ANY kind is the point at which "we will probably never learn what
 * happened" becomes the honest verdict, not an arbitrarily chosen number.
 * Versioned here -- not in ARCHITECTURE.md ##9, which names this window as a
 * concept on purpose -- so a future change to this value is visible in a
 * diff of ONE file, per the Phase 9 D-12 convention. Boundary: an age
 * EXACTLY equal to this value still holds (`hold`); the row must strictly
 * EXCEED the window before it resolves to `unknown`.
 */
export const RECONCILE_RESOLUTION_WINDOW_MS = 24 * 60 * 60_000;

/**
 * Re-scan horizon (D-04/D-07): how long, measured from `queuedAt`, an
 * `unknown` row remains eligible for a late-evidence upgrade to `sent`. Set
 * to SendGrid's own documented full deferral/retry cycle (~72h) -- a message
 * that was genuinely accepted and then repeatedly deferred by a receiving
 * mail server can still surface a delivered/bounce event well after the 24h
 * resolution window already closed the row to `unknown`; this horizon is
 * what lets that late evidence still count. Boundary: an age EXACTLY equal
 * to this value is still INSIDE the horizon (upgrades to `sent`); only an
 * age strictly GREATER makes the row immutable. Strictly greater than
 * `RECONCILE_RESOLUTION_WINDOW_MS` by construction (asserted in
 * `reconciler-classify.test.ts`) -- an `unknown` row is reachable only after
 * the resolution window has already elapsed, so a re-scan horizon that did
 * not exceed it would describe a window of rows that can never exist.
 */
export const RECONCILE_RESCAN_HORIZON_MS = 72 * 60 * 60_000;

/**
 * Stale-`dispatching` sweep threshold (D-08). This is a FLOOR, not a tuning
 * knob: it must exceed `SEND_MAX_JOB_LIFETIME_MS`
 * (`apps/worker/src/queues/queue-options.ts`) -- the longest a legitimately
 * in-flight send job could still be retrying (bounded `attempts` times
 * `SEND_LOCK_DURATION_MS`, plus the exponential backoff series between
 * them) -- with its own additional margin on top, so the sweep can never
 * claim a row whose worker job might still be alive and about to write its
 * own terminal/ambiguous result.
 *
 * `apps/worker/src/queues/__tests__/send-timing-invariant.test.ts` asserts
 * `STALE_DISPATCHING_AGE_MS > SEND_MAX_JOB_LIFETIME_MS` against the two REAL
 * exported constants -- that assertion could not live in THIS package's own
 * test project because `packages/delivery-core` does not (and must not)
 * depend on `apps/worker` (the workspace dependency points the other way:
 * `apps/worker` depends on `@mega-crm/delivery-core`, never the reverse);
 * see that test file's own comment for the mirror-image note. Phase 12's
 * WRK-11 queue-options consolidation must re-check this inequality if it
 * ever changes the retry budget -- this value is a floor computed FROM that
 * budget, not an independent choice.
 */
export const STALE_DISPATCHING_AGE_MS = 2 * 60 * 60_000;

/**
 * The reconciler's full verdict vocabulary. Deliberately NO `resolve_failed`
 * member: see ARCHITECTURE.md ##9's "Why the reconciler never writes
 * `failed`" -- webhook evidence is positive-only (SendGrid tells you what a
 * message DID do; it never emits an event proving a message was NEVER
 * accepted), so the reconciler has no way to observe failure and must not
 * invent one. Adding a fifth member here is a decision that needs a human
 * gate (ARCHITECTURE.md D-18's review), not a code-review comment.
 */
export type ReconcileVerdict =
  | { kind: "resolve_sent" }
  | { kind: "resolve_unknown" }
  | { kind: "sweep_to_reconciling" }
  | { kind: "hold" };

/**
 * Everything `classifyReconcilableSend` needs to decide a single candidate
 * row's verdict -- deliberately just data, no client, no query. `hasEvidence`
 * is a boolean, not the evidence itself: the reconciler never needs to know
 * WHAT the evidence says, only that at least one correlated `send_events`
 * row exists (D-01/D-05, classification-only, no provider calls anywhere in
 * this module or its caller).
 */
export interface ReconcileInput {
  status: SendStatus;
  queuedAt: Date;
  reconcilingSince: Date | null;
  hasEvidence: boolean;
  now: Date;
}

/**
 * Pure classification of a single candidate row (DLV-03). Every branch below
 * corresponds to a row in ARCHITECTURE.md ##9's per-transition writer
 * matrix. `hold` is the structural default, deliberately last: every
 * status/evidence/age combination not explicitly matched above it --
 * `dispatching` younger than the stale threshold, `reconciling` still
 * inside its resolution window, `unknown` with no evidence at any age,
 * `unknown` past the re-scan horizon even with evidence, and every terminal
 * status (`sent`/`failed`/`excluded`) -- holds.
 */
export function classifyReconcilableSend(input: ReconcileInput): ReconcileVerdict {
  const { status, queuedAt, reconcilingSince, hasEvidence, now } = input;

  if (status === "dispatching" && now.getTime() - queuedAt.getTime() > STALE_DISPATCHING_AGE_MS) {
    return { kind: "sweep_to_reconciling" };
  }

  if (status === "reconciling" && hasEvidence) {
    // Evidence resolves a reconciling row to sent regardless of age -- even
    // one that has already exceeded RECONCILE_RESOLUTION_WINDOW_MS. Age only
    // matters for the NO-evidence case below.
    return { kind: "resolve_sent" };
  }

  if (status === "reconciling" && !hasEvidence) {
    // A null reconcilingSince falls back to queuedAt for the age
    // computation rather than holding forever -- a row that somehow reached
    // `reconciling` without ever having reconcilingSince set (should not
    // happen given recordSendResult's COALESCE-guarded write, but this pure
    // function must not trust that invariant blindly) still ages out of
    // ambiguity eventually.
    const since = reconcilingSince ?? queuedAt;
    if (now.getTime() - since.getTime() > RECONCILE_RESOLUTION_WINDOW_MS) {
      return { kind: "resolve_unknown" };
    }
  }

  if (
    status === "unknown" &&
    hasEvidence &&
    now.getTime() - queuedAt.getTime() <= RECONCILE_RESCAN_HORIZON_MS
  ) {
    return { kind: "resolve_sent" };
  }

  // Structural default (mirrors transport-classify.ts's fail-closed-last
  // shape) -- this line must stay structurally last. See the function's own
  // doc comment above for the full enumeration of what falls through here.
  return { kind: "hold" };
}
