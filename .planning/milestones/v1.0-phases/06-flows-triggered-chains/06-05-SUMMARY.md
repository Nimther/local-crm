---
phase: 06-flows-triggered-chains
plan: 05
subsystem: worker
tags: [bullmq, postgres, state-machine, flows, reconciliation, exit-conditions]

# Dependency graph
requires:
  - phase: 06-flows-triggered-chains (06-01)
    provides: flow_runs/flow_run_steps tables, flow_runs_due_scan admin-scan RLS policy (0027)
  - phase: 06-flows-triggered-chains (06-02)
    provides: FLOW_RUN_ADVANCE_QUEUE/FLOW_RECONCILIATION_QUEUE constants, flowRunAdvanceJobSchema
  - phase: 06-flows-triggered-chains (06-03)
    provides: claimFlowSend/recordFlowStepResult (delivery-core) + processSendJob's kind:'flow' branch -- the send-node handler's downstream consumer
  - phase: 06-flows-triggered-chains (06-04)
    provides: flows.exit_conditions column, flow_versions immutable definition storage
provides:
  - "processFlowRunAdvance (apps/worker/src/queues/flows/flow-run-advance.worker.ts) -- the state-machine step executor: re-reads flow_runs FOR UPDATE OF fr SKIP LOCKED every wake, evaluates exit conditions before node dispatch (D-14), dispatches send/exit node handlers, advances current_node_id atomically"
  - "createFlowReconciliationWorker (flow-reconciliation.worker.ts) -- 60s repeatable due-run backstop scan, both workers registered in apps/worker/src/server.ts"
  - "evaluateExitConditions (flow-exit-conditions.ts) -- D-15 segment-membership + event-since-entry exit evaluation"
  - "handleSendNode/handleExitNode (handlers/) -- node-type dispatch primitives, reusable by 06-07/06-08's delay/branch handlers"
  - "flow-queues.ts -- shared singleton producer Queues (EMAIL_TRIGGERED_QUEUE, FLOW_RUN_ADVANCE_QUEUE)"
affects: [06-06, 06-07, 06-08, 06-09]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Queue-as-doorbell: the BullMQ job payload is never trusted as the source of truth -- processFlowRunAdvance always re-reads flow_runs FOR UPDATE OF fr SKIP LOCKED and re-derives what to do from the CURRENT row, making a stale/duplicate/redelivered nudge a structural no-op rather than something each caller must remember to guard against"
    - "Exit-condition evaluation happens BEFORE any node-handler dispatch in the same transaction -- D-14's 'exit before send' guarantee is structural (a satisfied condition returns before the send/exit dispatch branch is ever reached), not a runtime ordering convention that could drift"
    - "apps/worker cannot import apps/api's isContactInSegment (no cross-app dependency path, 02-06 precedent) -- flow-exit-conditions.ts instead calls @mega-crm/segments-core's compileSegmentDefinition directly, the same shared SQL-generation primitive isContactInSegment itself wraps"
    - "Singleton producer Queue modules (flow-queues.ts) shared by multiple call sites within the SAME process (handleSendNode's send enqueue, flow-reconciliation's advance nudge) -- mirrors campaign-broadcast-producer.ts's one-Queue-instance-per-queue-name-per-process convention, not campaign-scheduler.worker.ts's per-function-local Queue construction"

key-files:
  created:
    - apps/worker/src/queues/flows/flow-run-advance.worker.ts
    - apps/worker/src/queues/flows/flow-reconciliation.worker.ts
    - apps/worker/src/queues/flows/flow-exit-conditions.ts
    - apps/worker/src/queues/flows/flow-queues.ts
    - apps/worker/src/queues/flows/handlers/send-node.ts
    - apps/worker/src/queues/flows/handlers/exit-node.ts
    - apps/worker/src/queues/__tests__/flow-run-advance.test.ts
  modified:
    - apps/worker/src/server.ts

