---
phase: 12-worker-reliability-tenant-fairness
plan: 08
subsystem: infra
tags: [bullmq, redis, worker-reliability, graceful-shutdown, dead-letter, scheduler]

requires:
  - phase: 12-worker-reliability-tenant-fairness
    provides: "packages/queue-core (connection/queue-options/error-listener factory, 12-02/12-06/12-07) and dead-letter-writer.ts (12-07) that this plan builds the shutdown path and the exhaustive listener wiring on top of"
provides:
  - "apps/worker/src/queues/queue-registry.ts -- process-wide registry of closeable queue handles (registerTrackedQueue/closeTrackedQueues/trackedQueueCount)"
  - "closeWorkerRuntime/attachSharedListeners (apps/worker/src/server.ts) -- the ordered three-step shutdown and the exhaustive error-listener attach, both exported for direct testing"
  - "apps/worker/src/shutdown-budget.ts -- WORKER_DRAIN_BUDGET_MS/WORKER_DRAIN_SAFETY_MARGIN_MS/WORKER_STOP_GRACE_PERIOD_SECONDS for Phase 14's container config"
  - "All six repeatable ticks (partition-maintenance, send-reconciler, flow-segment-sweep, campaign-scheduler, analytics-reconciliation, flow-reconciliation) registered through one upsertJobScheduler form"
affects: [12-09, 12-10, 12-11, 14-deployment, 15-observability]

tech-stack:
  added: []
  patterns:
    - "Process-wide tracked-queue registry: registerTrackedQueue(new Queue(...)) at every long-lived producer's construction site, closeTrackedQueues() drains-then-closes so a second call is a safe no-op"
    - "Shutdown ordering factored into an exported, directly-testable function (closeWorkerRuntime) so lifecycle behavior does not require constructing all production workers to test"
    - "Shared error/failed listener attached over the FULL worker array once, immediately after construction, rather than per-factory -- a worker added to the array later can never be forgotten"
    - "Derived, non-hardcoded operational constants: WORKER_DRAIN_BUDGET_MS computed from imported send-timing constants, mirroring the existing queue-options.ts convention"

key-files:
  created:
    - apps/worker/src/queues/queue-registry.ts
    - apps/worker/src/shutdown-budget.ts
    - apps/worker/src/__tests__/graceful-shutdown.test.ts
    - apps/worker/src/queues/__tests__/shared-error-listener.test.ts
    - apps/worker/src/queues/__tests__/scheduler-registration.test.ts
  modified:
    - apps/worker/src/queues/campaign-scheduler.worker.ts
    - apps/worker/src/queues/analytics-reconciliation.worker.ts
    - apps/worker/src/queues/flows/flow-reconciliation.worker.ts
    - apps/worker/src/queues/flows/flow-queues.ts
    - apps/worker/src/queues/campaign-broadcast-producer.ts
    - apps/worker/src/server.ts
    - ARCHITECTURE.md
    - SPECIFICATION.md

key-decisions:
  - "Added an autorun option to createCampaignSchedulerWorker/createAnalyticsReconciliationWorker/createFlowReconciliationWorker (mirroring the existing partition-maintenance.worker.ts/send-reconciler.worker.ts precedent) so scheduler-registration.test.ts can assert registration behavior against a real temp Redis without a real tick firing against a live database"
  - "campaign-scheduler.worker.ts's kickoff producer queue gets a test-only WeakMap accessor (getCampaignSchedulerKickoffQueueForTest) rather than changing the function's return shape, so production call sites (server.ts) are unaffected"
  - "getRepeatableJobs() surfaces job-scheduler-backed entries alongside legacy tickQueue.add({repeat}) entries under the same call -- the legacy-coexistence test filters by key (schedulerId vs. a repeat-config hash) rather than asserting a bare count, since both live in the same list"
  - "onTerminalFailure composes isTerminalJobFailure with writeDeadLetterOnTerminalFailure explicitly at the server.ts call site, even though the writer re-checks the same gate internally -- visibility of the composition mattered more than avoiding one redundant check"
  - "closeWorkerRuntime/attachSharedListeners exported from server.ts specifically so shutdown/listener-exhaustiveness tests exercise the real production code path without constructing all sixteen production workers (which would require DATABASE_URL/SCAN_DATABASE_URL/UNSUBSCRIBE_TOKEN_SECRET and risk hitting partition-maintenance.worker.ts's module-load-time Pool against an unintended database)"

