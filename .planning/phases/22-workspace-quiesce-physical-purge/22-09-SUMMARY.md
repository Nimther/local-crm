---
phase: 22-workspace-quiesce-physical-purge
plan: 09
subsystem: testing
tags: [postgres, sigkill, failure-injection, vitest, workspace-purge, checkpoint-resume]

# Dependency graph
requires:
  - phase: 22-workspace-quiesce-physical-purge
    provides: "the full FK-ordered purge walk (22-05), restore/report CLIs (22-06), the auth-table purge step wired after tables/before tombstone (22-07), and the stuck-purge watchdog (22-08)"
provides:
  - "a real-SIGKILL failure-injection proof (not simulated) that a workspace purge killed at any of its three seams -- mid-batch, between tables, before the tail -- resumes and completes on the next tick"
  - "ProcessWorkspacePurgeDeps.afterTableWalk, a no-op-by-default test seam in workspace-purge.worker.ts for freezing precisely between the table walk and the auth-step/tombstone tail"
affects: [22-secure-phase, ship-gate]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Child-process kill-resume harness (apps/worker/src/test/harness/workspace-purge-kill-entrypoint.ts): freezes a real deletePurgeBatch call scoped to a target workspace_id, at one of three seams selected by an env var, signalling readiness over IPC before the parent SIGKILLs -- mirrors sigkill-entrypoint.ts's freeze-then-signal shape but generalizes it to three seams instead of one injected mail call"
    - "Test-only dependency-injection seam (afterTableWalk) added to production code specifically to make an otherwise-uncheckpointed boundary (auth step + tombstone) killable at an exact, deterministic point"

key-files:
  created:
    - apps/worker/src/queues/__tests__/failure-injection/workspace-purge-resume.test.ts
    - apps/worker/src/test/harness/workspace-purge-kill-entrypoint.ts
  modified:
    - apps/worker/src/queues/workspace-purge.worker.ts
    - package.json

key-decisions:
  - "Task 1's kill point IS the mid-batch seam: freeze after the real DELETE for a target workspace's Nth meaningful (non-zero) batch has executed but before that transaction's COMMIT, so the killed batch's rows are provably still present (MVCC visibility, not a timing race) while every earlier batch is provably gone"
  - "Between-tables and before-the-tail seams freeze BEFORE any work is attempted for the next boundary (no DELETE issued, no lock held), so their resumes need no lock-release tolerance -- only the mid-batch seam's resume needs a short bounded retry for the killed backend's lock to clear"
  - "Added ProcessWorkspacePurgeDeps.afterTableWalk (workspace-purge.worker.ts) as the only way to land a real kill precisely between the table loop's own checkpoint and the un-checkpointed auth-step/tombstone tail -- a no-op unless a caller supplies one, never used in production"
  - "Freeze predicates are workspace_id-scoped (WPK_TARGET_WORKSPACE_ID), not table/call-index alone, so a neighbour workspace processed in the same tick by processWorkspacePurge's global scan is never accidentally frozen instead of the intended subject"

requirements-completed: [PRG-03]

coverage:
  - id: D1
    description: "A purge killed by a real SIGKILL mid-batch resumes and completes on the next tick, with a control-run-identical, census-unchanged table_counts"
    requirement: "PRG-03"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/failure-injection/workspace-purge-resume.test.ts#mid-batch SIGKILL resumes and completes"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/failure-injection/workspace-purge-resume.test.ts#counts match an uninterrupted run"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/failure-injection/workspace-purge-resume.test.ts#counts match the census"
        status: pass
    human_judgment: false
  - id: D2
    description: "A purge killed between two tables leaves the finished table marked done and empty, the unfinished table untouched, and resumes to completion"
    requirement: "PRG-03"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/failure-injection/workspace-purge-resume.test.ts#kill between tables"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/failure-injection/workspace-purge-resume.test.ts#resume does not re-walk"
        status: pass
    human_judgment: false
  - id: D3
    description: "A purge killed after every table but before the tail leaves membership rows and the tombstone untouched, then the resume finishes the auth step and tombstones the organization; a later replay tick is a no-op"
    requirement: "PRG-03"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/failure-injection/workspace-purge-resume.test.ts#kill before the tail"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/failure-injection/workspace-purge-resume.test.ts#double resume"
        status: pass
    human_judgment: false
  - id: D4
    description: "The scenario is a named npm script and part of failure:all, exercised like the other sixteen scenarios"
    verification:
      - kind: other
        ref: "node -e check against package.json scripts['failure:workspace-purge-resume'] and scripts['failure:all']"
        status: pass
    human_judgment: false

# Metrics
duration: 25min
completed: 2026-08-24
status: complete
---

# Phase 22 Plan 09: Real-SIGKILL Workspace Purge Kill-Resume Proof Summary

**Real-SIGKILL failure-injection scenario proving a workspace purge killed at any of three seams (mid-batch, between tables, before the tail) resumes and completes with destroyed-row counts identical to an uninterrupted purge — plus a new `afterTableWalk` test seam in `workspace-purge.worker.ts` that makes the otherwise-uncheckpointed auth-step/tombstone tail killable at an exact point.**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-08-23T23:59:58+05:00 (base commit)
- **Completed:** 2026-08-24T00:21:05+05:00
- **Tasks:** 2
- **Files modified:** 4 (2 created, 2 modified)

