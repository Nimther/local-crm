---
phase: 06-flows-triggered-chains
plan: 12
subsystem: infra
tags: [bullmq, redis, flows-engine, vitest, gap-closure]

# Dependency graph
requires:
  - phase: 06-flows-triggered-chains
    provides: flow-run-advance.worker.ts's queue-as-doorbell engine (06-05), delay/quiet-hours nudges (06-07), segment/event trigger enrollment (06-06/06-08)
provides:
  - enqueueFlowRunAdvance(payload, opts?) -- the SOLE producer of FLOW_RUN_ADVANCE_QUEUE jobs, with a unique-per-wake jobId
  - flowRunAdvanceQueue's own job options (removeOnComplete:true, removeOnFail bounded to 24h) instead of the shared DEFAULT_JOB_OPTIONS
  - Forward advance nudges after send-node and branch-node non-terminal transitions (WR-08 closed)
  - A real Queue/Worker integration test proving multi-step (send-chain and 2+ delay) advancement
affects: [06-13, 06-14, 06-flows-triggered-chains phase verification]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "flowRunAdvanceQueue producers MUST call enqueueFlowRunAdvance, never Queue.add() directly -- enforced by doc comment + code review, not a lint rule"
    - "BullMQ integration tests that register a real Worker against a shared queue require vitest fileParallelism:false to avoid cross-file job-stealing races"

key-files:
  created:
    - apps/worker/src/queues/__tests__/flow-run-advance-integration.test.ts
  modified:
    - apps/worker/src/queues/flows/flow-queues.ts
    - apps/worker/src/queues/flows/flow-run-advance.worker.ts
    - apps/worker/src/queues/flows/handlers/delay-node.ts
    - apps/worker/src/queues/flows/handlers/send-node.ts
    - apps/worker/src/queues/flows/flow-reconciliation.worker.ts
    - apps/worker/src/queues/flows/flow-trigger-evaluator.worker.ts
    - apps/worker/src/queues/flows/flow-enroll-existing.worker.ts
    - apps/worker/src/queues/__tests__/flow-run-advance.test.ts
    - apps/worker/src/queues/__tests__/flow-trigger-evaluator.test.ts
    - apps/worker/src/queues/__tests__/flow-segment-trigger.test.ts
    - apps/worker/vitest.config.ts

key-decisions:
  - "enqueueFlowRunAdvance's jobId is `${flowRunId}-${Date.now()}` -- unique per wake, not deduped by design; safety comes from processFlowRunAdvance's queue-as-doorbell guards (status/next_wake_at re-check + FOR UPDATE SKIP LOCKED), not from jobId collision"
  - "flowRunAdvanceQueue gets its OWN job options (not the shared DEFAULT_JOB_OPTIONS) so removeOnComplete/removeOnFail can differ from emailTriggeredQueue/flowTriggerEvaluatorQueue without touching their send-idempotency contracts"
  - "vitest fileParallelism disabled in apps/worker -- required once a real Worker exists in the test suite against a globally shared BullMQ queue"

requirements-completed: [FLOW-02, FLOW-03]

coverage:
  - id: D1
    description: "flowRunAdvanceQueue never retains a completed/failed job under an id that can shadow a future wake for the same run (CR-01 closed)"
    requirement: "FLOW-03"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/flow-run-advance-integration.test.ts#Scenario B (2+ delay chain)"
        status: pass
      - kind: unit
        ref: "apps/worker/src/queues/flows/flow-queues.ts (removeOnComplete:true / removeOnFail bounded, grep-verified)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Every non-terminal send-node and branch-node transition enqueues a forward advance nudge (WR-08 closed)"
    requirement: "FLOW-02"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/flow-run-advance-integration.test.ts#Scenario A (automatic send chain)"
        status: pass
    human_judgment: false
  - id: D3
    description: "A real BullMQ Queue/Worker pair advances a multi-step flow run (2+ non-trigger steps) through every step to a terminal state"
    requirement: "FLOW-02"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/flow-run-advance-integration.test.ts"
        status: pass
    human_judgment: false

duration: 25min
completed: 2026-07-10
status: complete
---

# Phase 06 Plan 12: Flow advance-nudge delivery reliability (CR-01/WR-08) Summary

**Unique-per-wake BullMQ jobIds (`${flowRunId}-${Date.now()}`) plus send/branch forward nudges close the CR-01 job-shadowing bug and WR-08 gap, proven by a real Queue/Worker integration test driving a two-send and a 2+ delay chain to completion.**

