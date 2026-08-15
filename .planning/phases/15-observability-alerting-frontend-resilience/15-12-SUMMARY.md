---
phase: 15-observability-alerting-frontend-resilience
plan: 12
subsystem: database
tags: [postgres, drizzle-kit, migrations, bullmq, fastify, dashboard, analytics]

requires:
  - phase: 15-observability-alerting-frontend-resilience
    provides: correlation context (application_name stamping, plan 15-02) that the reconciliation worker's transaction wrapper already runs inside
provides:
  - "migration 0064: ops_alert_state (keyed alert-dedup table) + workspace_daily_rollup.updated_at (freshness watermark)"
  - "claimOpsAlertSlot/releaseOpsAlertSlot -- the shared atomic dedup primitive plans 15-13/15-14's four OPS-13 watchdogs will claim against"
  - "the rollup watermark maintained on both write paths (incrementWorkspaceDailyRollup, reconcileWorkspaceDay)"
  - "WorkspaceDashboardFreshness (dataAsOf/lagMinutes) exposed on the workspace dashboard API response"
affects: [15-13, 15-14, 15-15]

tech-stack:
  added: []
  patterns:
    - "Keyed alert-dedup table (ops_alert_state, alert_name PK) shared across multiple platform-level watchdogs instead of one singleton table per watchdog"
    - "Freshness watermark column (updated_at, unconditional now() on every write) as the honest backing signal for a 'data as of' UI timestamp"

key-files:
  created:
    - packages/db/migrations/0064_ops_alert_state_and_rollup_watermark.sql
    - packages/db/migrations/meta/0064_snapshot.json
    - packages/db/src/schema/ops-alert-state.ts
    - packages/db/src/ops/alert-state.ts
    - packages/db/src/__tests__/ops-alert-state.test.ts
    - apps/api/src/modules/analytics/__tests__/rollup-watermark.test.ts
    - packages/shared-schemas/src/analytics.ts
  modified:
    - packages/db/migrations/meta/_journal.json
    - packages/db/src/migration-tiers.ts
    - packages/db/src/index.ts
    - packages/db/src/schema/workspace-daily-rollup.ts
    - packages/db/src/analytics/daily-rollup.ts
    - packages/db/src/__tests__/migration-tiers.test.ts
    - packages/db/src/__tests__/migration-empty-diff.test.ts
    - packages/db/src/__tests__/migration-rollback-rehearsal.test.ts
    - packages/db/src/__tests__/send-events-dedup-rebase.test.ts
    - apps/worker/src/queues/analytics-reconciliation.worker.ts
    - apps/worker/src/queues/__tests__/analytics-reconciliation.test.ts
    - apps/api/src/modules/analytics/dashboard.repository.ts
    - apps/api/src/modules/analytics/dashboard.routes.ts
    - packages/shared-schemas/src/index.ts
    - SPECIFICATION.md

key-decisions:
  - "ops_alert_state is keyed by alert_name (text PK), never a singleton -- one table for all four future OPS-13 watchdogs instead of four dedicated tables, per 15-RESEARCH.md's resolved Open Question 2"
  - "claimOpsAlertSlot extends the existing UPDATE...RETURNING claim shape with an upsert (INSERT...ON CONFLICT DO UPDATE...WHERE...RETURNING) so a first-ever claim for an alert name needs no seeded row"
  - "workspace_daily_rollup.updated_at is set unconditionally (never COALESCE'd) on every write, unlike dirtied_at -- it answers 'when was this row last written', a value that changes on every write by definition"
  - "lagMinutes is derived only from the oldest outstanding dirtied_at mark, never from watermark age -- a quiet workspace with old rollup rows and zero dirty marks reports no lag (T-15-40)"
  - "dataAsOf/lagMinutes computed inside the existing workspace-scoped repository query -- no new live send_events/sends aggregate introduced"

patterns-established:
  - "Freshness watermark pattern: unconditional now() on write, exposed via a shared-schemas type, computed from already-scoped rows plus one targeted aggregate query -- reusable for any future 'data as of' signal"