## Accomplishments

- A real child process running `processWorkspacePurge()` is SIGKILLed at three deterministic, signal-driven (never sleep-timed) seams: mid-batch (after a real DELETE runs but before its transaction commits), between tables (before the next table's first batch is ever attempted), and before the tail (after every table is done but before the auth step and tombstone).
- Seven test cases, all real Postgres, all real SIGKILL: mid-batch resume, counts-match-control, counts-match-census, kill-between-tables, kill-before-the-tail, resume-does-not-re-walk, double-resume.
- No resumability defect was found — the checkpoint design from plans 22-01/22-05/22-07 held under a real kill at all three seams on the first attempt, so no production bug-fix was needed beyond the new test seam described below.
- Added `ProcessWorkspacePurgeDeps.afterTableWalk`, a no-op-by-default hook invoked once every table is confirmed empty and marked done but before the auth step and tombstone — the only way to land a deterministic kill at that otherwise-uncheckpointed boundary.
- Wired as `npm run failure:workspace-purge-resume` and appended to `failure:all`.

## Task Commits

1. **Task 1: Kill a purge mid-walk with a real SIGKILL and prove the next run finishes it** - `1ead74f` (test)
2. **Task 2: The other two seams — between tables, and after the last table but before the tail** - `504f72c` (test)

**Plan metadata:** (this commit)

## Files Created/Modified

- `apps/worker/src/queues/__tests__/failure-injection/workspace-purge-resume.test.ts` - Seven real-SIGKILL kill-resume cases covering all three seams
- `apps/worker/src/test/harness/workspace-purge-kill-entrypoint.ts` - The child-process harness: freezes `deletePurgeBatch` (mid_batch/between_tables modes) or `afterTableWalk` (before_tail mode), scoped to `WPK_TARGET_WORKSPACE_ID`, signalling over IPC before the parent kills
- `apps/worker/src/queues/workspace-purge.worker.ts` - Added `ProcessWorkspacePurgeDeps.afterTableWalk` and its call site between the table loop and the auth step
- `package.json` - New `failure:workspace-purge-resume` script, appended to `failure:all`

## Decisions Made

- Fixture shape shared by every scenario: three tables from `PURGE_TABLE_ORDER` chosen far apart in the walk order and free of FK setup beyond one contact (`subscription_status_history` → `contacts` → `workspace_property_registry`), each seeded to exactly `2 * PURGE_BATCH_SIZE` rows, so freeze points land deterministically without any sleep or fixed timer.
- The mid-batch seam's resume needs a short, bounded retry (`resumeWithLockReleaseTolerance`) tolerating `walkPurgeTable`'s own "still has rows after 3 retries" error for the brief real-world window between a killed backend's TCP socket closing and Postgres releasing its `FOR UPDATE SKIP LOCKED` row locks. This retries only the RESUME call, never the kill itself, which stays purely IPC-signal-driven.
- `afterTableWalk` was added to production code (`workspace-purge.worker.ts`) rather than working around its absence in the test, because the auth-step/tombstone tail has no other injectable seam — this is the only way to prove that specific boundary is resumable with a real kill rather than merely assumed to be.

## Deviations from Plan

None — plan executed exactly as written. No resumability defect was exposed by any of the three real kills, so `workspace-purge-checkpoint.ts` required no changes; the only production-code change was the new `afterTableWalk` test seam in `workspace-purge.worker.ts`, which the plan's own `files_modified` anticipated as a defensive inclusion.

## Issues Encountered

- The first draft of the "counts match the census" test failed because it didn't account for `recordAuthPurgeCounts`'s documented `member`/`invitation` merge into `table_counts` once the auth step runs — fixed by asserting the final counts equal the census plus that zero-count merge, not a byte-identical copy.
- `npm run test -w apps/worker` surfaced two pre-existing, unrelated failures (`erasure-enqueue-crash.test.ts`, `sentry.test.ts`) that reproduce in complete isolation with none of this plan's files loaded — already documented under Plan 22-04 in `deferred-items.md`; re-confirmed here and not fixed (out of scope per the deviation-rules scope boundary).
- `npm run failure:all`'s `&&`-chain halts at that same pre-existing `failure:erasure-enqueue-crash` failure before reaching `failure:workspace-purge-resume` at the end of the chain. Verified equivalently: the new script passes standalone (all seven cases), and every script after the pre-existing failure point in the chain also passes individually — confirming correct wiring and that the chain's only failure is the already-documented pre-existing one.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- PRG-03/SC3's real-SIGKILL proof is now in place alongside the other sixteen failure-injection scenarios; this closes the last must-have truth this phase's plan set assigned to plan 22-09.
- No blockers for 22-10 (the remaining Wave 4 plan) or for the phase's eventual `/gsd-secure-phase` retrospective — the STRIDE register's four threats (T-22-09-01 through 04) are all mitigated by this plan's own assertions.

---
*Phase: 22-workspace-quiesce-physical-purge*
*Completed: 2026-08-24*
