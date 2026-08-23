# Deferred Items — Phase 22 (workspace-quiesce-physical-purge)

Out-of-scope discoveries logged during plan execution, per the executor's SCOPE BOUNDARY rule. Not fixed here.

## Plan 22-04

- **Pre-existing, out of scope**: `apps/worker/src/queues/__tests__/failure-injection/erasure-enqueue-crash.test.ts` -- "a crash strictly between deleteContact's commit and the enqueue call is recovered end to end by one reclaim tick" fails with `"No tenant context set for this request"` instead of the expected `/INJECTED FAILURE/` match. Reproduces in complete isolation (`vitest run erasure-enqueue-crash` alone), unrelated to scan policies, campaigns, flows, flow_runs or analytics-reconciliation -- none of which this test touches. Not fixed here per the deviation-rules scope boundary (only auto-fix issues directly caused by the current task's changes). Orchestrator note: this test passed on the merged wave-1 tree and in the pre-phase baseline of the main checkout, so the failure is likely worktree-environment-specific; re-verify on the merged tree.
- **Pre-existing, machine-specific (per STATE.md/project memory)**: `apps/worker/src/__tests__/sentry.test.ts` -- "with no DSN configured, does not throw and leaves the SDK uninitialized" fails deterministically on this machine because `~/.config/mega-crm/.env` carries real Sentry DSNs. Documented project-wide constraint, not caused by this plan.
- **Pre-existing, environment setup**: `apps/worker/src/__tests__/stop-grace-period-publish.test.ts` requires `apps/worker/dist/shutdown-budget.js` to exist (`npm run build -w apps/worker` was not run in this worktree). Unrelated to this plan's changes.

## Plan 22-09

- Re-observed, not caused by this plan: `apps/worker/src/queues/__tests__/failure-injection/erasure-enqueue-crash.test.ts`'s "a crash strictly between deleteContact's commit and the enqueue call is recovered end to end by one reclaim tick" and `apps/worker/src/__tests__/sentry.test.ts`'s "with no DSN configured..." both failed during this plan's `npm run test -w apps/worker` regression run, exactly as documented under Plan 22-04 above. Both reproduce in complete isolation with none of this plan's files loaded, confirming they are pre-existing and unrelated to `workspace-purge.worker.ts`/`workspace-purge-checkpoint.ts`/the new failure-injection scenario. Not fixed here.
- `npm run lint` (full repo) still fails on `apps/web/src/lib/sentry.ts`'s 4 pre-existing `@typescript-eslint/no-unsafe-*` errors, exactly as documented under Plan 22-06 above. Scoped lint (`npx eslint` against every file this plan touched) passes cleanly with zero errors.

## Plan 22-06

- **`apps/web/src/lib/sentry.ts` fails `npm run lint`** with 4 `@typescript-eslint/no-unsafe-*` errors on `import.meta.env.*` member accesses (`.MODE`, `.VITE_SENTRY_RELEASE`, `.VITE_SENTRY_DSN`). Pre-existing, unrelated to this plan's changes (this plan touches only `packages/db`). Reproduces in this worktree because Vite's ambient `ImportMetaEnv` types are unresolvable here -- consistent with the documented worktree limitation "vite/Playwright are unresolvable in worktrees" (this project's `apps/web` has no local `vite`/`@vitejs/plugin-react` resolution path from inside a git worktree with no `node_modules` of its own). Not reproduced or fixed by this plan; verify against the main checkout (which has real `node_modules`) before treating as a real regression.
