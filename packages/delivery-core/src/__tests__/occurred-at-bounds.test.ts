import { describe, expect, it } from "vitest";
import {
  classifyOccurredAt,
  OCCURRED_AT_MAX_PAST_DAYS,
  OCCURRED_AT_MAX_FUTURE_SKEW_MINUTES,
} from "../occurred-at-bounds.js";

/**
 * Phase 13 (CMP-05, D-15, plan 13-04): pure boundary tests for
 * `classifyOccurredAt`, using a fixed injected `now` so no test depends on
 * the wall clock. Every case in 13-04-PLAN.md's `<behavior>` list is covered
 * here.
 */
describe("classifyOccurredAt (CMP-05, D-15)", () => {
  const NOW = new Date("2026-08-11T12:00:00.000Z");
  const HOUR_MS = 60 * 60 * 1000;
  const DAY_MS = 24 * HOUR_MS;
  const MINUTE_MS = 60 * 1000;

  function secondsAgo(ms: number): number {
    return (NOW.getTime() - ms) / 1000;
  }

  function secondsAhead(ms: number): number {
    return (NOW.getTime() + ms) / 1000;
  }

  it("exports the versioned window constants", () => {
    expect(OCCURRED_AT_MAX_PAST_DAYS).toBe(7);
    expect(OCCURRED_AT_MAX_FUTURE_SKEW_MINUTES).toBe(5);
  });

  it("accepts a timestamp 1 hour before now, returning an ISO-8601 Z string", () => {
    const verdict = classifyOccurredAt(secondsAgo(HOUR_MS), NOW);
    expect(verdict.kind).toBe("accepted");
    if (verdict.kind === "accepted") {
      expect(verdict.occurredAt).toBe(new Date(NOW.getTime() - HOUR_MS).toISOString());
      expect(verdict.occurredAt.endsWith("Z")).toBe(true);
    }
  });

  it("accepts a timestamp 6 days before now", () => {
    const verdict = classifyOccurredAt(secondsAgo(6 * DAY_MS), NOW);
    expect(verdict.kind).toBe("accepted");
  });

  it("rejects a timestamp 8 days before now with reason too_old", () => {
    const candidate = secondsAgo(8 * DAY_MS);
    const verdict = classifyOccurredAt(candidate, NOW);
    expect(verdict.kind).toBe("rejected");
    if (verdict.kind === "rejected") {
      expect(verdict.reason).toBe("too_old");
      expect(verdict.candidate).toBe(candidate);
    }
  });

  it("accepts a timestamp 1 minute after now (clock-skew tolerance)", () => {
    const verdict = classifyOccurredAt(secondsAhead(MINUTE_MS), NOW);
    expect(verdict.kind).toBe("accepted");
  });

  it("rejects a timestamp 1 hour after now with reason too_far_future", () => {
    const candidate = secondsAhead(HOUR_MS);
    const verdict = classifyOccurredAt(candidate, NOW);
    expect(verdict.kind).toBe("rejected");
    if (verdict.kind === "rejected") {
      expect(verdict.reason).toBe("too_far_future");
      expect(verdict.candidate).toBe(candidate);
    }
  });

  it("returns unusable with reason non_finite and the original candidate for a non-numeric string", () => {
    const verdict = classifyOccurredAt("not-a-timestamp", NOW);
    expect(verdict.kind).toBe("unusable");
    if (verdict.kind === "unusable") {
      expect(verdict.reason).toBe("non_finite");
      expect(verdict.candidate).toBe("not-a-timestamp");
    }
  });

  it("returns unusable with reason missing for null/undefined", () => {
    const verdictNull = classifyOccurredAt(null, NOW);
    expect(verdictNull.kind).toBe("unusable");
    if (verdictNull.kind === "unusable") expect(verdictNull.reason).toBe("missing");

    const verdictUndefined = classifyOccurredAt(undefined, NOW);
    expect(verdictUndefined.kind).toBe("unusable");
    if (verdictUndefined.kind === "unusable") expect(verdictUndefined.reason).toBe("missing");
  });

  it("returns unusable with reason non_finite for NaN and Infinity", () => {
    const verdictNaN = classifyOccurredAt(Number.NaN, NOW);
    expect(verdictNaN.kind).toBe("unusable");
    if (verdictNaN.kind === "unusable") expect(verdictNaN.reason).toBe("non_finite");

    const verdictInfinity = classifyOccurredAt(Number.POSITIVE_INFINITY, NOW);
    expect(verdictInfinity.kind).toBe("unusable");
    if (verdictInfinity.kind === "unusable") expect(verdictInfinity.reason).toBe("non_finite");
  });

  it("returns unusable with reason out_of_date_range for an absurd numeric value that would make new Date(...) throw", () => {
    const candidate = 1e20;
    const verdict = classifyOccurredAt(candidate, NOW);
    expect(verdict.kind).toBe("unusable");
    if (verdict.kind === "unusable") {
      expect(verdict.reason).toBe("out_of_date_range");
      expect(verdict.candidate).toBe(candidate);
    }
  });

  it("is deterministic: identical (timestamp, now) pairs produce deeply equal verdicts", () => {
    const candidate = secondsAgo(HOUR_MS);
    const first = classifyOccurredAt(candidate, NOW);
    const second = classifyOccurredAt(candidate, NOW);
    expect(first).toEqual(second);

    const rejectedCandidate = secondsAgo(8 * DAY_MS);
    expect(classifyOccurredAt(rejectedCandidate, NOW)).toEqual(classifyOccurredAt(rejectedCandidate, NOW));
  });
});
