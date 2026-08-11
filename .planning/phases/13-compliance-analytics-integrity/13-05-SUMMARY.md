---
phase: 13-compliance-analytics-integrity
plan: 05
subsystem: database
tags: [postgres, drizzle, analytics, reconciliation, bullmq-worker, rls]

# Dependency graph
requires:
  - phase: 13-compliance-analytics-integrity (plan 13-02)
    provides: CMP-02 UTC day-semantics contract (`AT TIME ZONE 'UTC'` day-casts) that every new day-cast in this plan honors
provides:
  - "workspace_daily_rollup.dirtied_at column (migration 0056) marking a (workspace, day) row as needing re-verification"
  - "incrementWorkspaceDailyRollup relocated to packages/db/src/analytics/daily-rollup.ts -- importable by both apps/worker and apps/api"
  - "isNotToday(day, now) pure day-boundary predicate, decoupled from the reconciler's standing window width"
  - "findDirtyRollupDays/clearDirtyRollupDays/DIRTY_DAY_SWEEP_PAGE_LIMIT dirty-day sweep mechanism in analytics-reconciliation.worker.ts"
affects: [13-08]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "PoolClient-first query helpers relocated under packages/db/src/<domain>/<module>.ts, imported via @mega-crm/db/src/<domain>/<module>.js -- packages/db/src/reconciler/reconciler-run.ts precedent, now also packages/db/src/analytics/daily-rollup.ts"
    - "Timestamp-valued dirty marker (not boolean) with a conditional clear (dirtied_at <= sweepStartedAt) as the race-free pattern for a mark/clear contract between two independent writers"

key-files:
  created:
    - packages/db/migrations/0056_workspace_daily_rollup_dirtied_at.sql
    - packages/db/src/analytics/daily-rollup.ts
    - apps/worker/src/queues/__tests__/analytics-reconciliation-dirty-day.test.ts
    - packages/db/src/__tests__/migration-0056-workspace-daily-rollup-dirtied-at.test.ts
  modified:
    - packages/db/src/schema/workspace-daily-rollup.ts
    - apps/worker/src/queues/analytics-reconciliation.worker.ts
    - apps/worker/src/queues/webhook-events.worker.ts
    - packages/db/migrations/meta/_journal.json
    - SPECIFICATION.md

key-decisions:
  - "Lateness predicate is day != today (UTC), not 'outside the reconciler's standing window' -- closes the midnight-boundary sliver an event arriving in the last minutes before UTC midnight would otherwise leave unmarked and unverified (per review incorporation already baked into the plan)."
  - "clearDirtyRollupDays scopes its clear to the exact list of days this tick reconciled (day = ANY($2)), not just dirtied_at <= sweepStartedAt alone -- execution-discovered bug, see Deviations."
  - "reconcileWorkspace and RECONCILE_WINDOW_DAYS exported test-only so tests drive exactly 'one tick' for one workspace without a live BullMQ/Redis worker."

requirements-completed: [CMP-03]

coverage:
  - id: D1
    description: "A late (non-today, UTC) event marks its (workspace, day) rollup row dirty at increment time; a same-day event does not."
    requirement: "CMP-03"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/analytics-reconciliation-dirty-day.test.ts#incrementWorkspaceDailyRollup"
        status: pass
    human_judgment: false
  - id: D2
    description: "incrementWorkspaceDailyRollup relocated to packages/db/src/analytics/daily-rollup.ts, importable by both apps/worker and apps/api, with no re-export shim left at the old path."
    requirement: "CMP-03"
    verification:
      - kind: unit
        ref: "npm run build (tsc across all workspaces) + grep -rn incrementWorkspaceDailyRollup apps packages"
        status: pass
    human_judgment: false
  - id: D3
    description: "The reconciliation tick sweeps every dirty (workspace, day) in addition to today/yesterday, verified against a fresh sends scan, bounded by DIRTY_DAY_SWEEP_PAGE_LIMIT, with a race-free conditional clear."
    requirement: "CMP-03"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/analytics-reconciliation-dirty-day.test.ts#dirty-day sweep (CMP-03, D-14, Task 2)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Migration 0056 applies from zero and incrementally, and disturbs no existing workspace_daily_rollup counts."
    requirement: "CMP-03"
    verification:
      - kind: integration
        ref: "packages/db/src/__tests__/migration-0056-workspace-daily-rollup-dirtied-at.test.ts"
        status: pass
      - kind: integration
        ref: "npm run test:migrations (full suite, 70 tests)"
        status: pass
    human_judgment: false

