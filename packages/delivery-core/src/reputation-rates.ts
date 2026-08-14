/**
 * Pure reputation-rate tiering (CMP-09, D-09 through D-12).
 *
 * Computes a workspace's spam-complaint rate and hard-bounce rate over a
 * rolling window from delivery fact columns the platform already records
 * (`sends.delivered_at` / `spam_reported_at` / `bounced_at`), and tiers each
 * ratio against the Gmail/Yahoo bulk-sender lines. This module is PURE -- it
 * imports no db/pg/tenant-context module, takes only numbers in, and
 * performs no DB read, no DB write, and no side effect. The caller
 * (`apps/worker/src/queues/reputation-tick.worker.ts`) is the sole place
 * that runs the windowed count query and persists the result.
 *
 * Scope note: this module only measures and tiers. Nothing here pauses,
 * throttles, or blocks sending -- crossing a threshold only produces a
 * classification for the caller to record and, in plan 13-11, alert on.
 */

export type ReputationMetric = "complaint_rate" | "hard_bounce_rate";

export type ReputationTier = "none" | "warn" | "critical";

export type ReputationObservation = {
  metric: ReputationMetric;
  tier: ReputationTier;
  /** Null when the denominator is zero or below the volume floor -- an
   *  unjudgeable sample never gets a numeric rate, so a caller cannot
   *  mistake "not enough data" for a real (near-zero) measurement. */
  rate: number | null;
  numerator: number;
  denominator: number;
};

/**
 * D-09: long enough that a single bad send day does not dominate the ratio,
 * short enough that a tenant sees the consequence of a change within a
 * week. This is deliberately the same width as
 * `INGRESS_JOURNAL_RETENTION_DAYS` by coincidence of purpose, not by
 * dependency -- the two constants must remain free to diverge.
 */
export const REPUTATION_WINDOW_DAYS = 7;

/**
 * 13-RESEARCH.md Open Question 2 records that no in-repo or external
 * precedent exists for a minimum-sample-size gate, so this value is a
 * reasoned planning-time default rather than a measured one: below 500
 * delivered in the window, a single spam report is 0.2% and would read as
 * `warn` while carrying almost no signal. Expected to be tuned once real
 * tenant volume distributions are observable, which is why it is a
 * versioned constant rather than an inline literal.
 *
 * Comparison inclusivity: a denominator strictly below this floor is
 * unjudgeable and returns tier `none`; a denominator exactly at the floor
 * IS judged (500 delivered computes and tiers a rate, it does not return
 * `none`).
 */
export const REPUTATION_MIN_DELIVERED_FLOOR = 500;

/**
 * The 0.1% line Gmail and Yahoo publish for bulk-sender spam-complaint
 * rates, per D-10. A rate at or above this value is `warn`.
 */
export const COMPLAINT_RATE_WARN = 0.001;

/**
 * The 0.3% line at which providers begin filtering, per D-10. The warn
 * tier exists to give a tenant room to react before crossing this line. A
 * rate at or above this value is `critical`.
 */
export const COMPLAINT_RATE_CRITICAL = 0.003;

/**
 * The ~2% line providers penalize for hard-bounce rate, per D-12. A rate at
 * or above this value is `warn`.
 */
export const HARD_BOUNCE_RATE_WARN = 0.02;

/**
 * Set well above the ~2% warn line because a bounce rate is noisier than a
 * complaint rate at small volumes, and a 2% reading on a young list is
 * common enough that treating it as critical would train operators to
 * ignore the alert. This is a planner choice, not a published provider
 * line -- only the ~2% warn line is sourced. A rate at or above this value
 * is `critical`.
 */
export const HARD_BOUNCE_RATE_CRITICAL = 0.05;

/**
 * Classifies one ratio (numerator/denominator) for the given metric against
 * its versioned thresholds. Never throws and never divides by zero: a zero
 * or below-floor denominator returns tier `none` with a null rate, which is
 * distinguishable from both "healthy" (`none` with a real low rate is not
 * possible below the floor -- `none` below the floor always carries a null
 * rate) and from a genuinely unmeasured workspace at the caller level.
 *
 * Pure -- same inputs, same output, no clock and no database.
 */
export function classifyReputationRate(
  metric: ReputationMetric,
  numerator: number,
  denominator: number,
): ReputationObservation {
  if (denominator < REPUTATION_MIN_DELIVERED_FLOOR) {
    return { metric, tier: "none", rate: null, numerator, denominator };
  }

  const rate = numerator / denominator;
  const [warnThreshold, criticalThreshold] =
    metric === "complaint_rate"
      ? [COMPLAINT_RATE_WARN, COMPLAINT_RATE_CRITICAL]
      : [HARD_BOUNCE_RATE_WARN, HARD_BOUNCE_RATE_CRITICAL];

  const tier: ReputationTier =
    rate >= criticalThreshold ? "critical" : rate >= warnThreshold ? "warn" : "none";

  return { metric, tier, rate, numerator, denominator };
}
