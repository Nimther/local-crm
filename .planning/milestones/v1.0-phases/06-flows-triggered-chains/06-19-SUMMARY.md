---
phase: 06-flows-triggered-chains
plan: 19
subsystem: flows
tags: [bullmq, postgres, segments, re-entry, gap-closure]

# Dependency graph
requires:
  - phase: 06-flows-triggered-chains
    provides: "flow-segment-sweep.worker.ts (06-08), canEnterFlow re-entry decision engine (06-06), flow_segment_membership_snapshot table (06-08)"
provides:
  - "sweepOneFlow now deletes a contact's segment-membership snapshot row when they no longer match the trigger segment (bounded anti-join DELETE), restoring leave->rejoin re-entry for segment-triggered flows"
affects: [flow-verification, flow-review, segment-triggered-flows]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Bounded anti-join DELETE (DELETE ... WHERE NOT EXISTS (SELECT 1 FROM contacts WHERE <compiled segment predicate> AND c.id = s.contact_id)) reusing the same compiled segment where-clause already used for the bulk match query -- no new query shape, no per-contact loop"

key-files:
  created: []
  modified:
    - apps/worker/src/queues/flows/flow-segment-sweep.worker.ts
    - apps/worker/src/queues/__tests__/flow-segment-trigger.test.ts

key-decisions:
  - "Stale-snapshot delete runs inside sweepOneFlow, positioned after the compiled segment predicate + statement_timeout are set but BEFORE the matchingContacts.length===0 early return -- so a segment that fully emptied still clears every stale row for that flow"
  - "Delete only clears rows for contacts NOT currently matching (anti-join) -- a still-matching contact keeps its snapshot row and is not re-enrolled (no regression to the existing already-seen behavior)"
  - "Re-entry authority stays entirely with canEnterFlow -- the delete only makes a leave-then-rejoin contact 'new' again from the snapshot's point of view; canEnterFlow's per-mode decision (every_time allows, once_ever denies on any prior run, once_per_n_days gated by window) is unchanged and untouched"

patterns-established:
  - "Segment snapshot semantics: 'seen' = 'currently inside this membership episode', not 'ever considered' -- any future segment-membership-snapshot consumer must respect that a snapshot row is deleted (not merely re-used) once the contact exits"

requirements-completed: [FLOW-04]

coverage:
  - id: D1
    description: "sweepOneFlow deletes a contact's flow_segment_membership_snapshot row when the sweep observes the contact no longer matches the trigger segment"
    requirement: FLOW-04
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/flow-segment-trigger.test.ts#06-19/WR-04/FLOW-04: a contact who leaves the trigger segment (sweep-detected) and rejoins re-enters when reentry_mode is every_time, and stays blocked for once_ever"
        status: pass
    human_judgment: false
  - id: D2
    description: "A leave->rejoin re-enters a segment-triggered flow when reentry_mode is every_time (a NEW flow_run is created), because canEnterFlow is reachable again after the stale snapshot is cleared"
    requirement: FLOW-04
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/flow-segment-trigger.test.ts#06-19/WR-04/FLOW-04: ... (every_time sub-scenario, step 7: 2 runs)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Re-entry stays correctly BLOCKED for reentry_mode once_ever even after a leave/rejoin -- canEnterFlow denies because a prior run exists, proving the fix does not bypass canEnterFlow's authority"
    requirement: FLOW-04
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/flow-segment-trigger.test.ts#06-19/WR-04/FLOW-04: ... (once_ever sub-scenario: still 1 run)"
        status: pass
    human_judgment: false
  - id: D4
    description: "A contact who never left the segment is not re-enrolled by the sweep -- the still-matching snapshot row is preserved (no regression)"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/flow-segment-trigger.test.ts#the sweep does NOT re-enroll a contact already recorded in the membership snapshot"
        status: pass
    human_judgment: false

duration: 8min
completed: 2026-07-10
status: complete
---

