// GSD 08-14: type declarations for scripts/coverage-ratchet.mjs.
// See scripts/lint-migrations.d.mts for why these exist.

export interface CoverageBaselineLike {
  // `unknown`, not `number`: this is deserialized from JSON on disk (or from
  // `git show <ref>:coverage-baseline.json`), so it carries no runtime
  // guarantee of being a number -- a typo'd or renamed key is exactly the
  // malformed-input case 08-REVIEW WR-04 validates against.
  lines?: unknown;
}

export interface RatchetResult {
  pass: boolean;
  current: number;
  /** null when the base ref carries no baseline file yet. */
  base: number | null;
  /** null in the same case — there is nothing to subtract from. */
  delta: number | null;
  /** set only on a `pass: false` result caused by a malformed `current`. */
  reason?: string;
}

export function checkRatchet(
  current: CoverageBaselineLike,
  base: CoverageBaselineLike | null,
): RatchetResult;
