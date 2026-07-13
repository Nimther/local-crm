import { describe, expect, it } from "vitest";

import { computeRate } from "../rates";

/**
 * 07-03/D-01: computeRate is the single shared source for every percentage
 * across campaign summary, campaign list (and, later, flow analytics +
 * dashboard KPIs). Rounds to the nearest integer percent; returns null on a
 * zero denominator so callers render «—» instead of NaN%/Infinity%.
 */
describe("computeRate", () => {
  it("computes a whole-number percentage", () => {
    expect(computeRate(50, 100)).toBe(50);
  });

  it("rounds to the nearest integer", () => {
    expect(computeRate(1, 3)).toBe(33);
  });

  it("returns null when the denominator is zero and numerator is non-zero", () => {
    expect(computeRate(5, 0)).toBeNull();
  });

  it("returns null when both numerator and denominator are zero", () => {
    expect(computeRate(0, 0)).toBeNull();
  });

  it("returns 100 when numerator equals denominator", () => {
    expect(computeRate(10, 10)).toBe(100);
  });
});
