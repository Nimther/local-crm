---
phase: 06-flows-triggered-chains
plan: 06
subsystem: worker
tags: [bullmq, postgres, flows, event-trigger, re-entry, worker]

# Dependency graph
requires:
  - phase: 06-flows-triggered-chains
    provides: "06-04 flow CRUD/publish API (flows.live_version_id, exit_conditions); 06-05 flow-run-advance engine + FLOW_RUN_ADVANCE_QUEUE"
provides:
  - "Event-trigger evaluator: matches an ingested event's name against live event-triggered flows (D-01, name-only)"
  - "Re-entry decision logic (canEnterFlow): once_ever / once_per_n_days / every_time + the one-active-run guard (D-07)"
  - "events-ingest.worker.ts post-upsert enqueue onto FLOW_TRIGGER_EVALUATOR_QUEUE"
affects: [06-07, 06-08, 06-09, 06-11]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "DB-backed pure decision function (canEnterFlow) consulted by the caller BEFORE an idempotent INSERT ... ON CONFLICT DO NOTHING against the same partial unique index -- pre-check for a clean error reason, DB constraint as the actual concurrency backstop"
    - "Reused handlers/send-node.ts's resolveNextNodeId to resolve the trigger node's first downstream node, instead of re-implementing the same edge lookup"

key-files:
  created:
    - apps/worker/src/queues/flows/flow-reentry.ts
    - apps/worker/src/queues/flows/flow-trigger-evaluator.worker.ts
    - apps/worker/src/queues/__tests__/flow-trigger-evaluator.test.ts
  modified:
    - apps/worker/src/queues/flows/flow-queues.ts
    - apps/worker/src/queues/events-ingest.worker.ts
    - apps/worker/src/server.ts

key-decisions:
  - "canEnterFlow's one-active-run guard runs FIRST for ALL three re-entry modes (D-07 applies uniformly), not just as an every_time special case"
  - "flowTriggerEvaluatorQueue producer added to flow-queues.ts (not a new file) -- mirrors the existing singleton-Queue-module convention alongside emailTriggeredQueue/flowRunAdvanceQueue"
  - "events-ingest.worker.ts's transaction callback now returns { contactId } so the post-commit enqueue has what it needs -- the enqueue itself happens outside withTenantTransaction (BullMQ add() is not a DB call)"
  - "flow-trigger-check jobId is deterministic (${workspaceId}-${eventId}-flow-trigger) so a redelivered events-ingest job's re-enqueue is a safe no-op, mirroring the events table's own ON CONFLICT DO NOTHING idempotency"

patterns-established:
  - "Pattern: DB-backed pure decision function + idempotent INSERT ON CONFLICT DO NOTHING against the SAME partial unique index the decision function checked -- clean error reason for the common case, DB constraint for the race"

requirements-completed: [FLOW-02, FLOW-04]

coverage:
  - id: D1
    description: "An ingested event enqueues a flow-trigger-check job which matches live event-triggered flows by event name and creates a version-pinned flow_run + enqueues an advance job"
    requirement: "FLOW-02"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/flow-trigger-evaluator.test.ts#a live event-triggered flow + a matching event -> exactly one run pinned to live_version_id + an advance job enqueued"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/flow-trigger-evaluator.test.ts#a non-matching event name creates no run"
        status: pass
    human_judgment: false
  - id: D2
    description: "Re-entry control (once_ever / once_per_n_days / every_time) gates re-entry per FLOW-04/D-06, measured from the contact's last entry"
    requirement: "FLOW-04"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/flow-trigger-evaluator.test.ts#once_ever: a second matching event after the first run -> no new run"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/flow-trigger-evaluator.test.ts#once_per_n_days (N=7): a second event within the window -> no new run; after 7 days -> a new run"
        status: pass
    human_judgment: false
  - id: D3
    description: "At most one active run exists per contact x flow -- a trigger firing while a run is active is ignored (D-07), backed by the flow_runs_one_active_per_contact partial index"
    requirement: "FLOW-02"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/flow-trigger-evaluator.test.ts#one-active-run: two concurrent matching events while a run is active -> exactly one active run"
        status: pass
    human_judgment: false

duration: 24min
completed: 2026-07-10
status: complete
---

# Phase 6 Plan 06: Event-Trigger Evaluator + Re-Entry Control Summary