## Performance

- **Duration:** ~25 min
- **Completed:** 2026-07-10
- **Tasks:** 3
- **Files modified:** 11 (1 new)

## Accomplishments
- `enqueueFlowRunAdvance` is now the sole producer of `FLOW_RUN_ADVANCE_QUEUE` jobs; its unique-per-wake jobId means an in-flight/completed/failed job for a run can never shadow a later wake for that same run (the exact CR-01 mechanism)
- `flowRunAdvanceQueue` has its own job options (`removeOnComplete: true`, `removeOnFail: { age: 86400 }`) instead of the shared 24h-retained/never-removed-on-fail defaults, bounding Redis growth while keeping failures observable
- Send-node and branch-node non-terminal transitions in `flow-run-advance.worker.ts` now enqueue a forward advance nudge (WR-08) instead of relying solely on the 60s reconciliation backstop
- All 6 advance producers (delay-node, send-node deferred path, reconciliation, trigger-evaluator x2, enroll-existing) routed through the one helper
- A real `createFlowRunAdvanceWorker` + `flowRunAdvanceQueue` pair now drives both a two-consecutive-send-node run and a two-consecutive-delay-node run through every step to `'completed'` in a new integration test, with a focused assertion that delay-1's and delay-2's wake nudges get distinct, coexisting jobIds

## Task Commits

Each task was committed atomically:

1. **Task 1: Unique-per-wake advance enqueue helper + no-shadow queue options + WR-08 forward nudges** - `ce27a16` (fix)
2. **Task 2: Route all 6 advance producers through the unique-jobId helper** - `a8567c3` (fix)
3. **Task 3: Real Queue/Worker multi-step integration test + fix stale getJob assertions** - `b158fd0` (test)

**Plan metadata:** (this commit)

