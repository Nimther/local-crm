---
phase: 13-compliance-analytics-integrity
plan: 02
subsystem: analytics
tags: [postgres, timezone, bullmq, drizzle, workspace-daily-rollup]

# Dependency graph
requires:
  - phase: 07-analytics-dashboard-send-log
    provides: workspace_daily_rollup table, reconcileWorkspaceDay backstop, incrementWorkspaceDailyRollup incremental path
  - phase: 12-worker-reliability-tenant-fairness
    provides: upsertJobScheduler-based recurring tick pattern (JOB_SCHEDULER_ID, autorun G-12-1 fix), scheduler-registration.test.ts / worker-autorun-default.test.ts fixtures
provides:
  - Session-timezone-independent workspace_daily_rollup reconciliation (all eight day-bucketing casts forced to AT TIME ZONE 'UTC')
  - SEND_DAY_FIELD ("sent_at") and RECONCILE_INTERVAL_MS exported as documented authorities
  - CMP-02 four-clause day-semantics contract in workspace-daily-rollup.ts's schema doc comment
  - CMP-06 regression test asserting the analytics-reconciliation scheduler's `every` interval
affects: [13-03-unknown-send-visibility, 16-uat-analytics]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Bucket a timestamptz by calendar day using explicit `(col AT TIME ZONE 'UTC')::date`, never a bare `col::date` -- a bare cast converts through the session's TimeZone GUC first, making the result depend on which pooled connection served the query"

key-files:
  created:
    - apps/worker/src/queues/__tests__/reconcile-utc-day.test.ts
  modified:
    - apps/worker/src/queues/analytics-reconciliation.worker.ts
    - apps/worker/src/queues/analytics-rollup.ts
    - packages/db/src/schema/workspace-daily-rollup.ts
    - apps/worker/src/queues/__tests__/scheduler-registration.test.ts

key-decisions:
  - "sent_at (SendGrid-acceptance time) is the documented day authority for sent_count; every event-derived counter keys off the provider's own occurred_at UTC day instead -- a two-field contract, not one, because sending itself produces no provider event"
  - "RECONCILE_INTERVAL_MS exported from analytics-reconciliation.worker.ts so the scheduler-interval regression test asserts against the single source of truth instead of a duplicated magic number"

patterns-established:
  - "Pattern: any query bucketing a timestamptz by day must use `AT TIME ZONE 'UTC'` explicitly -- documented in reconcileWorkspaceDay's doc comment as applying to any FUTURE such query in this codebase, not just this one"

requirements-completed: [CMP-02, CMP-06]

coverage:
  - id: D1
    description: "reconcileWorkspaceDay produces byte-identical sent/delivered/opened/clicked/bounced/unsubscribed counts under session TimeZone UTC, America/New_York, and Asia/Tokyo"
    requirement: "CMP-02"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/reconcile-utc-day.test.ts#reconciling the same seeded workspace-day under UTC, America/New_York, and Asia/Tokyo yields identical counts"
        status: pass
    human_judgment: false
  - id: D2
    description: "A send at 23:30 UTC on day N lands in day N's rollup, and a send at 00:30 UTC on day N+1 lands in day N+1's rollup, under all three tested session timezones"
    requirement: "CMP-02"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/reconcile-utc-day.test.ts#buckets a 23:30 UTC send into 2026-03-15 and a 00:30 UTC send into 2026-03-16 under session TimeZone 'UTC'/'America/New_York'/'Asia/Tokyo'"
        status: pass
    human_judgment: false
  - id: D3
    description: "Running reconciliation twice with no new sends leaves every count byte-identical, exercised under a non-UTC session timezone"
    requirement: "CMP-02"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/reconcile-utc-day.test.ts#running reconciliation twice in a row with no intervening writes leaves all six counts unchanged, under a non-UTC session TimeZone"
        status: pass
    human_judgment: false
  - id: D4
    description: "The CMP-02 day-semantics contract (sent_at authority, event-column agreement, unknown-exclusion) is written into workspace-daily-rollup.ts's schema doc comment where both write paths are read"
    requirement: "CMP-02"
    verification:
      - kind: other
        ref: "packages/db/src/schema/workspace-daily-rollup.ts doc comment, four numbered clauses"
        status: pass
    human_judgment: false
  - id: D5
    description: "A regression that removes or misconfigures the analytics-reconciliation recurring schedule (wrong id, wrong interval) fails a test"
    requirement: "CMP-06"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/scheduler-registration.test.ts#the registered job scheduler's every interval equals RECONCILE_INTERVAL_MS"
        status: pass
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/scheduler-registration.test.ts#'analytics-reconciliation' > constructing the worker twice still leaves exactly one scheduler with that id"
        status: pass
    human_judgment: false