# Phase 06 Plan 19: Segment-Triggered Re-Entry Gap Closure Summary

**Bounded anti-join DELETE in the periodic segment sweep clears a contact's stale membership-snapshot row on segment exit, restoring every_time/once_per_n_days re-entry for segment-triggered flows while once_ever stays correctly blocked.**

## Performance

- **Duration:** 8 min
- **Started:** 2026-07-10T19:38:00Z
- **Completed:** 2026-07-10T19:39:25Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- Restored re-entry controls for segment-triggered flows: a contact who leaves the trigger segment and later rejoins now re-enters subject to `canEnterFlow`'s existing, correct per-mode decision (`every_time` re-enters, `once_ever` stays blocked)
- Added a live-run leave->rejoin regression test proving both the fix (every_time re-enters) and the safety boundary (once_ever isn't bypassed)
- Root cause fixed at the source: `flow_segment_membership_snapshot` rows were previously insert-only; the sweep now deletes a flow's snapshot row for any contact who no longer matches the segment, via one bounded `NOT EXISTS` anti-join reusing the already-compiled segment predicate (no per-contact loop, no new query shape)

## Task Commits

Each task was committed atomically:

1. **Task 1: Add a failing leave->rejoin re-entry regression test (RED)** - `f2bb087` (test)
2. **Task 2: Delete stale snapshot rows on segment exit in the sweep (GREEN)** - `6a8701d` (feat)

**Plan metadata:** (pending — see final commit below)

_TDD gate sequence confirmed: test commit (f2bb087) precedes feat commit (6a8701d) in git log._

## Files Created/Modified
- `apps/worker/src/queues/flows/flow-segment-sweep.worker.ts` - `sweepOneFlow` now runs a bounded anti-join DELETE against `flow_segment_membership_snapshot` before the empty-membership early return, clearing stale rows for contacts no longer in the trigger segment
- `apps/worker/src/queues/__tests__/flow-segment-trigger.test.ts` - new "06-19/WR-04/FLOW-04" live-run regression test (every_time re-enters after leave->rejoin; once_ever stays blocked)

## Decisions Made
- Delete positioned before the `matchingContacts.length === 0` early return, so a segment that fully emptied still clears every stale row for that flow (matches the plan's literal acceptance criterion)
- Delete parameters appended after the compiled segment predicate's own params (`[...params, workspaceId, flowId]`), reusing the identical `whereSql` string in both the DELETE's anti-join and the subsequent bulk SELECT — no drift risk between the two predicates
- No schema change, no migration, no new dependency — matches the plan's explicit "no architectural change" scope

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None. The RED test failed exactly at the predicted assertion (`getSnapshotSeen` staying `true` instead of clearing to `false`) on the first run, and the fix turned it GREEN along with the full 8-test `flow-segment-trigger.test.ts` suite (including the two most relevant regression guards: "does NOT re-enroll a contact already recorded in the membership snapshot" and "enrollExisting=false only seeds the snapshot").

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- FLOW-04's segment-triggered re-entry gap (fresh-review WR-04, roadmap success criterion 3) is closed; the previously-dead `every_time`/`once_per_n_days` re-entry controls for segment-triggered flows are now functional, matching what the UI already presents
- No new blockers introduced; `once_per_n_days` window-based re-entry for segment-triggered flows was not directly exercised by this plan's regression test (only `every_time`/`once_ever` per the plan's literal scope) but shares the identical `canEnterFlow` code path already covered by prior event-trigger tests, so no separate gap is expected

---
*Phase: 06-flows-triggered-chains*
*Completed: 2026-07-10*

## Self-Check: PASSED

- FOUND: apps/worker/src/queues/flows/flow-segment-sweep.worker.ts
- FOUND: apps/worker/src/queues/__tests__/flow-segment-trigger.test.ts
- FOUND: .planning/phases/06-flows-triggered-chains/06-19-SUMMARY.md
- FOUND commit: f2bb087
- FOUND commit: 6a8701d
