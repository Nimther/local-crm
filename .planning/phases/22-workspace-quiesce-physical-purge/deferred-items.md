# Deferred Items — Phase 22 (workspace-quiesce-physical-purge)

## Plan 22-04

- **Pre-existing, out of scope**: `apps/worker/src/queues/__tests__/failure-injection/erasure-enqueue-crash.test.ts` -- "a crash strictly between deleteContact's commit and the enqueue call is recovered end to end by one reclaim tick" fails with `"No tenant context set for this request"` instead of the expected `/INJECTED FAILURE/` match. Reproduces in complete isolation (`vitest run erasure-enqueue-crash` alone), unrelated to scan policies, campaigns, flows, flow_runs or analytics-reconciliation -- none of which this test touches. Not fixed here per the deviation-rules scope boundary (only auto-fix issues directly caused by the current task's changes).
- **Pre-existing, machine-specific (per STATE.md/project memory)**: `apps/worker/src/__tests__/sentry.test.ts` -- "with no DSN configured, does not throw and leaves the SDK uninitialized" fails deterministically on this machine because `~/.config/mega-crm/.env` carries real Sentry DSNs. Documented project-wide constraint, not caused by this plan.
- **Pre-existing, environment setup**: `apps/worker/src/__tests__/stop-grace-period-publish.test.ts` requires `apps/worker/dist/shutdown-budget.js` to exist (`npm run build -w apps/worker` was not run in this worktree). Unrelated to this plan's changes.
