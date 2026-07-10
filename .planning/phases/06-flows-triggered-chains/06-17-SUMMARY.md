---
phase: 06-flows-triggered-chains
plan: 17
subsystem: flows
tags: [validation, dfs, cycle-detection, bullmq, worker, zod, flows-core]

# Dependency graph
requires:
  - phase: 06-flows-triggered-chains
    provides: validateFlowDefinition (06-02), processFlowRunAdvance (06-05/06-12), publishFlow server-side re-validation (06-04)
provides:
  - cycle_detected + no_entry publish-time hard errors in @mega-crm/flows-core's validateFlowDefinition
  - MAX_STEPS_PER_RUN (1000) exported step-budget guard in flow-run-advance.worker.ts
  - Russian copy for both new error codes (API 422 response + canvas publish-blocker panel)
affects: [flows-canvas, flow-publish, flow-run-advance-worker]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Recursion-stack DFS cycle detection scoped to nodes reachable from a single entry point (mirrors existing BFS-reachability + branch-exit-walk scoping)"
    - "Defense-in-depth: publish-time rejection (validator) + worker-side bounded backstop (step budget) for the same correctness guarantee"

key-files:
  created: []
  modified:
    - packages/flows-core/src/flow-validate.ts
    - packages/flows-core/src/__tests__/flow-validate.test.ts
    - apps/api/src/modules/flows/flow-validation.ts
    - apps/web/src/features/flows/canvas/NodeConfigPanel.tsx
    - apps/worker/src/queues/flows/flow-run-advance.worker.ts
    - apps/worker/src/queues/__tests__/flow-run-advance.test.ts

key-decisions:
  - "cycle_detected optionally carries the offending nodeId (findCycleReachableFrom returns the back-edge target); the regression test asserts only on `code` via expect.objectContaining to avoid over-constraining that detail, per the plan's explicit instruction"
  - "no_entry and cycle_detected are both computed inside the existing `triggerNodes.length === 1` block, scoped via the trigger's own edgesBySource / DFS from the trigger id -- preserves the D-17 'no v2 linting' contract (unreachable/orphan cycles and dead nodes never block publish)"
  - "Step-budget guard placed immediately after the `!run.currentNodeId` guard and before loadPinnedDefinition, per the plan's specified guard ordering -- a run at or over MAX_STEPS_PER_RUN is force-exited before any DB read of the pinned definition or node dispatch"

patterns-established:
  - "Worker-side resource-bound backstops (step/iteration budgets) live alongside the existing status/next_wake_at/paused/currentNodeId guard sequence at the top of processFlowRunAdvance, checked via a bounded COUNT(*) query before any node-type dispatch"

requirements-completed: [FLOW-01, FLOW-03]

coverage:
  - id: D1
    description: "A graph cycle reachable from the trigger (trigger->send-A->send-B->send-A) is rejected at publish via a new cycle_detected validation error"
    requirement: "FLOW-03"
    verification:
      - kind: unit
        ref: "packages/flows-core/src/__tests__/flow-validate.test.ts#06-17/CR-01: a cycle reachable from the trigger returns cycle_detected"
        status: pass
    human_judgment: false
  - id: D2
    description: "A trigger with no outgoing edge is rejected at publish via a new no_entry validation error"
    requirement: "FLOW-01"
    verification:
      - kind: unit
        ref: "packages/flows-core/src/__tests__/flow-validate.test.ts#06-17/WR-02: a trigger with no outgoing edge returns no_entry"
        status: pass
    human_judgment: false
  - id: D3
    description: "A run whose flow_run_steps count has already reached MAX_STEPS_PER_RUN is force-exited (status exited, exit_reason step_budget_exceeded) before any further node dispatch, with no new step appended and no send enqueued"
    requirement: "FLOW-03"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/flow-run-advance.test.ts#06-17/CR-01: a run at the step budget is terminated (exited/step_budget_exceeded) with no further dispatch"
        status: pass
    human_judgment: false
  - id: D4
    description: "The three pre-existing hard-error checks (no_trigger, empty_send, branch_missing_exit) and the orphan/dead-node-is-valid contract (D-17) are unchanged"
    verification:
      - kind: unit
        ref: "packages/flows-core/src/__tests__/flow-validate.test.ts (full suite, 10/10 passing)"
        status: pass
    human_judgment: false

duration: 15min
completed: 2026-07-10
status: complete
---

# Phase 06 Plan 17: Cycle + no-entry publish rejection and worker step-budget backstop Summary

