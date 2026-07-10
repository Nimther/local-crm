---
phase: 06-flows-triggered-chains
plan: 20
subsystem: database
tags: [postgres, savepoint, transactions, segments, error-handling]

# Dependency graph
requires:
  - phase: 06-flows-triggered-chains
    provides: "D-24's flow-vs-campaign delete-conflict disambiguation (deleteSegment's findReferencingFlowName re-check)"
provides:
  - "SAVEPOINT-wrapped deleteSegment DELETE so a 23503 FK violation can be recovered from within the same transaction"
  - "Regression test proving a canceled-campaign-referenced segment delete throws SegmentConflictError, not a raw 25P02"
affects: [segments, campaigns, flows]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "SAVEPOINT / ROLLBACK TO SAVEPOINT around a DELETE whose catch block needs to run further queries on the same transaction after a Postgres FK-violation aborts it"

key-files:
  created:
    - apps/api/src/modules/segments/__tests__/segment-delete-conflict.test.ts
  modified:
    - apps/api/src/modules/segments/segment.repository.ts

key-decisions:
  - "SAVEPOINT seg_delete taken immediately before the DELETE; ROLLBACK TO SAVEPOINT is the first statement in the 23503 catch, restoring a live transaction before findReferencingFlowName re-runs"
  - "No new migration, no schema change, no new dependency -- pure transaction-recovery fix scoped to deleteSegment's existing catch block"

patterns-established:
  - "Repository-level regression tests (direct tenant-scoped INSERTs + the real repository function, no HTTP layer) are the right granularity for pinning a transaction-internal bug like an aborted-tx recovery path"

requirements-completed: [FLOW-02]

coverage:
  - id: D1
    description: "deleteSegment throws SegmentConflictError (code referenced_by_campaign), not a raw postgres 25P02, when a segment is referenced only by a CANCELED campaign"
    requirement: "FLOW-02"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/segments/__tests__/segment-delete-conflict.test.ts#06-20/WR-01: deleting a segment referenced by a canceled campaign throws SegmentConflictError (referenced_by_campaign), not a raw 25P02"
        status: pass
    human_judgment: false
  - id: D2
    description: "D-24's flow-vs-campaign disambiguation and the non-canceled-campaign/referencing-flow pre-check paths remain unchanged after the SAVEPOINT fix"
    requirement: "FLOW-02"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/flows/__tests__/flow-lifecycle.test.ts#D-24: a segment referenced by a flow trigger cannot be deleted"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/segments/__tests__/segments-hardening.test.ts"
        status: pass
    human_judgment: false

duration: 12min
completed: 2026-07-10
status: complete
---

# Phase 06 Plan 20: Segment-delete SAVEPOINT recovery Summary

**SAVEPOINT/ROLLBACK TO SAVEPOINT around deleteSegment's DELETE so the D-24 flow re-check runs on a live transaction, restoring the 409 SegmentConflictError instead of a raw postgres 500 for canceled-campaign FK conflicts (WR-01)**

## Performance

- **Duration:** 12 min
- **Started:** 2026-07-10T14:32:00Z
- **Completed:** 2026-07-10T14:44:28Z
- **Tasks:** 2 completed
- **Files modified:** 2

## Accomplishments
- Regression test (RED) pinned WR-01: `deleteSegment` was rejecting with a raw postgres `25P02` (current transaction is aborted) instead of `SegmentConflictError` when the DELETE tripped a canceled-campaign FK
- Fix (GREEN): `deleteSegment` now takes `SAVEPOINT seg_delete` before the DELETE and issues `ROLLBACK TO SAVEPOINT seg_delete` as the first action in the `23503` catch, restoring a live transaction before `findReferencingFlowName` re-runs
- Confirmed no regression to the happy path, the pre-check conflict paths (non-canceled campaign, referencing flow), or D-24's flow-vs-campaign disambiguation

## Task Commits

Each task was committed atomically:

1. **Task 1: Add a failing canceled-campaign delete-conflict regression test (RED)** - `601e145` (test)
2. **Task 2: Wrap the DELETE in a SAVEPOINT so the catch queries a live transaction (GREEN)** - `b1242bb` (fix)

**Plan metadata:** (this commit)

## Files Created/Modified
- `apps/api/src/modules/segments/__tests__/segment-delete-conflict.test.ts` - Repository-level regression test: canceled-campaign-referenced segment delete throws `SegmentConflictError`, not a raw `25P02`
- `apps/api/src/modules/segments/segment.repository.ts` - `deleteSegment`'s DELETE wrapped in `SAVEPOINT`/`ROLLBACK TO SAVEPOINT` so the 23503 catch's flow re-check runs on a live transaction

## Decisions Made
- `SAVEPOINT seg_delete` placed immediately before the DELETE statement (not around the whole function) -- keeps the fix minimally scoped to the exact statement that can trip the FK, matching the plan's literal instruction.
- `ROLLBACK TO SAVEPOINT` is unconditionally the first statement inside the `err.code === "23503"` branch, before `findReferencingFlowName` re-runs -- any non-23503 error still re-throws untouched (no savepoint interaction needed since the transaction is only rolled back via savepoint on the specific error we can recover from).

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

WR-01 closed. `deleteSegment` now returns an actionable 409 (`SegmentConflictError`, code `referenced_by_campaign`) when a segment is referenced only by a canceled campaign, matching the D-14/D-24 delete-when-referenced contract. No known blockers for phase 06 continuation from this plan.

---
*Phase: 06-flows-triggered-chains*
*Completed: 2026-07-10*

## Self-Check: PASSED

- FOUND: apps/api/src/modules/segments/__tests__/segment-delete-conflict.test.ts
- FOUND: apps/api/src/modules/segments/segment.repository.ts
- FOUND: 601e145 (test commit)
- FOUND: b1242bb (fix commit)