duration: ~15min
completed: 2026-08-11
status: complete
---

# Phase 13 Plan 02: CMP-02/CMP-06 UTC Day-Semantics & Recurring-Job Regression Guard Summary

**All eight `reconcileWorkspaceDay` day-bucketing casts forced to `AT TIME ZONE 'UTC'`, proven session-timezone-invariant across three test timezones, with the day-semantics contract pinned in `workspace-daily-rollup.ts` and a new scheduler-interval regression test for CMP-06.**

## Performance

- **Duration:** ~15 min
- **Completed:** 2026-08-11
- **Tasks:** 3 (all `type="auto"`, no checkpoints)
- **Files modified:** 4 modified, 1 created

## Accomplishments

- Fixed the CMP-02 day-semantics defect: `reconcileWorkspaceDay`'s eight `<col>::date = $2::date` FILTER casts (sent_at, delivered_at, first_opened_at, first_clicked_at, bounced_at, dropped_at, spam_reported_at, unsubscribed_at) now wrap each column in `AT TIME ZONE 'UTC'` before truncating to a date, eliminating the dependency on the pooled connection's session `TimeZone` GUC.
- Proved the fix with `reconcile-utc-day.test.ts` (5 new tests, one parameterized across UTC/America/New_York/Asia/Tokyo): boundary sends at 23:30 UTC / 00:30 UTC land on the correct calendar day under all three session timezones, identical counts across all three, and a double-run-is-identical assertion under a non-UTC session.
- Pinned the CMP-02 day-semantics contract as a four-numbered-clause doc comment in `workspace-daily-rollup.ts` (UTC-only day, `sent_at` authority for `sent_count`, event-derived counters must agree between both write paths, `unknown`-status exclusion) and extended `analytics-rollup.ts`'s doc comment to state the "UTC ISO-8601 string" input contract for `occurredAt`.
- Closed the one CMP-06 gap in the existing scheduler-registration regression coverage: the registered job scheduler's `every` interval now has an explicit assertion against the newly-exported `RECONCILE_INTERVAL_MS`, so a regression that silently changed the reconciliation cadence would fail a test.

## Task Commits

1. **Task 1: Force every reconciliation day-cast to UTC** - `9075263` (fix)
2. **Task 2: Pin the day-semantics contract where both write paths can see it** - `762a4b0` (docs)
3. **Task 3: Assert reconciliation is a recurring job, not a one-off fix (CMP-06)** - `d916dd9` (test)

**Plan metadata:** (this commit, docs: complete plan) — not yet created at time of writing

_Note: no TDD tasks in this plan; Task 1 is `tdd="true"` but its RED/GREEN split was not literally separated into two commits since the fix (eight cast edits) and the new test were authored together and both passed on first run — the plan's `<verify>` requirement (existing + new tests green) was met._

## Files Created/Modified

