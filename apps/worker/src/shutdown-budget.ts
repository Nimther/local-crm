import { SENDGRID_TIMEOUT_MS } from "@mega-crm/delivery-core";
import { CLAIM_TX_MARGIN_MS, RECORD_TX_MARGIN_MS } from "@mega-crm/queue-core";

/**
 * Phase 12 (WRK-07, RESEARCH.md Pitfall 5): the container's SIGTERM->SIGKILL
 * grace period must exceed the worst-case in-flight send dispatch, or a
 * routine deploy becomes exactly the ambiguous-outcome scenario Phase 11's
 * `reconciling` state and reconciler exist to resolve -- a job legitimately
 * mid-dispatch when SIGKILL lands is killed before it can write a terminal
 * result, and the reconciler then has to spend its resolution window
 * cleaning up a send that a correctly-sized grace period would have let
 * finish cleanly.
 *
 * Docker's unconfigured default SIGTERM->SIGKILL grace period is 10 seconds
 * -- already less than `SENDGRID_TIMEOUT_MS` alone (20s), before either
 * transaction margin is added. This module derives the actual worst case
 * from the SAME constants the send-timing invariant test
 * (`send-timing-invariant.test.ts`) checks against, so a future change to
 * any of those three inputs changes this budget automatically instead of
 * silently disagreeing with a hand-typed number here.
 */

/**
 * Explicit safety margin ABOVE the raw worst-case in-flight duration
 * (`SENDGRID_TIMEOUT_MS + CLAIM_TX_MARGIN_MS + RECORD_TX_MARGIN_MS`, ~30s).
 * Covers a slow terminal write under load plus ordinary process/container
 * scheduling jitter -- the raw floor already exceeds the common container
 * runtime's unconfigured default several times over, so this margin is
 * headroom, not the primary fix.
 */
export const WORKER_DRAIN_SAFETY_MARGIN_MS = 30_000;

/**
 * The full drain budget: the provider timeout plus both transaction margins
 * (claim, before the SendGrid call; record, after it) plus the explicit
 * safety margin above. Computed from the imported constants, never
 * hand-typed, so a change to `SENDGRID_TIMEOUT_MS`, `CLAIM_TX_MARGIN_MS` or
 * `RECORD_TX_MARGIN_MS` propagates here without a second edit.
 */
export const WORKER_DRAIN_BUDGET_MS =
  SENDGRID_TIMEOUT_MS + CLAIM_TX_MARGIN_MS + RECORD_TX_MARGIN_MS + WORKER_DRAIN_SAFETY_MARGIN_MS;

/**
 * `WORKER_DRAIN_BUDGET_MS` expressed in whole seconds, rounded UP -- the
 * unit a container runtime's stop-grace-period/termination-grace-period
 * setting is configured in (`docker run --stop-timeout`,
 * `stop_grace_period` in Compose, `terminationGracePeriodSeconds` in
 * Kubernetes). Rounding up (never down) guarantees the configured grace
 * period is never shorter than the millisecond budget it is derived from.
 *
 * Phase 14 (deployment) MUST set the worker container's stop-grace-period
 * from this value -- never leave it at a runtime default. This module does
 * not configure any container itself; it only publishes the number Phase 14
 * is required to consume.
 */
export const WORKER_STOP_GRACE_PERIOD_SECONDS = Math.ceil(WORKER_DRAIN_BUDGET_MS / 1000);