key-decisions:
  - "No self-nudge after a non-terminal, non-delay transition (send -> next node) -- a run that lands on next_wake_at=now() with no further delay simply waits for the next 60s reconciliation tick to continue, rather than the advance worker re-enqueuing itself immediately. This matches the plan's literal per-call contract (one processFlowRunAdvance call = one node dispatch + one advance) and avoids a same-jobId BullMQ self-referential re-add race (a job re-adding itself while still 'active' under its own jobId is untested, fragile territory); 06-07's delay nodes are explicitly the low-latency continuation path per the plan's own doc-comment guidance, this plan's send->exit chain is fully served by the reconciliation backstop within its 60s cadence."
  - "handleSendNode returns nextNodeId only (no flow_runs write); handleExitNode performs its own flow_runs UPDATE via the shared transaction client -- an intentional asymmetry matching the plan's literal per-handler responsibilities (send 'returns the next node id', exit 'marks the run status completed'), with flow-run-advance.worker.ts uniformly appending the flow_run_steps row for both paths"
  - "FOR UPDATE OF fr (not a bare FOR UPDATE on the flow_runs/flows join) locks only the flow_runs row being advanced, leaving the joined flows row unlocked -- avoids contending with concurrent flow-status reads/writes (e.g. a marketer pausing the flow from the canvas UI) for no benefit, since only flow_runs is ever mutated by this worker"
  - "Local seedFlowRun test fixture (trigger->send->exit graph) added directly in flow-run-advance.test.ts rather than extending db-fixture.ts's shared createFixtureFlowRun -- that shared fixture is intentionally a bare send-node-with-no-outgoing-edge shape for 06-03's dispatch-only tests; this plan needs a real next-node to advance INTO plus configurable exit_conditions/entered_at, distinct enough to justify a local fixture (mirrors flow-send-idempotency.test.ts's own locally-defined createFixtureContact precedent)"

patterns-established:
  - "flow_run_steps.outcome values introduced this plan: 'enqueued' (send node dispatched, terminal send/fail outcome recorded later and asynchronously by send-dispatch.ts, not here), 'completed' (exit node reached), 'exit_condition_satisfied' (flow-level exit condition short-circuited the step) -- 06-07/06-08's delay/branch handlers should follow this same outcome-per-node-type vocabulary"

requirements-completed: [FLOW-03, FLOW-07, FLOW-01, FLOW-06]

coverage:
  - id: D1
    description: "A waiting flow_run whose next_wake_at has elapsed is advanced by re-reading the run's current DB state and resolving the next node against the run's PINNED flow_version_id (FLOW-07), never flows.live_version_id"
    requirement: "FLOW-07"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/flow-run-advance.test.ts#a due send node enqueues exactly one kind:'flow' send job and advances current_node_id to the exit node"
        status: pass
      - kind: other
        ref: "grep confirms flow_version_id (never live_version_id) drives node resolution in flow-run-advance.worker.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Exit conditions are evaluated at step boundaries BEFORE any send -- a satisfied condition marks the run exited and no send job is ever enqueued (D-14)"
    requirement: "FLOW-03"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/flow-run-advance.test.ts#D-14: an exit condition satisfied at the boundary exits the run and enqueues NO send job"
        status: pass
    human_judgment: false
  - id: D3
    description: "A send node enqueues a kind:'flow' job onto the existing email-triggered queue and advances the run in the same wake cycle; an exit node marks the path terminal"
    requirement: "FLOW-01"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/flow-run-advance.test.ts#a due send node enqueues exactly one kind:'flow' send job and advances current_node_id to the exit node"
        status: pass
      - kind: other
        ref: "handlers/exit-node.ts's handleExitNode UPDATEs flow_runs status='completed'/exit_reason='reached_exit'"
        status: pass
    human_judgment: false
  - id: D4
    description: "A durable reconciliation scan (repeatable tick, admin-scoped discovery + tenant-rescoped FOR UPDATE SKIP LOCKED) catches any waiting run whose BullMQ wake nudge was lost"
    requirement: "FLOW-06"
    verification:
      - kind: other
        ref: "grep confirms createFlowReconciliationWorker/createFlowRunAdvanceWorker both registered in apps/worker/src/server.ts; findDueFlowRunCandidates is SELECT-only under app.admin_scan (no FOR UPDATE); transitionAndNudge re-verifies FOR UPDATE OF fr SKIP LOCKED joined to flows.status<>'paused'"
        status: pass
    human_judgment: false
  - id: D5
    description: "Pause freezes execution: the advance worker no-ops for a run whose flow is paused, and the reconciliation scan's per-tenant re-verification excludes paused flows; on resume, overdue runs execute on the very next tick (D-18/D-19)"
    requirement: "FLOW-06"
    verification:
      - kind: other
        ref: "processFlowRunAdvance's guard `if (run.flowStatus === \"paused\") return;` leaves the run untouched (still waiting, unchanged next_wake_at); flow-reconciliation.worker.ts's transitionAndNudge re-verifies f.status<>'paused' in the SAME query on every tick, requiring no separate resume code path"
        status: pass
    human_judgment: false

duration: 20min
completed: 2026-07-10
status: complete
---