duration: ~45min
completed: 2026-08-11
status: complete
---

# Phase 13 Plan 05: Dirty-day rollup reconciliation (CMP-03) Summary

**A late provider event marks its rollup day dirty via a new `dirtied_at timestamptz` column, and the reconciliation tick's dirty-day sweep re-verifies it against a fresh `sends` scan with a race-free conditional clear, bounded by a 50-day-per-tick page limit.**

## Performance

- **Duration:** ~45 min
- **Tasks:** 3 (2 TDD + 1 blocking schema-verification)
- **Files modified:** 9 (5 modified, 4 created)

## Accomplishments

- Migration `0056` adds a nullable `workspace_daily_rollup.dirtied_at timestamptz` plus a partial index on non-null values, with no backfill of existing rows.
- `incrementWorkspaceDailyRollup` relocated from `apps/worker/src/queues/analytics-rollup.ts` (now deleted) to `packages/db/src/analytics/daily-rollup.ts` -- the shared module both `apps/worker` (webhook path) and, from plan 13-08, `apps/api` (unsubscribe route) import. **No re-export shim was left at the old path** -- `grep -rn "incrementWorkspaceDailyRollup" apps packages --include=*.ts` shows every call site importing from `@mega-crm/db/src/analytics/daily-rollup.js`.
- `isNotToday(day, now)` decides lateness purely by UTC calendar day, independent of `RECONCILE_WINDOW_DAYS` -- an event arriving in the final minutes before UTC midnight is now marked, closing the sliver a window-edge predicate would have left open.
- The upsert's `dirtied_at = COALESCE(workspace_daily_rollup.dirtied_at, now())` stops a burst of late events on the same day from pushing the mark forward past the first one.
- `analytics-reconciliation.worker.ts` gained `findDirtyRollupDays`, `clearDirtyRollupDays`, and `DIRTY_DAY_SWEEP_PAGE_LIMIT = 50`. `reconcileWorkspace` (now exported, test-only) reconciles the standing today/yesterday window plus every discovered dirty day inside one per-workspace transaction, then clears.
- Migration verified additive against real seeded data (all six counts byte-identical, `dirtied_at` null after `0056` applies).

## Task Commits

Each task was committed atomically:

1. **Task 1: Add the dirtied_at marker and write it from the incremental path** - `a414faa` (feat)
2. **Task 2: Sweep dirty days in the reconciliation tick with a race-free conditional clear** - `d04f18b` (feat)
3. **Task 3: [BLOCKING] Apply and verify the schema change** - `72d6604` (test)

_TDD note: Tasks 1 and 2 share ONE named test file (`apps/worker/src/queues/__tests__/analytics-reconciliation-dirty-day.test.ts`), per the plan's single-artifact naming -- Task 1's commit adds the marking-half tests, Task 2's commit extends the same file with the sweep-half tests, rather than two separate RED commits. Both tasks were implemented and verified GREEN together with their tests in a single commit each (test file + implementation), documented as a TDD Gate Compliance note below._

## Files Created/Modified

- `packages/db/migrations/0056_workspace_daily_rollup_dirtied_at.sql` - Adds nullable `dirtied_at timestamptz` + partial index `workspace_daily_rollup_dirtied_at_idx`
- `packages/db/migrations/meta/_journal.json` - New entry, idx 56, tag `0056_workspace_daily_rollup_dirtied_at`
- `packages/db/src/schema/workspace-daily-rollup.ts` - Adds `dirtiedAt` Drizzle column + fifth CMP-02/CMP-03 day-semantics contract clause in the doc comment
- `packages/db/src/analytics/daily-rollup.ts` (new) - Relocated `incrementWorkspaceDailyRollup`/`RollupMetric`/`METRIC_COLUMN`, new `isNotToday`
- `apps/worker/src/queues/analytics-rollup.ts` (deleted) - Emptied by the relocation, no re-export shim left behind
- `apps/worker/src/queues/webhook-events.worker.ts` - Import rewritten to `@mega-crm/db/src/analytics/daily-rollup.js`
- `apps/worker/src/queues/analytics-reconciliation.worker.ts` - New `findDirtyRollupDays`/`clearDirtyRollupDays`/`DIRTY_DAY_SWEEP_PAGE_LIMIT`; `reconcileWorkspace` extended with the dirty-day sweep and exported test-only; `RECONCILE_WINDOW_DAYS` exported test-only
- `apps/worker/src/queues/__tests__/analytics-reconciliation-dirty-day.test.ts` (new) - Task 1 marking tests + Task 2 sweep/race/page-limit tests, one file per the plan's named artifact
- `packages/db/src/__tests__/migration-0056-workspace-daily-rollup-dirtied-at.test.ts` (new) - Ephemeral-DB proof that `0056` applies additively over seeded real data
- `SPECIFICATION.md` - Sections 4.2 (`workspace_daily_rollup` entry), 4.5 (new partial index row), 4.6 (journal entry count/description) updated per project convention

