// TEMPORARY — 08-18 branch-protection demonstration. Deleted before the PR closes.

// BREAK 2 (type error): tsc must reject this, which is what `npm run build` gates on.
export const wrongType: number = "this is not a number";

// BREAK 3 (lint violation): an unused binding that is not underscore-prefixed,
// so `no-unused-vars` fires at --max-warnings=0.
export function unusedBinding(): void {
  const neverRead = 42;
}