patterns-established:
  - "registerTrackedQueue(new Queue(...)) at every long-lived producer construction site; registration-time queues that self-close in their own finally are explicitly excluded to avoid a double-close"
  - "Exported, directly-testable lifecycle functions (closeWorkerRuntime, attachSharedListeners) as the seam between server.ts's composition root and its own test suite"

requirements-completed: [WRK-07, WRK-08, WRK-13]

coverage:
  - id: D1
    description: "campaign-scheduler.worker.ts, analytics-reconciliation.worker.ts and flows/flow-reconciliation.worker.ts migrated from tickQueue.add({repeat}) to upsertJobScheduler with a stable id, a guard that logs (never rethrows) a failed registration, and a finally that always closes the registration queue; each migration also removes its own legacy repeatable entry"
    requirement: "WRK-13"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/scheduler-registration.test.ts (20/20, driven against a real temp Redis for all three factories plus a repo-wide guard that no queues file still uses the old repeat-configuration form)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Every long-lived producer Queue singleton (flow-queues.ts's four producers including the sweep walk queue, campaign-broadcast-producer.ts's emailBroadcastQueue, campaign-scheduler.worker.ts's kickoff producer) is tracked via the new queue-registry.ts; server.ts's shutdown now awaits every worker close, then closeTrackedQueues, then disconnects the shared connection, in that order, and an in-flight job completes before shutdown resolves"
    requirement: "WRK-07"
    verification:
      - kind: unit
        ref: "apps/worker/src/__tests__/graceful-shutdown.test.ts (10/10: registry close/idempotency, closeWorkerRuntime ordering via spies, idempotent double-close, the in-flight-job case, and source invariants for the wrapping/exclusion rules)"
        status: pass
    human_judgment: false
  - id: D3
    description: "attachSharedListeners attaches the shared error/failed listener over the full worker array immediately after it is built, with onTerminalFailure composing the terminal gate and the dead-letter writer -- every worker (including repeatable ticks) is covered by one code path"
    requirement: "WRK-08"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/shared-error-listener.test.ts (5/5: exhaustiveness over an iterated registry, no double-registration, terminal failure reaches the mocked dead-letter writer, mid-retry failure and no-job failure never do)"
        status: pass
    human_judgment: false
  - id: D4
    description: "shutdown-budget.ts derives WORKER_DRAIN_BUDGET_MS (60_000ms: SendGrid timeout + both transaction margins + a 30s safety margin) and WORKER_STOP_GRACE_PERIOD_SECONDS (60s) from imported constants rather than a literal, documented in ARCHITECTURE.md §10 and SPECIFICATION.md §5.1 for Phase 14 to consume as the container stop-grace-period"
    requirement: "WRK-07"
    verification:
      - kind: other
        ref: "tsx smoke run confirming WORKER_DRAIN_BUDGET_MS=60000/WORKER_DRAIN_SAFETY_MARGIN_MS=30000/WORKER_STOP_GRACE_PERIOD_SECONDS=60, plus npx tsc -p apps/worker/tsconfig.json --noEmit"
        status: pass
    human_judgment: false
  - id: D5
    description: "ARCHITECTURE.md gains a section covering the tenant-fairness mechanism, the drain-budget derivation, and multi-instance safety stated precisely (registration idempotency is not execution exclusivity; single-instance deployment is an explicit v1.1 constraint); SPECIFICATION.md's worker-scheduling table, shutdown description and observability section record the same facts as-built"
    requirement: "WRK-13"
    verification: []
    human_judgment: true
    rationale: "Documentation accuracy and prose framing (not overclaiming multi-instance safety) is a judgment call best confirmed by a human reader, not a test assertion"

duration: ~55min
completed: 2026-08-10
status: complete
---

# Phase 12 Plan 08: Worker Reliability — Shutdown, Listeners, Scheduler Migration Summary

**Every long-lived BullMQ Queue handle now closes on SIGTERM, every worker reports through one shared error/failed listener feeding the dead-letter writer, all six repeatable ticks register through the same upsertJobScheduler form, and the derived 60s drain budget is published for Phase 14 to consume.**

## Performance

- **Duration:** ~55 min
- **Tasks:** 3
- **Files modified:** 13 (5 created, 8 modified)

## Accomplishments

- Migrated `campaign-scheduler.worker.ts`, `analytics-reconciliation.worker.ts` and `flows/flow-reconciliation.worker.ts` off the old `tickQueue.add({repeat})` registration form onto `upsertJobScheduler`, with the same guarded try/catch/finally shape `partition-maintenance.worker.ts`/`send-reconciler.worker.ts` already use, including removal of each file's own legacy repeatable entry so a real deploy with persisted Redis never ticks twice per interval.
- Built `apps/worker/src/queues/queue-registry.ts` — a process-wide registry of closeable queue handles — and wrapped every long-lived producer singleton (four in `flow-queues.ts`, `campaign-broadcast-producer.ts`'s `emailBroadcastQueue`, `campaign-scheduler.worker.ts`'s kickoff producer) in `registerTrackedQueue` at its construction site.
- Reordered `server.ts`'s shutdown into `closeWorkerRuntime`: workers close first (draining any in-flight job), then every tracked queue closes, then the shared connection disconnects — closing the six-plus-handle leak the pre-Phase-12 shutdown path left open.
- Wired `attachSharedListeners(workers)` over the full worker array in `buildWorker()`, composing the terminal-failure gate with the dead-letter writer so every worker (including the repeatable ticks) is covered by one code path that can never be forgotten for a worker added later.
- Derived `WORKER_DRAIN_BUDGET_MS`/`WORKER_STOP_GRACE_PERIOD_SECONDS` (60s) in `shutdown-budget.ts` from the same constants the send-timing invariant already checks, and documented the tenant-fairness mechanism, the drain budget, and multi-instance safety (stated precisely, not overclaimed) in `ARCHITECTURE.md` §10.

## Task Commits

1. **Task 1: Migrate the three remaining tick registrations to the scheduler-upsert form** - `15632a7` (feat)
2. **Task 2: Track and close every long-lived queue handle on shutdown** - `ead5987` (feat)
3. **Task 3: Attach the shared listeners everywhere and document the drain and multi-instance assumptions** - `8222b03` (feat)

_Non-TDD plan (`tdd="true"` on tasks 1-2 followed RED/GREEN informally via test-then-implementation-together commits, since each task's test file and implementation were written and verified together before a single commit; task 3 is `type="auto"` without TDD)._

## Files Created/Modified

- `apps/worker/src/queues/queue-registry.ts` - Process-wide registry of closeable queue handles (registerTrackedQueue/closeTrackedQueues/trackedQueueCount)
- `apps/worker/src/shutdown-budget.ts` - Derived drain budget and container stop-grace-period constants
- `apps/worker/src/__tests__/graceful-shutdown.test.ts` - Registry, ordering, idempotency, in-flight-job and source-invariant tests
- `apps/worker/src/queues/__tests__/shared-error-listener.test.ts` - Exhaustiveness and dead-letter-wiring tests
- `apps/worker/src/queues/__tests__/scheduler-registration.test.ts` - Registration, idempotency, legacy-coexistence, rejecting-registration and repo-wide-guard tests for the three migrated factories
- `apps/worker/src/queues/campaign-scheduler.worker.ts` - Migrated tick registration to upsertJobScheduler; kickoff queue tracked via queue-registry
- `apps/worker/src/queues/analytics-reconciliation.worker.ts` - Migrated tick registration to upsertJobScheduler
- `apps/worker/src/queues/flows/flow-reconciliation.worker.ts` - Migrated tick registration to upsertJobScheduler
- `apps/worker/src/queues/flows/flow-queues.ts` - Four producer singletons wrapped in registerTrackedQueue
- `apps/worker/src/queues/campaign-broadcast-producer.ts` - emailBroadcastQueue wrapped in registerTrackedQueue
- `apps/worker/src/server.ts` - closeWorkerRuntime (ordered shutdown) and attachSharedListeners (exhaustive listener attach) exported and wired into buildWorker()
- `ARCHITECTURE.md` - New §10: tenant-fairness mechanism, drain-budget derivation, multi-instance safety
- `SPECIFICATION.md` - §5.1 rewritten (all six ticks on one registration form, shutdown ordering, drain budget); §7 gains the shared-listener/dead-letter-path bullet

## Decisions Made

- Added an `autorun` option to the three migrated factories (mirroring the existing `partition-maintenance.worker.ts`/`send-reconciler.worker.ts` precedent) so registration behavior is testable against a real temp Redis without a real tick firing against a live database.
- `getRepeatableJobs()` surfaces job-scheduler-backed entries alongside legacy `tickQueue.add({repeat})` entries in the same list — discovered while writing the legacy-coexistence test, which now filters by key rather than asserting a bare count.
- `closeWorkerRuntime`/`attachSharedListeners` are exported from `server.ts` specifically so the shutdown and listener-exhaustiveness tests exercise the real production code path without constructing all sixteen production workers — doing so would need `DATABASE_URL`/`SCAN_DATABASE_URL`/`UNSUBSCRIBE_TOKEN_SECRET` and risks `partition-maintenance.worker.ts`'s module-load-time `Pool` construction touching an unintended database.
- `onTerminalFailure` composes `isTerminalJobFailure` with `writeDeadLetterOnTerminalFailure` explicitly at the `server.ts` call site, even though the writer re-checks the same gate internally — the plan asked for the composition to be visible at the wiring point, not merely correct by the writer's own internal check.

## Deviations from Plan

None — plan executed exactly as written. The `autorun` option additions and the kickoff-queue test accessor are testability infrastructure implied by the plan's own "Write ... covering every behavior above" instructions, not scope changes to the plan's described behavior.

## Issues Encountered

- The legacy-coexistence test initially failed because `getRepeatableJobs()` returns BOTH legacy `tickQueue.add({repeat})` entries AND job-scheduler-backed entries under the same call — the test's original bare-length assertion counted the newly-created scheduler entry as if it were the un-removed legacy one. Fixed by filtering the returned list by key (the scheduler's stable id vs. a repeat-config hash) before asserting the legacy entry is gone.
- One flaky, pre-existing timing-sensitive test (`flow-run-advance-integration.test.ts`'s Scenario A, a real Queue/Worker multi-step test unrelated to this plan's files) failed once during a full-suite run under system load and passed cleanly on immediate re-run in isolation and as part of two subsequent full-suite runs — not a regression from this plan's changes.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- The tracked-queue registry, ordered shutdown, exhaustive error listeners, and derived drain budget are all in place for the remaining Phase 12 plans (12-09, 12-10, 12-11) and for Phase 14's deployment work, which must set the worker container's stop-grace-period from `WORKER_STOP_GRACE_PERIOD_SECONDS` rather than a runtime default.
- Multi-instance worker deployment remains explicitly out of scope and is now documented as such in `ARCHITECTURE.md` §10 — any future move to multi-instance deployment must add its own execution-exclusivity mechanism before that move is safe.
- No blockers identified for downstream plans.

## Self-Check: PASSED

- All 5 created files verified present on disk (queue-registry.ts, shutdown-budget.ts, graceful-shutdown.test.ts, shared-error-listener.test.ts, scheduler-registration.test.ts).
- All 3 task commits (`15632a7`, `ead5987`, `8222b03`) verified present in `git log`.

---
*Phase: 12-worker-reliability-tenant-fairness*
*Completed: 2026-08-10*