requirements-completed: [OPS-13, OPS-18]

coverage:
  - id: D1
    description: "Migration 0064 creates ops_alert_state (keyed by alert_name, no singleton CHECK) and adds workspace_daily_rollup.updated_at, in one migration"
    requirement: "OPS-13"
    verification:
      - kind: unit
        ref: "packages/db/src/__tests__/migration-empty-diff.test.ts (schema<->snapshot parity)"
        status: pass
      - kind: integration
        ref: "packages/db/src/__tests__/migrate-from-empty.test.ts and migrate-incremental.test.ts (full chain application)"
        status: pass
    human_judgment: false
  - id: D2
    description: "claimOpsAlertSlot/releaseOpsAlertSlot -- atomic, multi-replica-safe alert-dedup primitive with independent per-name windows and safe release"
    requirement: "OPS-13"
    verification:
      - kind: unit
        ref: "packages/db/src/__tests__/ops-alert-state.test.ts (8 tests, including a real two-connection concurrency case)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Rollup watermark maintained on both write paths (incremental upsert and reconciliation overwrite)"
    requirement: "OPS-18"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/analytics/__tests__/rollup-watermark.test.ts#an incremental rollup increment sets the row's watermark to the write time"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/analytics-reconciliation.test.ts#reconciliation overwrite sets the row's watermark to the write time"
        status: pass
    human_judgment: false
  - id: D4
    description: "Dashboard API exposes dataAsOf (newest watermark in window, null if no rows) and lagMinutes (oldest outstanding dirty mark's age, null if none, never derived from data age)"
    requirement: "OPS-18"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/analytics/__tests__/rollup-watermark.test.ts (5 tests covering every <behavior> case)"
        status: pass
    human_judgment: false

duration: 40min
completed: 2026-08-15
status: complete
---

# Phase 15 Plan 12: ops_alert_state and rollup watermark Summary

**Migration 0064 (ops_alert_state keyed alert-dedup table + workspace_daily_rollup.updated_at watermark), the shared claimOpsAlertSlot/releaseOpsAlertSlot primitive, and a dashboard freshness signal (dataAsOf/lagMinutes) derived honestly from unreconciled dirty marks, never data age.**

## Performance

- **Duration:** ~40 min
- **Tasks:** 3
- **Files modified/created:** 25 (10 in Task 1, 2 in Task 2, 10 in Task 3, plus 3 shared across)

## Accomplishments

- The phase's single migration slot (0064) creates `ops_alert_state` (keyed, not singleton) for the four upcoming OPS-13 watchdogs and adds the `workspace_daily_rollup.updated_at` freshness watermark, proven both `npm run test:migrations`-green and `db:check-empty-diff`-clean (new drizzle-kit snapshot backfilled, matching the 0062/0063 precedent).
- `claimOpsAlertSlot`/`releaseOpsAlertSlot` (`packages/db/src/ops/alert-state.ts`) give all four future OPS-13 watchdogs one proven, multi-replica-safe dedup primitive — a single atomic `INSERT ... ON CONFLICT ... WHERE ... RETURNING` statement, verified under a real two-connection concurrency race.
- The rollup watermark is now genuinely maintained on both write paths (`incrementWorkspaceDailyRollup`'s ON CONFLICT branch and `reconcileWorkspaceDay`'s absolute overwrite), and the dashboard API honestly answers "as of when" (`dataAsOf`) and "how far behind" (`lagMinutes`, derived only from unreconciled dirty marks, never data age) — closing the gap D-12 assumed was already closed.

## Task Commits

Each task was committed atomically (Tasks 2 and 3 followed full RED/GREEN TDD, each verified failing before the implementation existed):

1. **Task 1: Migration 0064 and its Drizzle schema modules** - `0118b82` (feat)
2. **Task 2: The shared alert-claim primitive**
   - RED: `ccb1912` (test) - failing test committed and confirmed failing (module not found) before the implementation existed
   - GREEN: `2d09733` (feat) - implementation restored, 8/8 tests pass
