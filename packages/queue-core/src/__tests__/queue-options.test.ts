import { describe, expect, it } from "vitest";
import { SENDGRID_TIMEOUT_MS } from "@mega-crm/delivery-core";
import { RECONCILE_RESCAN_HORIZON_MS } from "@mega-crm/delivery-core";
import { buildRedisConnectionOptions } from "../connection.js";
import {
  buildJobOptions,
  CLAIM_TX_MARGIN_MS,
  FAILED_JOB_RETENTION_SECONDS,
  FLOW_RUN_ADVANCE_RETENTION,
  RECORD_TX_MARGIN_MS,
  SEND_JOB_BACKOFF_DELAY_MS,
  SEND_JOB_MAX_ATTEMPTS,
  SEND_LOCK_DURATION_MS,
  SEND_MAX_JOB_LIFETIME_MS,
  STANDARD_JOB_RETENTION,
} from "../queue-options.js";

/**
 * Phase 12 (WRK-11, D-10): `packages/queue-core` is the single defining
 * module for the connection builder and the send-lane timing/retention
 * constants -- this suite covers every `<behavior>` item from 12-02-PLAN.md's
 * Task 1, asserted against the REAL exported values.
 */
describe("buildRedisConnectionOptions", () => {
  it("parses host, port and database index from a Redis URL and sets the BullMQ-required retry option", () => {
    const options = buildRedisConnectionOptions("redis://localhost:6379/3");

    expect(options.host).toBe("localhost");
    expect(options.port).toBe(6379);
    expect(options.db).toBe(3);
    expect(options.maxRetriesPerRequest).toBeNull();
  });

  it("parses username and password from a URL that carries them, and returns an undefined database index when the URL has no path", () => {
    const options = buildRedisConnectionOptions("redis://user:pass@example.com:6380");

    expect(options.username).toBe("user");
    expect(options.password).toBe("pass");
    expect(options.db).toBeUndefined();
  });

  it("WR-03: percent-decodes a password containing a reserved character, so ioredis's AUTH command receives the original secret rather than its URL-encoded form", () => {
    const options = buildRedisConnectionOptions("redis://user:p%40ss@host:6379/1");

    expect(options.password).toBe("p@ss");
  });
});

describe("buildJobOptions", () => {
  it("buildJobOptions(STANDARD_JOB_RETENTION) returns the send-lane attempts and exponential-backoff delay together with the standard retention fields", () => {
    const opts = buildJobOptions(STANDARD_JOB_RETENTION);

    expect(opts.attempts).toBe(SEND_JOB_MAX_ATTEMPTS);
    expect(opts.backoff).toEqual({ type: "exponential", delay: SEND_JOB_BACKOFF_DELAY_MS });
    expect(opts.removeOnComplete).toEqual({ age: 86_400 });
    expect(opts.removeOnFail).toEqual({ age: FAILED_JOB_RETENTION_SECONDS });
  });

  it("buildJobOptions(FLOW_RUN_ADVANCE_RETENTION) returns the same attempts and backoff with flow-run-advance's own retention fields", () => {
    const opts = buildJobOptions(FLOW_RUN_ADVANCE_RETENTION);

    expect(opts.attempts).toBe(SEND_JOB_MAX_ATTEMPTS);
    expect(opts.backoff).toEqual({ type: "exponential", delay: SEND_JOB_BACKOFF_DELAY_MS });
    expect(opts.removeOnComplete).toBe(true);
    expect(opts.removeOnFail).toEqual({ age: 86_400 });
  });

  it("calling buildJobOptions with no argument is a compile error", () => {
    // @ts-expect-error -- retention is a required parameter with no default; a missing argument must not typecheck.
    buildJobOptions();
    expect(true).toBe(true);
  });

  it("calling buildJobOptions with an ad-hoc third retention shape is a compile error", () => {
    // @ts-expect-error -- retention must be exactly STANDARD_JOB_RETENTION or FLOW_RUN_ADVANCE_RETENTION, not an arbitrary third shape.
    buildJobOptions({ removeOnComplete: true, removeOnFail: true });
    expect(true).toBe(true);
  });
});

describe("timing invariants (D-15/D-08)", () => {
  it("SEND_MAX_JOB_LIFETIME_MS is strictly greater than the attempt count multiplied by the lock duration", () => {
    expect(SEND_MAX_JOB_LIFETIME_MS).toBeGreaterThan(SEND_JOB_MAX_ATTEMPTS * SEND_LOCK_DURATION_MS);
  });

  it("the provider timeout plus both transaction margins is strictly less than the lock duration", () => {
    expect(SENDGRID_TIMEOUT_MS + CLAIM_TX_MARGIN_MS + RECORD_TX_MARGIN_MS).toBeLessThan(SEND_LOCK_DURATION_MS);
  });
});

/**
 * Phase 12 (WRK-09, D-10, Pitfall 6/7): the standard failed-job retention
 * bound and the differentiated flow-run-advance policy it must never erase.
 * See `packages/queue-core/src/queue-options.ts`'s own doc comment on
 * `FAILED_JOB_RETENTION_SECONDS` for the full ordering rationale (the bound
 * is only safe because 12-07/12-08 already wired the dead-letter writer and
 * the shared error listener onto every queue).
 */
describe("failed-job retention (WRK-09)", () => {
  it("the standard retention constant's failed-job retention is an age-bounded value, not an unbounded one", () => {
    expect(STANDARD_JOB_RETENTION.removeOnFail).not.toBe(false);
    expect(STANDARD_JOB_RETENTION.removeOnFail).toEqual({ age: FAILED_JOB_RETENTION_SECONDS });
  });

  it("FAILED_JOB_RETENTION_SECONDS is strictly greater than the delivery reconciliation window, with a documented margin", () => {
    const reconciliationWindowSeconds = RECONCILE_RESCAN_HORIZON_MS / 1000;

    expect(FAILED_JOB_RETENTION_SECONDS).toBeGreaterThan(reconciliationWindowSeconds);
  });

  it("the flow-run-advance retention constant is byte-for-byte unchanged by this plan", () => {
    expect(FLOW_RUN_ADVANCE_RETENTION).toEqual({
      removeOnComplete: true,
      removeOnFail: { age: 86_400 },
    });
  });

  it("the two retention constants' failed-job retention fields genuinely differ, so the per-queue parameterisation is observable", () => {
    expect(STANDARD_JOB_RETENTION.removeOnFail).not.toEqual(FLOW_RUN_ADVANCE_RETENTION.removeOnFail);
  });

  it("buildJobOptions still requires retention as a parameter and still rejects an ad-hoc shape", () => {
    // @ts-expect-error -- retention is a required parameter with no default; a missing argument must not typecheck.
    buildJobOptions();
    // @ts-expect-error -- retention must be exactly STANDARD_JOB_RETENTION or FLOW_RUN_ADVANCE_RETENTION, not an arbitrary third shape.
    buildJobOptions({ removeOnComplete: true, removeOnFail: true });
    expect(true).toBe(true);
  });
});