## Decisions Made

- **Lateness predicate is `day != today` (UTC), not "outside the standing window"** -- already decided by the plan (review incorporation from the cross-AI review pass); implemented in `isNotToday`. Confirmed via boundary tests at `23:59:00Z`/`00:01:00Z` around a UTC midnight.
- **`clearDirtyRollupDays` scopes its clear to the exact list of days reconciled this tick** (`day = ANY($2)`), not `dirtied_at <= sweepStartedAt` alone. See Deviations below -- this is a fix to what the plan's literal SQL specified.
- **`reconcileWorkspace` and `RECONCILE_WINDOW_DAYS` exported test-only** so the new test file can drive "one tick" deterministically without a live BullMQ/Redis worker, mirroring the existing test-only export pattern already used for `reconcileWorkspaceDay`/`RECONCILE_INTERVAL_MS`.
- **Task 3's migration-additivity proof is a new, dedicated ephemeral-DB test file** rather than an extension of `migrate-incremental.test.ts` -- that file's checkpoint (`0035`) predates `workspace_daily_rollup`'s own creation (`0037`), so it cannot seed a row before the checkpoint. Mirrors the `migration-0038-deadline-guard.test.ts` precedent for a migration-specific suite, and the `ingress-journal-queries.test.ts` admin-pool-for-organization-insert pattern (organization INSERT is `mega_crm_auth`-restricted past migration `0045`).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `clearDirtyRollupDays` would have silently defeated `DIRTY_DAY_SWEEP_PAGE_LIMIT`**
- **Found during:** Task 2, while writing the page-limit regression test
- **Issue:** The plan's literal SQL for `clearDirtyRollupDays` was `UPDATE ... WHERE dirtied_at IS NOT NULL AND dirtied_at <= $1` with no scoping to which days were actually reconciled this tick. Seeding `DIRTY_DAY_SWEEP_PAGE_LIMIT + 5` (55) dirty days and running one tick cleared all 55 dirty marks, even though `findDirtyRollupDays`'s `LIMIT 50` meant only 50 of those days were actually re-scanned by `reconcileWorkspaceDay`. The remaining 5 would have been falsely marked "verified" without ever being freshly scanned -- silently defeating the entire purpose of the page limit and reopening exactly the "unverified band" this plan exists to close.
- **Fix:** `clearDirtyRollupDays(client, sweepStartedAt, reconciledDays)` now takes the exact list of days this tick reconciled (the deduplicated standing+dirty `days` array already computed in `reconcileWorkspace`) and adds `AND day = ANY($2::date[])` to the UPDATE. Only days that were actually just re-verified against a fresh scan have their dirty mark cleared; a day excluded by the page limit keeps its mark for the next tick.
- **Files modified:** `apps/worker/src/queues/analytics-reconciliation.worker.ts`, and the two direct `clearDirtyRollupDays` call sites in `apps/worker/src/queues/__tests__/analytics-reconciliation-dirty-day.test.ts` (updated to pass an explicit day list).
- **Verification:** New test "a single tick reconciles at most DIRTY_DAY_SWEEP_PAGE_LIMIT dirty days, leaving the remainder still marked" -- failed before the fix (`expected 55 to be 50`), passes after.
- **Committed in:** `d04f18b` (Task 2 commit)