3. **Task 3: Maintain the rollup watermark and expose it through the analytics API**
   - RED: `51c94a6` (test) - failing test committed and confirmed failing (5/5 assertions genuinely fail) against the pre-implementation code
   - GREEN: `29260bb` (feat) - implementation restored, 5/5 tests pass, plus the deviations below

_No separate plan-metadata commit — SUMMARY.md is force-added under this worktree's `.planning/` gitignore rules (see below)._

## Files Created/Modified

- `packages/db/migrations/0064_ops_alert_state_and_rollup_watermark.sql` - the phase's single migration: `ops_alert_state` (keyed) + `workspace_daily_rollup.updated_at` (additive)
- `packages/db/migrations/meta/0064_snapshot.json` - drizzle-kit snapshot backfilled via `generateDrizzleJson` (never hand-typed), chained from `0063_snapshot.json`'s id
- `packages/db/migrations/meta/_journal.json` - new entry for tag `0064_ops_alert_state_and_rollup_watermark`
- `packages/db/src/schema/ops-alert-state.ts` - Drizzle type-inference module for `ops_alert_state`
- `packages/db/src/schema/workspace-daily-rollup.ts` - adds `updatedAt` column + doc comment
- `packages/db/src/migration-tiers.ts` - classifies 0064 as `auto-reversible`
- `packages/db/src/index.ts` - registers the new schema module in the barrel's import/spread pair (not the `export *` re-export list, matching `partition-retention-drops.ts`'s own precedent)
- `packages/db/src/ops/alert-state.ts` - `claimOpsAlertSlot`/`releaseOpsAlertSlot`
- `packages/db/src/analytics/daily-rollup.ts` - `incrementWorkspaceDailyRollup` sets `updated_at = now()` on both branches
- `apps/worker/src/queues/analytics-reconciliation.worker.ts` - `reconcileWorkspaceDay` sets `updated_at = EXCLUDED.updated_at`
- `packages/shared-schemas/src/analytics.ts` - `WorkspaceDashboardFreshness` (`dataAsOf`/`lagMinutes`), the single shared type
- `packages/shared-schemas/src/index.ts` - exports the new file
- `apps/api/src/modules/analytics/dashboard.repository.ts` - `WorkspaceDashboard` extends `WorkspaceDashboardFreshness`; computes both fields from the existing window-scoped rollup query plus one added `min(dirtied_at)` query
- `apps/api/src/modules/analytics/dashboard.routes.ts` - doc comment only, no functional change
- Test files: `packages/db/src/__tests__/ops-alert-state.test.ts`, `apps/api/src/modules/analytics/__tests__/rollup-watermark.test.ts`, plus updates to `migration-tiers.test.ts`, `migration-empty-diff.test.ts`, `migration-rollback-rehearsal.test.ts`, `send-events-dedup-rebase.test.ts`, `analytics-reconciliation.test.ts` (see Deviations)
- `SPECIFICATION.md` - sections 4.2 (`ops_alert_state`, `workspace_daily_rollup.updated_at`), 4.6 (journal entry), 7 (watermark/lag semantics)

## Decisions Made

