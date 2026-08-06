import { describe, expect, it } from "vitest";

import { checkRatchet } from "../../../../scripts/coverage-ratchet.mjs";

/**
 * 08-14 (QG-03) — the ratchet.
 *
 * The gate enforces the threshold; this stops the threshold from being quietly
 * reduced in the same commit that broke it. SPEC's negative criterion for R3 is
 * that CI fails when the recorded value decreased in the diff — with no
 * tolerance band, because a tolerance band is a smaller version of the same
 * loophole.
 *
 * The null-base case is not a special exemption: it is the state on the very
 * commit that introduces coverage-baseline.json, where the base branch
 * genuinely has no such file to compare against.
 */

describe("checkRatchet", () => {
  it("passes when the threshold was raised", () => {
    const result = checkRatchet({ lines: 0.8 }, { lines: 0.79 });
    expect(result.pass).toBe(true);
    expect(result.delta).toBeCloseTo(0.01, 12);
  });

  it("passes when the threshold is unchanged", () => {
    const result = checkRatchet({ lines: 0.8 }, { lines: 0.8 });
    expect(result.pass).toBe(true);
    expect(result.delta).toBe(0);
  });

  it("fails when the threshold was lowered", () => {
    const result = checkRatchet({ lines: 0.79 }, { lines: 0.8 });
    expect(result.pass).toBe(false);
    expect(result.delta).toBeLessThan(0);
    expect(result.current).toBe(0.79);
    expect(result.base).toBe(0.8);
  });

  it("passes when the base branch has no baseline yet", () => {
    // The introducing commit. Not an exemption — there is nothing to compare to.
    const result = checkRatchet({ lines: 0.8 }, null);
    expect(result.pass).toBe(true);
    expect(result.base).toBeNull();
  });

  it("fails on a decrease of any size — there is no tolerance band", () => {
    const base = 0.8125751072961374;
    const current = base - 1e-12;
    const result = checkRatchet({ lines: current }, { lines: base });
    expect(result.pass, "a tolerance band is a smaller version of the same loophole").toBe(false);
  });

  // 08-REVIEW WR-04: the null-base branch used to return `pass: true`
  // unconditionally, without checking whether `currentLines` was even a
  // valid number. That is a vacuous pass on the one commit where there is
  // nothing yet to compare against -- exactly the introducing-commit case
  // this branch exists to handle.
  it("fails when the base has no baseline yet AND the current baseline is malformed", () => {
    const result = checkRatchet({ lines: "not-a-number" }, null);
    expect(result.pass, "a malformed current baseline must not pass vacuously").toBe(false);
    expect(result.base).toBeNull();
    expect(result.reason).toMatch(/malformed/i);
  });

  it("fails when the base has no baseline yet AND `lines` is missing entirely", () => {
    const result = checkRatchet({}, null);
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/malformed/i);
  });
});
