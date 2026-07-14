---
phase: 06-flows-triggered-chains
plan: 16
subsystem: api
tags: [postgres, fastify, react, flow-lifecycle, gap-closure]

requires:
  - phase: 06-flows-triggered-chains
    provides: flow lifecycle state machine (draft/live/paused), publishFlow/pauseFlow/resumeFlow (06-04), FlowDetailPage + PublishEnrollDialog paused-publish action (06-14)
provides:
  - publishFlow preserves "paused" status when publishing a paused flow's accumulated draft, instead of unconditionally flipping to "live"
  - Regression test pinning WR-04 (publish-on-paused safety)
  - Honest paused-case copy in PublishEnrollDialog
affects: [flow-lifecycle, flow-detail-page, flow-reconciliation]

tech-stack:
  added: []
  patterns:
    - "Status-preserving lifecycle transitions: compute the post-write status from the pre-write row (existing.status) rather than hard-coding the literal in the UPDATE, and pass it as a bound parameter"

key-files:
  created: []
  modified:
    - apps/api/src/modules/flows/flow.repository.ts
    - apps/web/src/features/flows/detail/PublishEnrollDialog.tsx
    - apps/api/src/modules/flows/__tests__/flow-lifecycle.test.ts

key-decisions:
  - "publishFlow's UPDATE now writes a computed nextStatus (existing.status === 'paused' ? 'paused' : 'live') via a bound $7 parameter instead of the literal 'live' -- 'Возобновить' (resumeFlow) remains the sole path back to live from paused (D-18/D-19)"

patterns-established:
  - "Status-preserving publish: any future lifecycle-mutating action reusing publishFlow's shape must re-derive next status from the pre-transaction row snapshot, not assume a fixed target status"

requirements-completed: [FLOW-06]

coverage:
  - id: D1
    description: "publishFlow keeps a paused flow paused when publishing accumulated draft changes (does not silently resume enrollment/sends)"
    requirement: "FLOW-06"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/flows/__tests__/flow-lifecycle.test.ts#06-16/WR-04/D-18: publishing accumulated draft changes on a paused flow keeps it paused (does not silently resume)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Publishing a DRAFT flow or a LIVE flow still results in status 'live' (no regression to existing publish paths)"
    requirement: "FLOW-06"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/flows/__tests__/flow-lifecycle.test.ts#publish rejects an incomplete definition server-side (422 + fields) and succeeds once valid (D-17)"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/flows/__tests__/flow-lifecycle.test.ts#CR-03: a live flow's unpublished draft trigger edit does not change trigger_* until re-published"
        status: pass
    human_judgment: false
  - id: D3
    description: "Publish dialog tells the marketer, when the flow is paused, that publishing keeps it paused until explicitly resumed"
    verification: []
    human_judgment: true
    rationale: "Dialog copy rendering/tone is a visual/UX check -- no automated UI test exists for PublishEnrollDialog in this codebase; verified by code inspection only (grep for the flow.status === 'paused' branch)."

duration: 12min
completed: 2026-07-10
status: complete
---

# Phase 06 Plan 16: Preserve paused status on publish (WR-04 gap closure) Summary

**publishFlow now computes its post-publish status from the pre-publish row instead of hard-coding "live", so publishing accumulated draft changes on a paused flow keeps it paused — closing the highest-priority safety warning (WR-04) from the gap-closure code review.**

## Performance

- **Duration:** 12 min
- **Started:** 2026-07-10T18:00:00Z (approx.)
- **Completed:** 2026-07-10T18:12:00Z (approx.)
- **Tasks:** 2 completed
- **Files modified:** 3

## Accomplishments

- Added a failing (RED) regression test proving that publishing a paused flow's accumulated draft flipped status back to "live" under the pre-fix code — confirmed failing at exactly the intended assertion (step 6, published status), not a setup/compile error.
- Fixed `publishFlow` to preserve `paused` status: the UPDATE's `status` column is now written from a locally computed `nextStatus = existing.status === "paused" ? "paused" : "live"` via a bound `$7` parameter, replacing the hard-coded `status = 'live'` literal. The draft/live publish paths are unchanged (still yield "live").
- Added honest Russian dialog copy to `PublishEnrollDialog`: when the flow is paused, the dialog now explicitly states that publishing will not resume sending and that "Возобновить" is the only way to resume.
- Full `flow-lifecycle.test.ts` suite (7 tests) is green, including the new regression case and all pre-existing D-17/D-20/D-23/CR-03/D-24 cases.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add a failing publish-on-paused regression test (RED)** - `5214183` (test)
2. **Task 2: Preserve paused status on publish + paused-aware dialog copy (GREEN)** - `82b1afd` (fix)

_TDD flow: RED (test) -> GREEN (fix) — no REFACTOR commit needed, the fix was a minimal, already-clean change._

## Files Created/Modified

- `apps/api/src/modules/flows/flow.repository.ts` - `publishFlow` writes a computed `nextStatus` (bound `$7` param) instead of the literal `'live'`, preserving `paused` when the flow was paused before publish
- `apps/web/src/features/flows/detail/PublishEnrollDialog.tsx` - added a paused-only Russian copy branch in the `DialogDescription`, additive to both the segment-triggered and event-triggered variants
- `apps/api/src/modules/flows/__tests__/flow-lifecycle.test.ts` - new regression test `"06-16/WR-04/D-18: publishing accumulated draft changes on a paused flow keeps it paused (does not silently resume)"`

## Decisions Made

- `publishFlow`'s UPDATE now writes a computed `nextStatus` (`existing.status === "paused" ? "paused" : "live"`) via a bound `$7` parameter instead of the literal `'live'` — `resumeFlow` ("Возобновить") remains the sole path back to live from paused (D-18/D-19).

## Deviations from Plan

None — plan executed exactly as written. Both tasks' acceptance criteria were met verbatim:
- The new test failed on the intended assertion under the pre-fix code (RED confirmed via `npx vitest run ... -t "06-16"`), then passed after the fix (GREEN).
- `grep -n "status = 'live'" apps/api/src/modules/flows/flow.repository.ts` now shows the literal only inside `resumeFlow`, not `publishFlow`.
- The dialog's paused branch is gated on `flow.status === "paused"` and is additive to the existing draft/live/segment/event copy branches.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

WR-04 is closed. The paused-publish safety gap identified in 06-REVIEW.md/06-VERIFICATION.md is fully repaired: publishing accumulated draft changes on a paused flow now keeps it paused, matching D-18 (pause = full freeze) and D-19 (resume is the explicit path). No further gap-closure work is outstanding from this specific warning. Remaining open items from prior 06-REVIEW rounds (if any) should be tracked via the phase's ongoing gap-closure sequence, not this plan.

---
*Phase: 06-flows-triggered-chains*
*Completed: 2026-07-10*

## Self-Check: PASSED

- FOUND: apps/api/src/modules/flows/flow.repository.ts
- FOUND: apps/web/src/features/flows/detail/PublishEnrollDialog.tsx
- FOUND: apps/api/src/modules/flows/__tests__/flow-lifecycle.test.ts
- FOUND: .planning/phases/06-flows-triggered-chains/06-16-SUMMARY.md
- FOUND commit: 5214183 (test)
- FOUND commit: 82b1afd (fix)