- `ops_alert_state` keyed by `alert_name` (text PK), matching 15-RESEARCH.md's resolved recommendation over four dedicated singleton tables.
- The claim statement is a single `INSERT ... ON CONFLICT (alert_name) DO UPDATE ... WHERE ... RETURNING` — Postgres never evaluates the `DO UPDATE`'s `WHERE` predicate on the plain INSERT path, so a first-ever claim for a name always succeeds without a seeded row.
- `workspace_daily_rollup.updated_at` is set unconditionally on every write (never `COALESCE`d, unlike `dirtied_at`) — it answers "when was this row last written", which by definition changes on every write.
- `lagMinutes` is derived exclusively from the oldest outstanding `dirtied_at` mark, deliberately unbounded by the requested period window (a stuck backlog older than the visible window must still surface) and never from `dataAsOf`'s own age (T-15-40).
- `dataAsOf`/`lagMinutes` live in a new `packages/shared-schemas/src/analytics.ts` file as the single shared type — `dashboard.repository.ts`'s `WorkspaceDashboard` extends it rather than duplicating the two fields inline, so a future frontend consumer (plan 15-15) imports the same type instead of re-declaring it.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1/3] Migration-adjacent bookkeeping required for `test:migrations`/`db:check-empty-diff` to stay green**
- **Found during:** Task 1
- **Issue:** Adding migration 0064 alone is insufficient — `packages/db/migrations/meta/_journal.json` (which `drizzle-orm`'s own `migrate()` reads directly) needed a new entry, and `db:check-empty-diff`'s schema<->snapshot parity check needed a `0064_snapshot.json` (following the 0062/0063 precedent of using drizzle-kit's own `generateDrizzleJson` API, never hand-typed). Three pinned unit tests (`migration-tiers.test.ts`'s `newestAutoReversibleTier()` array, `migration-empty-diff.test.ts`'s `comparedAgainstSnapshot`/count/`newestTag`/`listSnapshotFiles` assertions, `migration-rollback-rehearsal.test.ts`'s `MIGRATION_INVERSES` registry) had literal expectations naming 0063 as the newest migration.
- **Fix:** Added the journal entry, generated the snapshot via a throwaway script using `drizzle-kit/api`'s `generateDrizzleJson` (deleted after use), updated the three pinned tests, and added a hand-verified inverse for 0064 (`DROP TABLE ops_alert_state; ALTER TABLE workspace_daily_rollup DROP COLUMN updated_at`).
- **Files modified:** `packages/db/migrations/meta/_journal.json`, `packages/db/migrations/meta/0064_snapshot.json`, `packages/db/src/__tests__/migration-tiers.test.ts`, `packages/db/src/__tests__/migration-empty-diff.test.ts`, `packages/db/src/__tests__/migration-rollback-rehearsal.test.ts`
- **Verification:** `npm run test:migrations` — 27/28 files green (see Issues Encountered for the one pre-existing flaky test)
- **Committed in:** `0118b82` (Task 1 commit)

**2. [Rule 1] Existing migration-behavior test broke because it called the CURRENT shared rollup function against a pinned historical migration checkpoint**
- **Found during:** Task 3
- **Issue:** `packages/db/src/__tests__/send-events-dedup-rebase.test.ts` pins its database to a checkpoint before migration 0057 (to test 0057's own apply-time behavior in isolation) and previously called the CURRENT `incrementWorkspaceDailyRollup` to seed a rollup row. Since that function now unconditionally writes `updated_at` (added by migration 0064, not yet applied at the 0056 checkpoint), the call failed with `column "updated_at" of relation "workspace_daily_rollup" does not exist`.
- **Fix:** Replaced the call with a direct `INSERT` of only the columns that exist at that checkpoint — this test was never exercising `incrementWorkspaceDailyRollup`'s own behavior, only needing some rollup row to exist to prove 0057 leaves rollup totals unchanged.
- **Files modified:** `packages/db/src/__tests__/send-events-dedup-rebase.test.ts`
- **Verification:** `npx vitest run --root packages/db` — the previously-failing test now passes; full suite re-run confirms no other collateral breakage
- **Committed in:** `29260bb` (Task 3 GREEN commit)

**3. [Rule 2] Added a watermark assertion to an existing test file not in this plan's own `files_modified` list**
- **Found during:** Task 3
- **Issue:** The plan's acceptance criteria requires "a test asserts each [write path] independently" for both the incremental upsert and the reconciliation overwrite. `reconcileWorkspaceDay` lives in `apps/worker`, which `apps/api` cannot import (`apps/worker` declares `@mega-crm/api` as a devDependency, never the reverse) — so this assertion could only live in `apps/worker`'s own test tree, not in the new `apps/api` test file the plan explicitly lists.
- **Fix:** Added a new test case to `apps/worker/src/queues/__tests__/analytics-reconciliation.test.ts`, following the same RED/GREEN discipline as the plan's own TDD tasks (reverted the implementation, confirmed the new assertion alone failed while the three pre-existing tests stayed green, then restored).
- **Files modified:** `apps/worker/src/queues/__tests__/analytics-reconciliation.test.ts`
- **Verification:** `npx vitest run --root apps/worker src/queues/__tests__/analytics-reconciliation.test.ts` — 4/4 pass
- **Committed in:** `29260bb` (Task 3 GREEN commit)

---

**Total deviations:** 3 auto-fixed (2 Rule 1 — direct consequences of the migration/shared-function change required for tests to stay green, 1 Rule 2 — closing an acceptance-criteria gap the plan's own file list couldn't satisfy given the cross-app dependency direction).
**Impact on plan:** All three deviations are necessary consequences of the plan's own instructions, not scope creep — none change what the plan asked for, only what else needed to move in lockstep for it to be provably true.

## Issues Encountered

- **Worktree module-resolution artifact (not a plan defect, documented for the next executor).** This worktree has no `node_modules` of its own; Node's bare-specifier resolution for `@mega-crm/*` packages and several third-party deps nested non-hoisted in specific packages (`bullmq`, `@ioredis`, `ioredis`, `semver`) walked up to the MAIN checkout's `node_modules`, whose workspace symlinks point at the main checkout's own `packages/db` etc. — NOT this worktree's copy. This silently made `scripts/migrate-runner.mjs` (spawned as a child process by two `packages/db` tests) apply only 64 of the 65 shipped migrations, and made an `apps/api` test fail to resolve `bullmq` at all (a transitive import from `contact.repository.ts`). Fixed by creating worktree-local symlinks (`node_modules/@mega-crm/*` plus the four nested third-party packages inside `apps/api/node_modules`, `apps/worker/node_modules`, `packages/db/node_modules`, `packages/queue-core/node_modules`) mirroring the main checkout's own relative targets — untracked, gitignored, no tracked file touched. Any future worktree-isolated executor touching `packages/db` migrations or spawning `scripts/migrate-runner.mjs` as a child process should expect this and apply the same fix.
- **One pre-existing flaky test, confirmed unrelated to this plan.** `packages/db/src/__tests__/migrate-runner-advisory-lock.test.ts`'s "no advisory lock leaks past a successful run" sub-assertion failed intermittently under full-suite concurrency (observed 3 of ~5 full-`test:migrations` runs) but passed 100% of the time in isolation, both before and after every change in this plan. Real-clock/real-concurrency timing sensitivity under load, not a regression — left as-is per this executor's scope (no file in this test belongs to this plan).
- **Full-repo `npm run lint` reports 4 pre-existing errors in `apps/web/src/lib/sentry.ts`** (type-aware `no-unsafe-*` rules on `import.meta.env` access) — this file is untouched by this plan; per this plan's own `<lint_note>`, fresh worktrees lack build artifacts that type-aware ESLint rules need, producing spurious repo-wide errors on files this plan does not touch. Scoped `eslint` on every file this plan actually modified is clean (0 errors, confirmed after one fix to two `@typescript-eslint/no-unnecessary-type-assertion` findings in the new test file).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `claimOpsAlertSlot`/`releaseOpsAlertSlot` and `ops_alert_state` are ready for plans 15-13/15-14 to build the four OPS-13 watchdogs (queue depth, oldest job age, webhook lag, failed-send share) directly on top of.
- `WorkspaceDashboardFreshness` (`dataAsOf`/`lagMinutes`) is live on the dashboard API response; plan 15-15's frontend half (the "Data as of HH:MM" timestamp + conditional stale banner) can consume it directly with no further backend work.
- No blockers. The phase's single migration slot is now consumed — per this plan's own prohibition, no later plan in phase 15 may add a second migration file.
