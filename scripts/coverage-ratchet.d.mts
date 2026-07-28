// GSD 08-14: type declarations for scripts/coverage-ratchet.mjs.
// See scripts/lint-migrations.d.mts for why these exist.

export interface CoverageBaselineLike {
  lines?: number;
}

export interface RatchetResult {
  pass: boolean;
  current: number;
  /** null when the base ref carries no baseline file yet. */
  base: number | null;
  /** null in the same case — there is nothing to subtract from. */
  delta: number | null;
}

export function checkRatchet(
  current: CoverageBaselineLike,
  base: CoverageBaselineLike | null,
): RatchetResult;