**Event-trigger evaluator (event name match, D-01) + DB-backed re-entry decision (once_ever/once_per_n_days/every_time, D-06) + the one-active-run guard (D-07), wired into events-ingest and proven on the real-Postgres/Redis lane**

## Performance

- **Duration:** 24 min
- **Started:** 2026-07-10T05:13:52Z (session start, per STATE.md)
- **Completed:** 2026-07-10T05:21:30Z
- **Tasks:** 3
- **Files modified:** 6 (3 created, 3 modified)

## Accomplishments
- `canEnterFlow` (flow-reentry.ts): one-active-run guard checked first for all three modes, then mode-specific logic (once_ever/once_per_n_days/every_time), with an explicit fail-closed branch for an unrecognized mode; adds no subscription/suppression predicate (D-05).
- `processFlowTriggerCheck` (flow-trigger-evaluator.worker.ts): matches an event name against live event-triggered flows, calls `canEnterFlow`, and for each allowed entry INSERTs a version-pinned `flow_runs` row (`ON CONFLICT (workspace_id, flow_id, contact_id) WHERE status IN ('waiting','advancing') DO NOTHING` against the `flow_runs_one_active_per_contact` index) before enqueuing an advance job with `jobId: flowRunId`.
- `events-ingest.worker.ts` now enqueues a flow-trigger-check job (deterministic `jobId`) immediately after the event upsert commits, closing the event → run → email loop end-to-end with 06-05.
- Registered `createFlowTriggerEvaluatorWorker` in `apps/worker/src/server.ts`'s `buildWorker()`.
- 5-case integration test on the real-Postgres/Redis lane: single-run + advance enqueue, non-matching event, `once_ever`, `once_per_n_days` (inside/outside the 7-day window), and the one-active-run guard under concurrent triggers.

## Task Commits

Each task was committed atomically:

1. **Task 1: Re-entry decision logic + one-active-run guard** - `d94e405` (feat)
2. **Task 2: flow-trigger-evaluator worker + events-ingest enqueue hook + registration** - `c657cdd` (feat)
3. **Task 3: Integration test — trigger creates one run, re-entry + one-active-run honored** - `6862d4d` (test)

## Files Created/Modified
- `apps/worker/src/queues/flows/flow-reentry.ts` - `canEnterFlow`: DB-backed re-entry decision (one-active-run guard + once_ever/once_per_n_days/every_time)
- `apps/worker/src/queues/flows/flow-trigger-evaluator.worker.ts` - `processFlowTriggerCheck` + `createFlowTriggerEvaluatorWorker`: event-name matcher, run creation, advance enqueue
- `apps/worker/src/queues/flows/flow-queues.ts` - added `flowTriggerEvaluatorQueue` producer for `FLOW_TRIGGER_EVALUATOR_QUEUE`
- `apps/worker/src/queues/events-ingest.worker.ts` - post-upsert enqueue of a flow-trigger-check job
- `apps/worker/src/server.ts` - registered the new worker in `buildWorker()`
- `apps/worker/src/queues/__tests__/flow-trigger-evaluator.test.ts` - integration test (5 cases)

## Decisions Made
- `canEnterFlow`'s active-run guard is checked unconditionally before any mode branch, per the plan's explicit ordering requirement (D-07 applies to all three modes).
- The flow-trigger-check enqueue's `jobId` includes both `workspaceId` and `eventId` (`${workspaceId}-${eventId}-flow-trigger`), keeping it consistent with this codebase's per-tenant jobId convention (02-10) while staying distinguishable from the events-ingest job's own jobId.
- Reused `handlers/send-node.ts`'s exported `resolveNextNodeId` to find the trigger node's first downstream node rather than duplicating the edge-lookup logic in the new worker file.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Combined with 06-05, the first user-observable E2E slice (event → run → email) is now live end-to-end: an ingested event can create a version-pinned run and drive it through send/exit nodes.
- 06-08 (segment-entry triggers + periodic sweep) and 06-07 (delay/wait nodes) build on this same trigger-evaluator/re-entry foundation; no blockers identified.

---
*Phase: 06-flows-triggered-chains*
*Completed: 2026-07-10*

## Self-Check: PASSED

All created/modified files present; all three task commits (`d94e405`, `c657cdd`, `6862d4d`) found in git log.
