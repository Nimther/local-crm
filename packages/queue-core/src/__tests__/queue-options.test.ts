import { describe, expect, it } from "vitest";
import { SENDGRID_TIMEOUT_MS } from "@mega-crm/delivery-core";
import { buildRedisConnectionOptions } from "../connection.js";
import {
  buildJobOptions,
  CLAIM_TX_MARGIN_MS,
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
});

describe("buildJobOptions", () => {
  it("buildJobOptions(STANDARD_JOB_RETENTION) returns the send-lane attempts and exponential-backoff delay together with the standard retention fields", () => {
    const opts = buildJobOptions(STANDARD_JOB_RETENTION);

    expect(opts.attempts).toBe(SEND_JOB_MAX_ATTEMPTS);
    expect(opts.backoff).toEqual({ type: "exponential", delay: SEND_JOB_BACKOFF_DELAY_MS });
    expect(opts.removeOnComplete).toEqual({ age: 86_400 });
    expect(opts.removeOnFail).toBe(false);
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