**2. [Rule 2 - Missing critical functionality] SPECIFICATION.md updated per CLAUDE.md's mandatory rule**
- **Found during:** Task 1
- **Issue:** CLAUDE.md requires every new column/migration/index to be recorded in `SPECIFICATION.md` §4 (Схема данных) in the same change. The plan's `files_modified` list did not include `SPECIFICATION.md`.
- **Fix:** Updated §4.2 (`workspace_daily_rollup` entry describing `dirtied_at`'s write/clear ownership), §4.5 (new partial-index row, removed from the "no explicit index" list), and §4.6 (journal entry count 56→57, migration description).
- **Files modified:** `SPECIFICATION.md`
- **Committed in:** `a414faa` (Task 1 commit)

**3. [Deviation - file not in plan's `files_modified`] New migration-verification test file**
- **Found during:** Task 3
- **Issue:** Task 3's acceptance criteria required seeding a `workspace_daily_rollup` row before applying `0056` and asserting all six counts + `dirtied_at` unchanged, but named no specific test file, and `migrate-incremental.test.ts`'s checkpoint (`0035`) predates the table's own creation (`0037`), so extending that file was not possible.
- **Fix:** New file `packages/db/src/__tests__/migration-0056-workspace-daily-rollup-dirtied-at.test.ts`, following the `migration-0038-deadline-guard.test.ts` precedent for a migration-specific ephemeral-DB suite. Picked up automatically by `npm run test:migrations` with no additional wiring.
- **Files modified:** `packages/db/src/__tests__/migration-0056-workspace-daily-rollup-dirtied-at.test.ts` (new)
- **Committed in:** `72d6604` (Task 3 commit)

---

**Total deviations:** 3 (1 auto-fixed bug, 1 CLAUDE.md-driven missing-critical addition, 1 new test file not in the plan's file list)
**Impact on plan:** All three are corrections/completions required for the plan's own correctness and project conventions. No scope creep -- the bug fix is a direct implication of the plan's own stated page-limit intent, and the SPECIFICATION.md/test-file additions are process requirements the plan's file list simply omitted.

## TDD Gate Compliance

Tasks 1 and 2 are `tdd="true"` but share a single named test artifact (`analytics-reconciliation-dirty-day.test.ts`) per the plan's `must_haves.artifacts` list. Each task's commit (`a414faa`, `d04f18b`) bundles that task's test additions together with its implementation as one `feat(...)` commit, rather than a separate `test(...)` RED commit followed by a `feat(...)` GREEN commit. Both tasks' tests were run and confirmed passing before commit, and Task 2's page-limit test specifically caught a real bug (see Deviations #1) during development, evidencing genuine test-first value even though the RED state was not captured in a standalone commit. Documented here per the plan-level TDD gate enforcement rule rather than silently omitted.

## Issues Encountered

None beyond the auto-fixed bug documented above.

## Known Stubs

None.

## Threat Flags

None -- this plan's threat register (T-13-05-01 through T-13-05-05, T-13-05-SC) covers exactly the surface implemented; no new surface introduced outside it.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plan 13-08's `apps/api` unsubscribe route can import `incrementWorkspaceDailyRollup` from `@mega-crm/db/src/analytics/daily-rollup.js` -- confirmed no re-export shim exists at the old `apps/worker/src/queues/analytics-rollup.ts` path (file deleted).
- `RECONCILE_WINDOW_DAYS` continues to live in `apps/worker/src/queues/analytics-reconciliation.worker.ts` (now exported test-only) -- the sweep still reads it to define the standing window, even though the marking predicate (`isNotToday`) no longer depends on it.
- `DIRTY_DAY_SWEEP_PAGE_LIMIT = 50` chosen as a generous bound over the expected steady state (roughly one dirty row per active workspace per day); no operational tuning needed at current scale.
- The mid-sweep race was arranged deterministically in the test by driving `findDirtyRollupDays`, an explicit-timestamp late-mark `UPDATE` (never a second `now()` call inside the same transaction, since `now()` is frozen for the transaction's duration), and `clearDirtyRollupDays` in explicit sequence against the same client/transaction -- no timing-based `setTimeout` race simulation.

---
*Phase: 13-compliance-analytics-integrity*
*Completed: 2026-08-11*

## Self-Check: PASSED

All created/modified files confirmed present on disk (migration, relocated module, worker file, both test files, this SUMMARY); `apps/worker/src/queues/analytics-rollup.ts` confirmed deleted (no re-export shim). All 4 commit hashes (`a414faa`, `d04f18b`, `72d6604`, `473907c`) confirmed present in `git log`.
