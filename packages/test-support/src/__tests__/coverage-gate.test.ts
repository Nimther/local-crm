import { describe, expect, it } from "vitest";

import { checkCoverageGate } from "../../../../scripts/coverage-gate.mjs";

/**
 * 08-14 (QG-03) — the coverage threshold comparison.
 *
 * Two SPEC R3 edges decide whether this is a gate or a decoration:
 *
 *   boundary  — a run exactly AT the threshold passes. A gate that failed on
 *               equality would make the recorded number unreachable by
 *               construction.
 *   precision — the comparison is the unrounded `covered / total` fraction.
 *               84.996% must fail an 85% threshold rather than round up into a
 *               pass, because rounding is how a real regression gets presented
 *               as "equal to the threshold".
 *
 * Fixtures mirror the real `coverage/coverage-summary.json` shape, and every
 * pair is chosen so its case is exact rather than approximate — approximate
 * numbers would turn these into floating-point trivia instead of contract tests.
 */

/** The slice of coverage-summary.json the gate reads. */
function summary(covered: number, total: number): { total: { lines: { covered: number; total: number } } } {
  return { total: { lines: { covered, total } } };
}

describe("checkCoverageGate — the boundary", () => {
  it("passes when the fraction is exactly the threshold", () => {
    const result = checkCoverageGate(summary(800, 1000), { lines: 0.8 });
    expect(result.pass, "equality must pass, or the recorded number is unreachable").toBe(true);
    expect(result.actual).toBe(0.8);
    expect(result.threshold).toBe(0.8);
  });

  it("fails one uncovered line below the threshold", () => {
    const result = checkCoverageGate(summary(799, 1000), { lines: 0.8 });
    expect(result.pass).toBe(false);
    expect(result.actual).toBe(0.799);
  });

  it("passes one covered line above the threshold", () => {
    const result = checkCoverageGate(summary(801, 1000), { lines: 0.8 });
    expect(result.pass).toBe(true);
  });
});

describe("checkCoverageGate — the precision edge", () => {
  it("fails a fraction that only reaches the threshold once rounded", () => {
    // 84996/100000 = 0.84996 — displays as "85.00%" at two decimals, and is
    // strictly below 0.85. This is the case SPEC R3 names.
    const result = checkCoverageGate(summary(84_996, 100_000), { lines: 0.85 });
    expect(result.pass, "0.84996 must not round up into a pass against 0.85").toBe(false);
    expect(result.actual).toBe(0.84996);
    expect(
      Number((result.actual * 100).toFixed(2)),
      "the fixture is only meaningful if it DOES round to the threshold",
    ).toBe(85);
  });
});

describe("checkCoverageGate — an empty denominator is not a pass", () => {
  it("fails when total is 0 rather than producing NaN", () => {
    const result = checkCoverageGate(summary(0, 0), { lines: 0.8 });
    expect(result.pass, "a report that measured nothing must not satisfy the gate").toBe(false);
    expect(Number.isNaN(result.actual)).toBe(false);
  });
});

describe("checkCoverageGate — the returned shape", () => {
  it("carries the raw integers and both fractions at full precision", () => {
    const result = checkCoverageGate(summary(3366, 4194), { lines: 0.8125751072961374 });
    expect(result).toMatchObject({
      covered: 3366,
      total: 4194,
      threshold: 0.8125751072961374,
    });
    // Unrounded: the CLI prints this, and a developer looking at a red gate
    // needs to see how far below they landed.
    expect(result.actual).toBe(3366 / 4194);
    expect(result.pass).toBe(false);
  });
});
