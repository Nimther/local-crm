// GSD 08-03 (QG-02) lint fixture — a DELIBERATE violation, not real source.
//
// Proves the gate rejects a single violation of an enabled type-aware rule.
// Ignored by the tree-wide `eslint .` run so it cannot permanently block
// `npm run lint`; the fail-first assertions target it with --no-ignore.

async function persist(): Promise<void> {
  await Promise.resolve();
}

export function scheduleWithoutAwaiting(): void {
  // @typescript-eslint/no-floating-promises — no await, no void, no .catch
  persist();
}
