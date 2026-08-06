// GSD 08-14: type declarations for scripts/coverage-gate.mjs.
// See scripts/lint-migrations.d.mts for why these exist.

export interface CoverageSummaryLike {
  total?: { lines?: { covered?: number; total?: number } };
}

export interface CoverageBaselineLike {
  lines?: number;
}

export interface CoverageGateResult {
  pass: boolean;
  /** The unrounded covered/total fraction. */
  actual: number;
  threshold: number;
  covered: number;
  total: number;
  /** Present only when the report could not be evaluated, e.g. an empty denominator. */
  reason?: string;
}

export function checkCoverageGate(
  summary: CoverageSummaryLike,
  baseline: CoverageBaselineLike,
): CoverageGateResult;