# Phase 6 Plan 5: Flow execution engine core (advance + reconciliation) Summary

**The durable state-machine step executor for triggered chains: every wake re-reads flow_runs under FOR UPDATE OF fr SKIP LOCKED (queue-as-doorbell), evaluates D-15 exit conditions before any send (D-14), dispatches send/exit node handlers against the run's PINNED flow_version (FLOW-07), and a 60s reconciliation scan catches any lost wake nudge -- completing the first user-observable event -> run -> email slice.**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-07-10T04:24:00Z
- **Completed:** 2026-07-10T04:44:00Z
- **Tasks:** 3
- **Files modified:** 8 (7 created, 1 modified)

## Accomplishments
- `flow-exit-conditions.ts`: `evaluateExitConditions` (D-15) -- segment-membership half calls `@mega-crm/segments-core`'s `compileSegmentDefinition` directly (apps/worker has no dependency path to apps/api's `isContactInSegment`, mirroring the 02-06 shared-package precedent), event half is a plain `events.occurred_at > enteredAt` check. Returns `true` on the FIRST satisfied condition (OR semantics across the array).
- `handlers/send-node.ts` / `handlers/exit-node.ts`: `handleSendNode` enqueues a `kind:'flow'` job onto `EMAIL_TRIGGERED_QUEUE` with a deterministic `jobId` (`${flowRunId}-${nodeId}`) and returns the next node id from the pinned definition's outgoing edge (`resolveNextNodeId`, reusable by 06-08's branch handler later); `handleExitNode` marks the run `'completed'`/`exitReason: 'reached_exit'` directly via the caller's open transaction client.
- `flow-run-advance.worker.ts`: `processFlowRunAdvance` -- re-reads the `flow_runs` row joined to its parent flow's `status`/`exit_conditions` `FOR UPDATE OF fr SKIP LOCKED`; no-ops on a stale/terminal run, a not-yet-due `next_wake_at`, a `paused` parent flow, or a null `current_node_id`; loads the PINNED definition via `flow_version_id` (never `flows.live_version_id`); evaluates exit conditions BEFORE any node dispatch (D-14); dispatches to `send`/`exit` handlers and advances `current_node_id`/`status` + appends a `flow_run_steps` row, all in the SAME transaction. `createFlowRunAdvanceWorker` registers the BullMQ consumer.
- `flow-reconciliation.worker.ts`: `findDueFlowRunCandidates` (admin-scoped SELECT-only scan under `app.admin_scan`, mirrors `campaign-scheduler.worker.ts` exactly) + `transitionAndNudge` (per-tenant `FOR UPDATE OF fr SKIP LOCKED` re-verify joined to `flows.status<>'paused'`, D-18/D-19) + a 60s repeatable tick (fixed `jobId: "scan-due-flow-runs"`). `createFlowReconciliationWorker` and `createFlowRunAdvanceWorker` both registered in `apps/worker/src/server.ts`'s `buildWorker()`.
- `flow-queues.ts`: singleton producer `Queue` instances for `EMAIL_TRIGGERED_QUEUE` and `FLOW_RUN_ADVANCE_QUEUE` (mirrors `campaign-broadcast-producer.ts`'s one-instance-per-process convention), shared by `handleSendNode`'s send enqueue and `flow-reconciliation`'s due-run nudge.
- New `flow-run-advance.test.ts` (3 real-Postgres/Redis integration tests): a due send node enqueues exactly one send job (asserted via `emailTriggeredQueue.getJob`, no stubbed dependency) and advances `current_node_id` to the exit node; an event-since-entry exit condition satisfied at the boundary exits the run with zero send jobs enqueued (D-14); a stale advance for an already-`'completed'` run is a pure no-op (no extra steps, no send). Full `apps/worker` suite: 74/74 passing, no regressions.

## Task Commits

Each task was committed atomically:

1. **Task 1: flow-run-advance dispatcher + send/exit handlers + exit-condition evaluator** - `53335d5` (feat)
2. **Task 2: flow-reconciliation worker + register both flow workers** - `65b780a` (feat)
3. **Task 3: Integration test for step-boundary semantics** - `f279674` (test)

**Plan metadata:** pending (docs: complete plan)

## Files Created/Modified
- `apps/worker/src/queues/flows/flow-exit-conditions.ts` - evaluateExitConditions (D-15 segment + event)
- `apps/worker/src/queues/flows/flow-queues.ts` - emailTriggeredQueue/flowRunAdvanceQueue producer singletons
- `apps/worker/src/queues/flows/flow-run-advance.worker.ts` - processFlowRunAdvance, createFlowRunAdvanceWorker
- `apps/worker/src/queues/flows/flow-reconciliation.worker.ts` - findDueFlowRunCandidates, transitionAndNudge, createFlowReconciliationWorker
- `apps/worker/src/queues/flows/handlers/send-node.ts` - handleSendNode, resolveNextNodeId
- `apps/worker/src/queues/flows/handlers/exit-node.ts` - handleExitNode
- `apps/worker/src/queues/__tests__/flow-run-advance.test.ts` - 3 integration tests (new file)
- `apps/worker/src/server.ts` - registers createFlowRunAdvanceWorker + createFlowReconciliationWorker

## Decisions Made
- No self-nudge after a non-terminal send->next-node transition -- the run rests at `next_wake_at=now()` until the next 60s reconciliation tick picks it up, matching the plan's literal one-call-one-node-dispatch contract and avoiding an untested same-jobId BullMQ self-re-add race. 06-07's delay nodes are the documented low-latency continuation path; this plan's send->exit chain completes within the reconciliation backstop's 60s cadence.
- `handleSendNode` returns `nextNodeId` only (no DB write); `handleExitNode` performs its own `flow_runs` UPDATE via the shared transaction client -- matches the plan's literal, asymmetric per-handler responsibilities; the caller appends `flow_run_steps` uniformly for both.
- `FOR UPDATE OF fr` (not a bare join-wide `FOR UPDATE`) locks only the `flow_runs` row being advanced, never contending with concurrent reads/writes of the joined `flows` row.
- Local `seedFlowRun` test fixture (full trigger->send->exit graph, configurable `exit_conditions`/`status`/`entered_at`) added directly in the new test file rather than extending `db-fixture.ts`'s shared `createFixtureFlowRun`, which is intentionally a bare send-node shape for 06-03's dispatch-only tests.

## Deviations from Plan

None - plan executed exactly as written. The single design decision beyond the plan's literal text (no self-nudge after a non-delay transition) was resolved in favor of the plan's own literal per-call contract and documented above, not treated as a deviation from any explicit requirement.

## Issues Encountered
None. Postgres and Redis were already running locally; `npm run build`/`npm run test` for `apps/worker` (and a cross-check build of `packages/db`, `packages/flows-core`, `packages/shared-schemas`, `packages/delivery-core`, `packages/segments-core`, `apps/api`) all passed clean on the first attempt.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- `processFlowRunAdvance`'s node-type dispatch (`if (node.type === "send") ... if (node.type === "exit") ... throw` for anything else) is the exact seam 06-07 (delay nodes) and 06-08 (branch nodes) extend -- add a new `else if (node.type === "delay")` / `"branch"` branch calling a new handler, following `handleSendNode`/`handleExitNode`'s established contract shape (return `{ nextNodeId }` for a non-terminal advance, or perform the terminal `flow_runs` UPDATE directly for a terminal outcome).
- `flow_run_steps.outcome` vocabulary established this plan (`'enqueued'`, `'completed'`, `'exit_condition_satisfied'`) should be extended, not replaced, by 06-07/06-08's new node types (e.g. a delay node's outcome might be `'waiting'`, a branch node's `'branched_yes'`/`'branched_no'`).
- `evaluateExitConditions` and `resolveNextNodeId` are both already reusable, standalone exports -- 06-07/06-08 need no changes to either.
- 06-06 (trigger evaluator) is the piece that actually CREATES a `flow_runs` row with an initial `current_node_id` (this plan only advances an already-entered run) -- no blocker, but flagged since `processFlowRunAdvance`'s "no-op if `current_node_id` is null" guard is the seam where 06-06's enrollment logic must hand off a non-null starting node.
- The reconciliation scan's 60s cadence is the ONLY continuation mechanism for a non-delay chain (send -> exit) in this plan's scope -- acceptable for the "thinnest end-to-end slice," but 06-06/06-07 planning should be aware a flow with several consecutive non-delay nodes (once branch/other synchronous node types exist) would currently take multiples of 60s to fully resolve; revisit if a future plan wants faster multi-node convergence.

---
*Phase: 06-flows-triggered-chains*
*Completed: 2026-07-10*

## Self-Check: PASSED

All 8 created/modified files verified present on disk (flow-run-advance.worker.ts, flow-reconciliation.worker.ts, flow-exit-conditions.ts, flow-queues.ts, handlers/send-node.ts, handlers/exit-node.ts, flow-run-advance.test.ts, server.ts); all 3 task commit hashes (53335d5, 65b780a, f279674) verified present in git log.
