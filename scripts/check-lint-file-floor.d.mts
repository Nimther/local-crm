// GSD 08-06: type declarations for scripts/check-lint-file-floor.mjs.
// See scripts/lint-migrations.d.mts for why these exist.

export interface LintFileFloorResult {
  pass: boolean;
  checked: number;
  floor: number;
}

export function checkLintFileFloor(report: unknown, floor: number): LintFileFloorResult;
