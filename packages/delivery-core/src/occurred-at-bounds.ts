/**
 * Pure `occurred_at` bounding classifier (CMP-05, D-15, Pitfall 14 first
 * half, plan 13-04).
 *
 * `send_events.occurred_at` is provider-supplied and today does double duty:
 * it routes the monthly partition (`send-events.ts`) and forms part of the
 * dedup key (`ON CONFLICT (workspace_id, sg_event_id, occurred_at)`). Before
 * this module existed, the only check on it was that `new Date(ms)` would
 * not throw. This module bounds it to a business-meaningful window BEFORE
 * either use, so a manipulated or clock-skewed value cannot place a row far
 * outside the current-month partition window or sidestep dedup by varying
 * only the timestamp.
 *
 * Like `event-normalize.ts`: no database, no network, no ambient clock --
 * `now` is taken as an argument rather than read internally, so the
 * function stays deterministic and unit-testable, and the same redelivered
 * event always classifies identically.
 */

/** ECMAScript's maximum time value in milliseconds -- `new Date(ms)` never throws within this bound. */
const MAX_DATE_TIME_VALUE_MS = 8.64e15;

/**
 * `OCCURRED_AT_MAX_PAST_DAYS = 7` -- strictly covers SendGrid's ~24h webhook
 * retry window plus its ~72h deferral cycle with roughly a 2x margin,
 * matching the margin discipline used for `FLOW_RUN_ADVANCE_RETENTION` and
 * the reconciler's own horizons in Phase 12. Anything older than this either
 * predates every recovery mechanism the platform has, or is a manipulated
 * value -- either way it must not choose a partition.
 */
export const OCCURRED_AT_MAX_PAST_DAYS = 7;

/**
 * `OCCURRED_AT_MAX_FUTURE_SKEW_MINUTES = 5` -- a provider or platform clock
 * can legitimately disagree by minutes, never by hours. This is
 * STRUCTURALLY DIFFERENT from `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` (the
 * Phase 10 signed-header timestamp tolerance, `webhooks.routes.ts`): that
 * value bounds the SIGNED HEADER timestamp used for replay-window
 * verification of the whole HTTP request, while this one bounds each
 * event's OWN `timestamp` field inside the batch body (RESEARCH.md
 * Pitfall 6). Two different values for two different trust questions.
 */
export const OCCURRED_AT_MAX_FUTURE_SKEW_MINUTES = 5;

/**
 * Discriminated union over `kind`:
 * - `accepted` -- within the window; `occurredAt` is an ISO-8601 `Z` string.
 * - `rejected` -- a well-formed timestamp the platform refuses to trust
 *   (out of the past/future window). `candidate` carries the original,
 *   un-coerced value verbatim for forensics.
 * - `unusable` -- structurally not a timestamp at all (missing, non-finite,
 *   or outside the ECMAScript Date-representable range). `candidate` carries
 *   the original, un-coerced value verbatim for forensics.
 *
 * `unusable` is kept separate from `rejected` as two distinct verdict kinds
 * so the quarantine reason string tells an operator which of the two
 * happened -- but BOTH are quarantined when the event carries a usable
 * `sg_event_id` (decided in this plan, see 13-04-PLAN.md's
 * `flagged_assumptions`/`review_incorporation` sections): the verdict kind
 * selects the reason string an operator reads, not whether a row is
 * written. A structurally broken timestamp (a string, a null, an absurd
 * number) is exactly as much evidence of a provider or integration problem
 * as one that is three weeks old.
 */
export type OccurredAtVerdict =
  | { kind: "accepted"; occurredAt: string }
  | { kind: "rejected"; reason: "too_old" | "too_far_future"; candidate: unknown }
  | { kind: "unusable"; reason: "missing" | "non_finite" | "out_of_date_range"; candidate: unknown };

/**
 * Classifies a raw SendGrid webhook event's `timestamp` field (Unix
 * seconds, `unknown` at the call site since it comes straight off a
 * `JSON.parse`d payload) against `now`.
 *
 * Preserves the pre-existing `MAX_DATE_TIME_VALUE_MS` guard as the
 * `out_of_date_range` branch, so an absurd numeric value still cannot make
 * `new Date(...)` throw and abort a batch (the prior `isUsableTimestamp`
 * check this replaces, `apps/worker/src/queues/webhook-events.worker.ts`).
 *
 * Does NOT add a wall-clock fallback for a missing timestamp: WR-01
 * established that a substituted `now` differs on every redelivery and
 * therefore defeats dedup -- a missing/unusable timestamp is classified as
 * such, never silently replaced.
 */
export function classifyOccurredAt(timestamp: unknown, now: Date): OccurredAtVerdict {
  if (timestamp === undefined || timestamp === null) {
    return { kind: "unusable", reason: "missing", candidate: timestamp };
  }
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    return { kind: "unusable", reason: "non_finite", candidate: timestamp };
  }

  const candidateMs = timestamp * 1000;
  if (Math.abs(candidateMs) > MAX_DATE_TIME_VALUE_MS) {
    return { kind: "unusable", reason: "out_of_date_range", candidate: timestamp };
  }

  const nowMs = now.getTime();
  const pastBoundMs = nowMs - OCCURRED_AT_MAX_PAST_DAYS * 24 * 60 * 60 * 1000;
  const futureBoundMs = nowMs + OCCURRED_AT_MAX_FUTURE_SKEW_MINUTES * 60 * 1000;

  if (candidateMs < pastBoundMs) {
    return { kind: "rejected", reason: "too_old", candidate: timestamp };
  }
  if (candidateMs > futureBoundMs) {
    return { kind: "rejected", reason: "too_far_future", candidate: timestamp };
  }

  return { kind: "accepted", occurredAt: new Date(candidateMs).toISOString() };
}