**cycle_detected + no_entry publish-time hard errors (DFS/recursion-stack + trigger-outgoing-edge check) in flows-core's validateFlowDefinition, plus a MAX_STEPS_PER_RUN=1000 worker-side step-budget guard that force-exits any run that evades the fix**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-07-10T19:24:00+05:00
- **Completed:** 2026-07-10T19:27:24+05:00
- **Tasks:** 2 (RED then GREEN)
- **Files modified:** 6

## Accomplishments

- `validateFlowDefinition` now rejects a graph cycle reachable from the trigger (`cycle_detected`, DFS with a recursion stack) and a trigger with no outgoing edge (`no_entry`), both scoped to nodes reachable from the trigger so D-17's "no v2 linting" orphan/dead-node contract is unchanged.
- `publishFlow`'s server-side re-validation (never trusting a client `isValid` flag) now surfaces both new codes as a 422 with Russian copy, in both the API's `copyForCode` and the canvas's exhaustive `PUBLISH_BLOCKER_MESSAGES` record.
- `processFlowRunAdvance` gained a defense-in-depth backstop: a bounded `SELECT count(*) FROM flow_run_steps` check before any node dispatch force-exits a run (`status: 'exited'`, `exit_reason: 'step_budget_exceeded'`) once it reaches `MAX_STEPS_PER_RUN` (1000), appending no further step and enqueueing no send/advance.
- Three new regression tests pin CR-01/WR-02: two `flow-validate.test.ts` unit tests and one live-Postgres/Redis `flow-run-advance.test.ts` integration test, all written RED-first (confirmed failing against pre-fix code) then GREEN after the fix.

## Task Commits

1. **Task 1: Add failing cycle/no_entry validation tests + step-budget regression test (RED)** - `8985fc3` (test)
2. **Task 2: Add cycle + no_entry validation and a per-run step budget (GREEN)** - `32b0497` (feat)

**Plan metadata:** (this commit, docs)

## Files Created/Modified

- `packages/flows-core/src/flow-validate.ts` - `FlowValidationErrorCode` extended with `cycle_detected`/`no_entry`; new `findCycleReachableFrom` DFS helper; both checks added inside the existing `triggerNodes.length === 1` block
- `packages/flows-core/src/__tests__/flow-validate.test.ts` - two new `it("06-17/...")` cases (cycle, no_entry)
- `apps/api/src/modules/flows/flow-validation.ts` - `copyForCode` cases for both new codes
- `apps/web/src/features/flows/canvas/NodeConfigPanel.tsx` - `PUBLISH_BLOCKER_MESSAGES` entries for both new codes (required for the exhaustive `Record` to compile)
- `apps/worker/src/queues/flows/flow-run-advance.worker.ts` - exported `MAX_STEPS_PER_RUN = 1000`; new `countFlowRunSteps` helper; step-budget guard placed after the `!run.currentNodeId` guard and before `loadPinnedDefinition`
- `apps/worker/src/queues/__tests__/flow-run-advance.test.ts` - one new `it("06-17/CR-01: ...")` step-budget regression case

## Decisions Made

- `cycle_detected` optionally carries the offending node id from the DFS back-edge; the test asserts only `code` via `expect.objectContaining` to avoid over-constraining `nodeId`, per the plan's explicit guidance.
- Both new checks reuse the existing `triggerNodes.length === 1` gating and are scoped to reachability/DFS from the trigger node id specifically -- an unreachable/orphan cycle or a dead node elsewhere in the graph still does not block publish (D-17 preserved, confirmed by the unchanged "orphan/dead branch is valid" test staying green).
- The step-budget guard's placement (after `currentNodeId` check, before `loadPinnedDefinition`) means a budget-exceeded run never reads the pinned flow_version definition at all -- the cheapest possible early exit.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None. All automated verification (flow-validate.test.ts 10/10, flow-run-advance.test.ts 9/9, `tsc --noEmit` clean in flows-core/api/worker/web) passed on first GREEN run.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- CR-01 and WR-02 (06-VERIFICATION.md blocking gaps) are closed: a cyclic definition can no longer be published, and any run that somehow ends up cyclic is structurally bounded to at most `MAX_STEPS_PER_RUN` dispatches before being force-exited.
- No schema change, no new dependency -- `flow_runs.status = 'exited'` and free-text `exit_reason` already existed.
- No blockers for downstream gap-closure plans in this round.

---
*Phase: 06-flows-triggered-chains*
*Completed: 2026-07-10*