- `apps/worker/src/queues/analytics-reconciliation.worker.ts` - Eight FILTER casts forced to `AT TIME ZONE 'UTC'`; exports `SEND_DAY_FIELD = "sent_at"` and `RECONCILE_INTERVAL_MS`; extended doc comments with the CMP-02 rationale
- `apps/worker/src/queues/__tests__/reconcile-utc-day.test.ts` - New: 5 tests proving UTC-day invariance across three session timezones and the boundary/double-run behaviors
- `packages/db/src/schema/workspace-daily-rollup.ts` - Added the CMP-02 four-clause day-semantics contract to the table's doc comment
- `apps/worker/src/queues/analytics-rollup.ts` - Extended `incrementWorkspaceDailyRollup`'s doc comment with the UTC ISO-8601 input-contract statement for `occurredAt`
- `apps/worker/src/queues/__tests__/scheduler-registration.test.ts` - Added a new `describe` block asserting the analytics-reconciliation scheduler's `every` interval equals `RECONCILE_INTERVAL_MS`

## Decisions Made

- **Exported `RECONCILE_INTERVAL_MS`** from `analytics-reconciliation.worker.ts` (not in the plan's explicit artifact list, but required to satisfy Task 3's stated behavior "the registered scheduler's `every` interval equals `RECONCILE_INTERVAL_MS`" without duplicating the `180000` literal into the test file as an undocumented magic number). This is a minor addition beyond the plan's literal artifact list, justified under Rule 2 (the behavior specified in the plan cannot be tested against a single source of truth otherwise).
- **New scheduler-interval test placed in a separate top-level `describe` block** in `scheduler-registration.test.ts` (own `TempRedis`, own lifecycle) rather than folding it into the existing `describe.each(FIXTURES)` loop, since the `every`-interval value differs per fixture (only analytics-reconciliation's `RECONCILE_INTERVAL_MS` is exported/asserted here) and the task explicitly scoped this to "an analytics-reconciliation block."
- **No duplicate assertion for CMP-06 behavior 1 or 3** (stable scheduler id across two constructions; autorun default absent under the production single-argument call shape) since both were already covered — respectively by this same file's existing `describe.each(FIXTURES)` "analytics-reconciliation" case, and by `worker-autorun-default.test.ts`'s analytics-reconciliation fixture case. Documented per the plan's explicit instruction ("record in the SUMMARY which behaviors were pre-existing").

## Deviations from Plan

### Auto-fixed Issues

None — no Rule 1/2/3 auto-fixes were needed beyond the `RECONCILE_INTERVAL_MS` export decision documented above (which is a minor scope addition, not a bug fix).

---

**Total deviations:** 0 auto-fixed bugs/blockers. 1 minor scope addition (exporting `RECONCILE_INTERVAL_MS`), documented above.
**Impact on plan:** None on scope or intent — the export exists solely to let the CMP-06 regression test assert against the single source of truth.

## Issues Encountered

- `npm run build` fails on the unrelated `apps/web` workspace (`TS2688: Cannot find type definition file for 'vite/client'`) — confirmed pre-existing: `vite` is not installed anywhere reachable from this worktree's node_modules resolution chain, unrelated to any file this plan touches. Logged to `.planning/phases/13-compliance-analytics-integrity/deferred-items.md` per the scope-boundary rule; not auto-fixed (installing a missing package requires a human/package-legitimacy checkpoint per Rule 3's exclusion, and this is an environment gap, not something this plan introduced). `npm run build` for the three workspaces this plan actually touches (`@mega-crm/worker`, `@mega-crm/db`, `@mega-crm/api`) succeeds cleanly. `npm run lint` (repo-wide, `--max-warnings=0`) exits 0.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- CMP-02 and CMP-06 are both closed: daily metrics are provably session-timezone-independent, and a regression that removes or misconfigures the recurring reconciliation schedule now fails a test.
- Plan 13-03 (unknown-send visibility, per the doc comment's forward reference) can build on the now-explicit `workspace_daily_rollup` day-semantics contract without re-deriving it.
- No blockers for the rest of Phase 13. The unrelated `apps/web` build gap (pre-existing, logged in deferred-items.md) should be resolved by whichever plan/step performs the environment's dependency install, but does not block this plan's own verification.

---
*Phase: 13-compliance-analytics-integrity*
*Completed: 2026-08-11*
