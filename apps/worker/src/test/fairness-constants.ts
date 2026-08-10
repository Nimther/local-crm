/**
 * Phase 12 (WRK-03/WRK-04, plan 12-05): versioned constants for the
 * tenant-fairness proof (`tenant-fairness.test.ts`) and the
 * `DEFAULT_TENANT_RPS` sustained-throughput validation
 * (`tenant-rps-sustained.test.ts`). Phase 9 D-12 convention: every constant
 * below carries its OWN rationale in its own comment, not just at the top
 * of the file, because a future change to any one of them needs its own
 * justification re-derived, not the file's.
 */

/**
 * D-05: the fairness assertion is RELATIVE to tenant B's own solo baseline
 * measured in the SAME run, never an absolute throughput floor -- an
 * absolute number is machine-dependent (CI runner CPU/IO varies run to run)
 * and would rot into a flaky threshold within weeks of being pinned. 0.9 (a
 * 10% allowance) covers ordinary scheduler jitter plus the extra Redis round
 * trips both tenants' `consumeTenantToken`/`acquireTenantLaneSlot` calls make
 * against the SAME Redis instance during the contended phase -- the
 * threshold is deliberately not 1.0, because the two tenants genuinely do
 * share one Redis instance and one BullMQ worker process; it bounds that
 * contention rather than pretending it away.
 */
export const TENANT_FAIRNESS_MIN_BASELINE_RATIO = 0.9;

/**
 * Scaled-down job counts and RPS ceilings for the CI-resident scenarios in
 * `tenant-fairness.test.ts` -- sized so the whole file (two-tenant fairness
 * plus the within-tenant lane-isolation case, each running a solo baseline
 * AND a contended phase against real Postgres/Redis) finishes in low
 * single-digit seconds, well inside the failure-injection job's existing
 * runtime budget. The FULL-scale sustained-throughput proof against the real
 * `DEFAULT_TENANT_RPS` ceiling lives in the separate on-demand
 * `loadtest:tenant-rps` variant (`LOADTEST_TENANT_RPS_DURATION_MS` below) --
 * these job counts are deliberately NOT scaled to `DEFAULT_TENANT_RPS`
 * itself, only to each other.
 */
export const FAIRNESS_SCENARIO_VOLUMES = {
  /**
   * Tenant B's fixed job count for the two-tenant scenario -- IDENTICAL
   * between the solo-baseline phase and the contended phase so the two
   * measured throughput figures are directly comparable (D-05). Large
   * enough that per-job scheduling jitter cannot swing the ratio past the
   * 10% allowance above; small enough to keep the whole scenario fast.
   */
  tenantBJobCount: 12,
  /**
   * Tenant B's own RPS ceiling override for the two-tenant scenario --
   * deliberately far below `DEFAULT_TENANT_RPS` so `tenantBJobCount` above
   * spans several of tenant B's own per-second windows worth measuring,
   * instead of finishing inside a single window where nothing about
   * SUSTAINED fairness would actually be exercised.
   */
  tenantBRpsLimit: 4,
  /**
   * Tenant A's oversaturation job count for the two-tenant scenario -- many
   * multiples of `tenantARpsLimit` below, so tenant A's own ceiling is
   * crossed almost immediately and keeps producing tenant-scoped deferrals
   * for the entire time tenant B's fixed workload is draining, rather than
   * running dry partway through the measurement window.
   */
  tenantAOversaturationJobCount: 60,
  /**
   * Tenant A's own RPS ceiling override for the two-tenant scenario -- set
   * low so `tenantAOversaturationJobCount` above saturates it almost
   * immediately, well before tenant B's own jobs finish draining.
   */
  tenantARpsLimit: 1,
  /**
   * The within-tenant lane-isolation case's fixed triggered-lane job count
   * (the assumption-delta invariant recorded in `12-01-PLAN.md`) -- same
   * sizing rationale as `tenantBJobCount` above, kept as its own constant
   * because the two cases are free to diverge later without one silently
   * changing the other's sample size.
   */
  laneIsolationJobCount: 12,
  /**
   * The within-tenant lane-isolation case's RPS ceiling override -- same
   * multi-window rationale as `tenantBRpsLimit` above.
   */
  laneIsolationRpsLimit: 6,
};

/**
 * The full-scale on-demand variant's sustained duration
 * (`loadtest:tenant-rps`, deliberately NOT wired into CI -- D-04). Long
 * enough that a queue backlog genuinely accumulating -- rather than being
 * absorbed by ordinary process-startup jitter -- would show up as a growing
 * waiting-depth sample between the start and the end of the window.
 */
export const LOADTEST_TENANT_RPS_DURATION_MS = 15_000;