## Files Created/Modified
- `apps/worker/src/queues/flows/flow-queues.ts` - `enqueueFlowRunAdvance` helper + `FLOW_RUN_ADVANCE_JOB_OPTIONS`
- `apps/worker/src/queues/flows/flow-run-advance.worker.ts` - forward nudge after send/branch non-terminal transitions
- `apps/worker/src/queues/flows/handlers/delay-node.ts` - routed through `enqueueFlowRunAdvance`
- `apps/worker/src/queues/flows/handlers/send-node.ts` - deferred quiet-hours branch routed through `enqueueFlowRunAdvance`
- `apps/worker/src/queues/flows/flow-reconciliation.worker.ts` - routed through `enqueueFlowRunAdvance`
- `apps/worker/src/queues/flows/flow-trigger-evaluator.worker.ts` - both enqueue sites routed through `enqueueFlowRunAdvance`
- `apps/worker/src/queues/flows/flow-enroll-existing.worker.ts` - routed through `enqueueFlowRunAdvance`
- `apps/worker/src/queues/__tests__/flow-run-advance-integration.test.ts` - new: real Queue/Worker multi-step test (send chain + 2+ delay chain)
- `apps/worker/src/queues/__tests__/flow-run-advance.test.ts` - two stale `getJob(flowRunId)` assertions replaced with a `data.flowRunId` lookup
- `apps/worker/src/queues/__tests__/flow-trigger-evaluator.test.ts` - same stale-assertion fix (Rule 1, caused by Task 2's jobId change)
- `apps/worker/src/queues/__tests__/flow-segment-trigger.test.ts` - same stale-assertion fix (Rule 1, caused by Task 2's jobId change)
- `apps/worker/vitest.config.ts` - `fileParallelism: false` (Rule 3, required once a real cross-test-shared-queue Worker exists in the suite)

## Decisions Made
- `enqueueFlowRunAdvance`'s jobId embeds both the flowRunId (greppability) and `Date.now()` (uniqueness); idempotency safety is provided entirely by `processFlowRunAdvance`'s existing status/next_wake_at/`FOR UPDATE SKIP LOCKED` guards, not by jobId dedup
- `flowRunAdvanceQueue` was given its own job-options object rather than modifying the shared `DEFAULT_JOB_OPTIONS`, so `emailTriggeredQueue`'s intentional deterministic send-idempotency jobId (`${flowRunId}-${nodeId}`) and retention stayed untouched
- `apps/worker/vitest.config.ts` now sets `fileParallelism: false`

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed stale `flowRunAdvanceQueue.getJob(flowRunId)`/`getJob(runs[0].id)` assertions in two test files not listed in the plan's `files_modified`**
- **Found during:** Task 3 (full worker vitest suite run after the integration test was added)
- **Issue:** `flow-trigger-evaluator.test.ts` and `flow-segment-trigger.test.ts` both asserted `flowRunAdvanceQueue.getJob(runs[0].id)` — a direct consequence of Task 2 changing those workers' enqueue calls from a deterministic `jobId: flowRunId`/`jobId: row.id` to `enqueueFlowRunAdvance`'s unique-per-wake id. The plan's `files_modified` only listed `flow-run-advance.test.ts` for this fix, missing these two.
- **Fix:** Replaced both with a `flowRunAdvanceQueue.getJobs([...]).find(j => j.data.flowRunId === ...)` lookup, mirroring the plan's own prescribed fix for `flow-run-advance.test.ts`.
- **Files modified:** `apps/worker/src/queues/__tests__/flow-trigger-evaluator.test.ts`, `apps/worker/src/queues/__tests__/flow-segment-trigger.test.ts`
- **Verification:** Full worker vitest suite passes (19/19 files).
- **Committed in:** `b158fd0` (Task 3 commit)

**2. [Rule 3 - Blocking] Disabled vitest `fileParallelism` in apps/worker**
- **Found during:** Task 3 (running the full worker vitest suite repeatedly surfaced intermittent failures in unrelated flow-engine test files)
- **Issue:** The new integration test registers a real `Worker` consuming `FLOW_RUN_ADVANCE_QUEUE` for the duration of its own file's `beforeAll`/`afterAll`. Under Vitest's default parallel file execution, that worker ran concurrently with sibling test files sharing the SAME real Redis instance, and greedily consumed advance jobs those files enqueued as side effects (e.g. `flow-trigger-evaluator.test.ts`'s one-active-run test, `flow-segment-trigger.test.ts`'s sweep-enrollment test) — silently advancing/completing their `flow_runs` rows before those tests' own assertions ran. Confirmed non-deterministic across repeated full-suite runs (2 different unrelated test failures across 3 runs) before the fix, then 4/4 clean runs after.
- **Fix:** Added `test.fileParallelism: false` to `apps/worker/vitest.config.ts` with an explanatory comment, so no other test file's tests execute while this file's real Worker is alive.
- **Files modified:** `apps/worker/vitest.config.ts`
- **Verification:** Full worker vitest suite run 4x consecutively, 19/19 files and 90/90 tests passing each time (previously flaky: 2 failures out of 3 runs).
- **Committed in:** `b158fd0` (Task 3 commit)

---

**Total deviations:** 2 auto-fixed (1 Rule 1 bug fix, 1 Rule 3 blocking-flakiness fix)
**Impact on plan:** Both fixes were necessary consequences of Task 2's intentional jobId change and Task 3's intentional real-Worker integration test — no scope creep, no unrelated changes.

## Issues Encountered
- The initial version of the "unique-jobId, no shadowing" focused assertion in Scenario B sampled job ids via a `waitFor`-loop `onTick` callback across all BullMQ job states, which non-deterministically captured the wrong (already-consumed, `removeOnComplete: true`) job as "delay-1's own delayed nudge." Replaced with a direct point-in-time query for `["delayed"]`-state jobs at the two checkpoints where the run's `current_node_id` had just advanced — deterministic and matches the plan's intent (a still-pending delayed job coexisting with a fresh, distinct wake).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- CR-01 and WR-08 are closed; roadmap success criterion 2 ("a contact moves through the flow — respecting delays and branch conditions — and leaves when an exit condition is met") is now provably achievable end to end via a real Queue/Worker test, not just direct-call unit tests.
- Remaining 06-VERIFICATION.md gaps (CR-02, CR-03) are tracked in the separate 06-13/06-14 gap-closure plans per the phase's gap-closure round.

---
*Phase: 06-flows-triggered-chains*
*Completed: 2026-07-10*

## Self-Check: PASSED
- FOUND: apps/worker/src/queues/flows/flow-queues.ts
- FOUND: apps/worker/src/queues/__tests__/flow-run-advance-integration.test.ts
- FOUND commit: ce27a16
- FOUND commit: a8567c3
- FOUND commit: b158fd0
