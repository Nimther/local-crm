import { describe, expect, it } from "vitest";
import {
  classifyReputationRate,
  COMPLAINT_RATE_CRITICAL,
  COMPLAINT_RATE_WARN,
  HARD_BOUNCE_RATE_CRITICAL,
  HARD_BOUNCE_RATE_WARN,
  REPUTATION_MIN_DELIVERED_FLOOR,
} from "../reputation-rates.js";

describe("classifyReputationRate (CMP-09, D-09 through D-12)", () => {
  it("0 delivered returns tier none and a null rate, never a division by zero", () => {
    const result = classifyReputationRate("complaint_rate", 0, 0);
    expect(result).toEqual({
      metric: "complaint_rate",
      tier: "none",
      rate: null,
      numerator: 0,
      denominator: 0,
    });
  });

  it("a delivered count strictly below the volume floor returns tier none regardless of complaint count", () => {
    const result = classifyReputationRate("complaint_rate", 5, 100);
    expect(result.tier).toBe("none");
    expect(result.rate).toBeNull();
  });

  it("a delivered count exactly at the floor computes and tiers the rate rather than returning none", () => {
    const result = classifyReputationRate("complaint_rate", 1, REPUTATION_MIN_DELIVERED_FLOOR);
    expect(result.tier).not.toBe("none");
    expect(result.rate).not.toBeNull();
    expect(result.rate).toBeCloseTo(1 / 500);
  });

  it("complaint_rate: 1 in 1000 (0.1%, exactly on the warn line) returns tier warn -- >= comparison", () => {
    const result = classifyReputationRate("complaint_rate", 1, 1000);
    expect(result.tier).toBe("warn");
    expect(result.rate).toBeCloseTo(COMPLAINT_RATE_WARN);
  });

  it("complaint_rate: 3 in 1000 (0.3%, exactly on the critical line) returns tier critical -- >= comparison", () => {
    const result = classifyReputationRate("complaint_rate", 3, 1000);
    expect(result.tier).toBe("critical");
    expect(result.rate).toBeCloseTo(COMPLAINT_RATE_CRITICAL);
  });

  it("complaint_rate: 0 in 1000 returns tier none", () => {
    const result = classifyReputationRate("complaint_rate", 0, 1000);
    expect(result.tier).toBe("none");
    expect(result.rate).toBe(0);
  });

  it("hard_bounce_rate: 20 in 1000 (2%, exactly on the warn line) returns tier warn", () => {
    const result = classifyReputationRate("hard_bounce_rate", 20, 1000);
    expect(result.tier).toBe("warn");
    expect(result.rate).toBeCloseTo(HARD_BOUNCE_RATE_WARN);
  });

  it("hard_bounce_rate: a materially higher ratio returns tier critical", () => {
    const result = classifyReputationRate("hard_bounce_rate", 60, 1000);
    expect(result.tier).toBe("critical");
    expect(result.rate).toBeGreaterThanOrEqual(HARD_BOUNCE_RATE_CRITICAL);
  });

  it("hard_bounce_rate: exactly on the critical line (5%) returns tier critical -- >= comparison", () => {
    const result = classifyReputationRate("hard_bounce_rate", 50, 1000);
    expect(result.tier).toBe("critical");
  });

  it("the observation always carries numerator, denominator, and rate for a judgeable sample", () => {
    const result = classifyReputationRate("complaint_rate", 3, 1000);
    expect(result.numerator).toBe(3);
    expect(result.denominator).toBe(1000);
    expect(result.rate).toBeCloseTo(0.003);
  });

  it("the observation carries numerator and denominator even below the volume floor", () => {
    const result = classifyReputationRate("hard_bounce_rate", 5, 100);
    expect(result.numerator).toBe(5);
    expect(result.denominator).toBe(100);
  });

  it("is pure -- repeated calls with the same inputs return equal outputs", () => {
    const a = classifyReputationRate("complaint_rate", 2, 2000);
    const b = classifyReputationRate("complaint_rate", 2, 2000);
    expect(a).toEqual(b);
  });
});
