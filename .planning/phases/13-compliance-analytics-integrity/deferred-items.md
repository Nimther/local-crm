# Deferred Items — Phase 13

Out-of-scope discoveries logged per executor scope-boundary rule (not fixed, not caused by the plan executing when found).

## 13-02

- **`npm run build` fails in `apps/web`** with `TS2688: Cannot find type definition file for 'vite/client'`. Root cause: `vite` is not installed anywhere reachable from this worktree's node_modules resolution chain (confirmed: no `vite` package under the worktree, the parent repo checkout, or any ancestor `node_modules`). Pre-existing environment/dependency-install gap, unrelated to plan 13-02's files (`apps/worker/src/queues/analytics-reconciliation.worker.ts`, `apps/worker/src/queues/analytics-rollup.ts`, `packages/db/src/schema/workspace-daily-rollup.ts`, and the two test files) — none of which touch `apps/web`. `npm run build` for the workspaces this plan actually modified (`@mega-crm/worker`, `@mega-crm/db`, `@mega-crm/api`) succeeds cleanly. Not auto-fixed: installing a missing package is excluded from Rule 3 auto-fix and requires a human/package-legitimacy checkpoint, and this dependency gap is pre-existing, not introduced by this plan.
