// GSD 08-03 (QG-02) lint fixture — a DELIBERATE violation, not a real test.
//
// A forgotten .only silently reduces a suite to one test while CI stays green.
// vitest/no-focused-tests is configured non-fixable so `eslint --fix` cannot
// erase this marker (D-07); that property is asserted in lint-gate.test.ts.

import { describe, expect, it } from "vitest";

describe("focused fixture", () => {
  it.only("is focused on purpose", () => {
    expect(true).toBe(true);
  });
});
