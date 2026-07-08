import type { NormalizedEventType } from "./event-normalize.js";

/**
 * Pure suppression decision table (SUBS-02, D-10/D-11/D-12).
 *
 * Source: `dropped`-reason exact strings confirmed via official SendGrid
 * docs. This module is PURE -- it imports no db/pg/tenant-context module and
 * performs no DB write or side effect; it is a pure function mapping event
 * type + reason to a status outcome. The 05-03 worker is the sole place that
 * turns this outcome into a `contacts.subscription_status` write +
 * `workspace_suppressions` insert (D-13).
 */
export type SuppressionOutcome = { status: "suppressed" | "unsubscribed"; reason: string } | null;

/**
 * D-10 platform constant: N consecutive soft bounces/blocks before a
 * contact is suppressed (successful delivery resets the streak). Not
 * user-configurable in v1 -- lives here so the 05-03 worker's streak logic
 * and this module share one source of truth for the threshold value.
 */
export const SOFT_BOUNCE_SUPPRESS_THRESHOLD = 3;

/**
 * D-12: `dropped`-reason -> suppression outcome. Address-validity reasons
 * (bounced/spam-reporting/invalid) suppress; `Unsubscribed Address`
 * unsubscribes; technical/policy reasons (e.g. "Invalid SMTPAPI header",
 * "Spam Content", "Recipient List over Package Quota") are intentionally
 * absent from this map -- they map to `null` (no status change) via the
 * `resolveSuppression` lookup fallback below.
 */
export const ADDRESS_DROP_REASONS: Record<string, SuppressionOutcome> = {
  "Bounced Address": { status: "suppressed", reason: "dropped_bounced_address" },
  "Spam Reporting Address": { status: "suppressed", reason: "dropped_spam_reporting_address" },
  "Invalid Address": { status: "suppressed", reason: "dropped_invalid_address" },
  "Unsubscribed Address": { status: "unsubscribed", reason: "dropped_unsubscribed_address" },
};

/**
 * Resolves a normalized event type (+ optional reason, relevant only for
 * `dropped`) to a subscription-status outcome, or `null` when no status
 * change should occur. `bounce_soft` always returns `null` here -- the N=3
 * consecutive-streak escalation (D-10) is stateful and lives in the 05-03
 * worker, not in this pure lookup.
 */
export function resolveSuppression(eventType: NormalizedEventType, reason: string | null): SuppressionOutcome {
  switch (eventType) {
    case "bounce_hard":
      return { status: "suppressed", reason: "hard_bounce" };
    case "spam_report":
      return { status: "suppressed", reason: "spam_report" };
    case "unsubscribe":
    case "group_unsubscribe":
      return { status: "unsubscribed", reason: "unsubscribe" };
    case "dropped":
      return reason ? (ADDRESS_DROP_REASONS[reason] ?? null) : null;
    case "bounce_soft":
      return null; // handled separately -- 05-03's soft-bounce streak logic
    default:
      return null;
  }
}
