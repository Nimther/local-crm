---
phase: 12-worker-reliability-tenant-fairness
plan: 12
subsystem: worker
tags: [bullmq, redis, gap-closure, worker-reliability]

# Dependency graph
requires:
  - phase: 12-worker-reliability-tenant-fairness
    provides: "plans 12-06 and 12-08's migration of campaign-scheduler, analytics-reconciliation and flow-reconciliation onto upsertJobScheduler, and the queue-core job-options factory this plan's five factories all already use"
provides:
  - "All five repeatable-tick workers (campaign-scheduler, analytics-reconciliation, flow-reconciliation, partition-maintenance, send-reconciler) actually consume jobs when constructed the way the composition root constructs them"
  - "A regression test (worker-autorun-default.test.ts) that constructs each factory with the exact production single-argument call shape and asserts the run loop starts and a job is picked up"
  - "A registration-settled waiter on send-reconciler.worker.ts, closing the last gap in that WeakMap pattern across all five factories"
  - "A recorded, tested decision that the accumulated tick backlog is safe to let fire on first boot (idempotent re-scans), with a burst-absorption test proving it"
affects: ["12-13", "any future phase touching these five worker factories or the composition root in apps/worker/src/server.ts"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Conditional-spread autorun idiom: `...(options.autorun !== undefined ? { autorun: options.autorun } : {})` instead of always forwarding a possibly-undefined option key"
    - "Per-test throwaway Redis (beforeEach/afterEach) instead of one shared instance per file, for suites that construct more than one REAL (autorun-on) BullMQ worker against the same queue"

key-files:
  created:
    - apps/worker/src/queues/__tests__/worker-autorun-default.test.ts
  modified:
    - apps/worker/src/queues/campaign-scheduler.worker.ts
    - apps/worker/src/queues/analytics-reconciliation.worker.ts
    - apps/worker/src/queues/flows/flow-reconciliation.worker.ts
    - apps/worker/src/queues/partition-maintenance.worker.ts
    - apps/worker/src/queues/send-reconciler.worker.ts

key-decisions:
  - "The five factories omit the `autorun` key entirely unless a caller supplies it, rather than defaulting it with `??` (which would restate BullMQ's own default value as a second source of truth)"
  - "The accumulated tick backlog is let to fire on first boot after the fix -- no drain/cleanup code added -- because every one of the five processors is an idempotent re-scan by construction (exclusive per-row claims, deterministic downstream job ids, overwrite-from-scan rollups)"
  - "worker-autorun-default.test.ts uses a fresh throwaway Redis per test (beforeEach/afterEach), not one shared instance for the whole file, after an isolated repro showed constructing a second REAL worker against a queue whose job scheduler a first real worker already ran against (same Redis instance) can hang the next tick job forever with no completed/failed/error event"

patterns-established:
  - "Behavioural regression tests for BullMQ option-forwarding bugs must construct factories with the exact call arity production uses (one argument), never an equivalent empty-options object, or a future parameter-default change stops being caught"

requirements-completed: [WRK-13]

coverage:
  - id: D1
    description: "Each of the five repeatable-tick workers, constructed exactly the way server.ts constructs it (single argument), starts its processing loop"
    requirement: "WRK-13"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/worker-autorun-default.test.ts#constructed with the production single-argument call shape, its processing loop is running (all 5 fixtures)"
        status: pass
    human_judgment: false
  - id: D2
    description: "A job waiting on a tick queue is picked up and reaches the active state on a production-shape worker"
    requirement: "WRK-13"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/worker-autorun-default.test.ts#campaign-scheduler: a job sitting on its tick queue is picked up and reaches 'active' on a production-shape worker"
        status: pass
    human_judgment: false
  - id: D3
    description: "The explicit test-only autorun:false suppression still prevents the run loop from starting, so existing registration suites keep their meaning"
    requirement: "WRK-13"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/worker-autorun-default.test.ts#the explicit test-only suppression (autorun: false) still prevents the loop from starting"
        status: pass
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/scheduler-registration.test.ts (20 tests)"
        status: pass
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/partition-maintenance.worker.test.ts (7 tests)"
        status: pass
    human_judgment: false
  - id: D4
    description: "A stacked burst of accumulated tick jobs drains to zero waiting/failed without duplicated downstream side effects"
    requirement: "WRK-13"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/worker-autorun-default.test.ts#campaign-scheduler: a stacked burst of identical tick jobs drains to zero waiting/failed without duplicated kickoff work"
        status: pass
    human_judgment: false
  - id: D5
    description: "The real development Redis backlog (the originally reported 107-waiting partition-maintenance queue and siblings) actually drains on the first boot after this fix, observed live"
    verification: []
    human_judgment: true
    rationale: "Requires booting the worker process against the actual development Redis instance holding the reported backlog and observing it for several minutes -- this executor ran in an isolated worktree with no access to that environment. Plan's own <human-check> verify item; not automatable from here."

duration: 55min
completed: 2026-08-11
status: complete
---

# Phase 12 Plan 12: Autorun-clobber gap closure (G-12-1) Summary

**Fixed all five repeatable-tick workers forwarding an undefined `autorun` key that silently disabled their run loops, with a regression test that failed first through the exact production call shape and a proven backlog-absorption case.**

## Performance

- **Duration:** 55 min
- **Tasks:** 3
- **Files modified:** 6 (5 worker source files + 1 new test file)

## Accomplishments

- Diagnosed-and-confirmed root cause closed: `campaign-scheduler.worker.ts`, `analytics-reconciliation.worker.ts`, `flow-reconciliation.worker.ts`, `partition-maintenance.worker.ts` and `send-reconciler.worker.ts` all forwarded `autorun: options.autorun` unconditionally into `new Worker(...)`. Under the composition root's one-argument call shape, that value is `undefined`, and BullMQ's plain-object-assign default merge lets an own `undefined` property clobber its own `autorun: true` default -- construction, listener registration, and scheduler registration all succeeded, but the processing loop never started.
- All five factories now use one conditional-spread idiom: the `autorun` key is included only when a caller actually supplies a value, otherwise omitted so BullMQ's own default applies -- matching `flow-segment-sweep.worker.ts` (the one factory that was never affected, because it never mentions the key at all).
- Each factory's options-interface doc comment was corrected: the old text asserted the option was "always left at the library's own default in production" -- the exact falsified claim that made this bug invisible on review. It now states the omission mechanism.
- `send-reconciler.worker.ts` gained the same registration-settled `WeakMap` waiter the other four factories already had, closing the one gap in that pattern and making it possible to construct this factory deterministically in a test without racing Redis teardown.
- `worker-autorun-default.test.ts` proves the fix through the exact call shape `apps/worker/src/server.ts` uses (one argument, no options object) for all five factories, proves a queued job reaches `active` on a real production-shape worker, keeps the explicit `autorun: false` suppression load-bearing, and proves a stacked 20-job burst drains to zero waiting/failed with no duplicated downstream kickoff work.
- Recorded the accumulated-backlog decision (missing item 3 from the UAT gap): every one of the five processors is an idempotent re-scan by construction, so the backlog that piled up while these workers weren't consuming is let to fire on first boot -- no drain/cleanup code was added.

## Task Commits

1. **Task 1: Make the defect observable** - `065b742` (test) -- registration waiter on send-reconciler + failing production-shape regression test (RED evidence: all 5 production-shape entries and the pickup case failed against the pre-fix code)
2. **Task 2: Stop forwarding an undefined run-loop option** - `4bc0750` (fix) -- conditional-spread idiom applied to all five factories; corrected doc comments; regression file now passes in full
3. **Task 3: Prove backlog absorption + record decision** - `2820e78` (test) -- burst-absorption case, let-them-fire header comment, and a switch to per-test throwaway Redis after finding a BullMQ/Redis interaction that hangs a second real worker's first job when it reuses a queue a prior real worker in the same Redis instance already consumed from

## RED Evidence (Task 1, before any factory was touched)

```
✗ 'campaign-scheduler' > constructed with the production single-argument call shape, its processing loop is running
✗ 'analytics-reconciliation' > constructed with the production single-argument call shape, its processing loop is running
✗ 'flow-reconciliation' > constructed with the production single-argument call shape, its processing loop is running
✗ 'partition-maintenance' > constructed with the production single-argument call shape, its processing loop is running
✗ 'send-reconciler' > constructed with the production single-argument call shape, its processing loop is running
✗ campaign-scheduler: a job sitting on its tick queue is picked up and reaches 'active' on a production-shape worker
✓ the explicit test-only suppression (autorun: false) still prevents the loop from starting   (already passed -- unaffected path)
```
6 of 7 cases failed for the reported reason; the 7th (explicit suppression) already passed since that path was never broken.

## Files Created/Modified

- `apps/worker/src/queues/campaign-scheduler.worker.ts` - conditional-spread `autorun`, corrected doc comment
- `apps/worker/src/queues/analytics-reconciliation.worker.ts` - conditional-spread `autorun`, corrected doc comment
- `apps/worker/src/queues/flows/flow-reconciliation.worker.ts` - conditional-spread `autorun`, corrected doc comment
- `apps/worker/src/queues/partition-maintenance.worker.ts` - conditional-spread `autorun`, corrected doc comment
- `apps/worker/src/queues/send-reconciler.worker.ts` - conditional-spread `autorun`, corrected doc comment, new registration-settled waiter (`waitForSendReconcilerRegistration`)
- `apps/worker/src/queues/__tests__/worker-autorun-default.test.ts` (new) - the regression suite: production-shape case (5 fixtures), pickup case, explicit-suppression case, burst-absorption case

## Decisions Made

- **Conditional spread over nullish-coalescing default:** the fix omits the `autorun` key entirely rather than writing `autorun: options.autorun ?? true`, since restating BullMQ's own default value in five places would be a second source of truth for a value the library already owns.
- **Let-them-fire backlog decision:** no drain/obliterate/wait-list-cleanup code was added anywhere. All five processors are idempotent re-scans (see per-queue justification in the test file's header comment), so the accumulated backlog firing all at once on first boot is safe by construction and is proven by the burst-absorption case, bounded by each worker's own concurrency (BullMQ default of 1, so execution is sequential, not a stampede).
- **Per-test Redis isolation in the new test file:** switched from one shared `TempRedis` (beforeAll/afterAll) to a fresh instance per test (beforeEach/afterEach) after empirically reproducing a hang: constructing a second REAL (autorun-on) BullMQ worker against a queue whose job scheduler a first real worker already registered and consumed from, in the same Redis instance, can leave that queue's very next tick job stuck `active` forever (no completed/failed/error event). This reproduced with no `obliterate()` involved, so it looks like a genuine BullMQ/Redis interaction around re-registering a job scheduler for a queue a prior real worker already ran against, not a bug in this plan's fix or a cleanup-ordering mistake in the test. Per-test isolation sidesteps it and is a more faithful model of what needs proving anyway (a worker booting once against a fresh queue).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test-file isolation change to avoid a BullMQ/Redis job-scheduler re-registration hang**
- **Found during:** Task 3 (writing the burst-absorption case and stabilizing the pickup case added in Task 1)
- **Issue:** The plan's own read_first/action text did not anticipate this; while making the file's tests reliable, an isolated repro outside the suite showed that constructing a second real (autorun-on) worker against a queue whose job scheduler a prior real worker in the *same* Redis instance already registered and ran against can hang the queue's next job forever (active event fires, then silence -- no completed, no failed, no error). This is a genuine environment/library interaction, not a defect in the source fix from Task 2 (confirmed via direct calls to the scanning function completing in single-digit milliseconds while the BullMQ job itself never settled).
- **Fix:** Switched `worker-autorun-default.test.ts` from one shared `TempRedis` per file (`beforeAll`/`afterAll`) to a fresh instance per test (`beforeEach`/`afterEach`). Verified stable across 6+ consecutive full-file runs and 2 consecutive full `apps/worker` suite runs (404/404 passing each time).
- **Files modified:** apps/worker/src/queues/__tests__/worker-autorun-default.test.ts
- **Verification:** `vitest run --root apps/worker src/queues/__tests__/worker-autorun-default.test.ts` — 8/8 passing, repeated 6 times with no failures; `npm test --workspace=apps/worker` — 404/404 passing, repeated twice.
- **Committed in:** 2820e78 (Task 3 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 — test reliability bug found and fixed during Task 3)
**Impact on plan:** No change to the production fix (Task 2) or its scope. The deviation is confined to test-harness isolation discipline in the new regression file and is documented in that file's own header comment for future maintainers.

## Issues Encountered

- An unrelated, pre-existing flaky test (`apps/worker/src/queues/__tests__/failure-injection/tenant-fairness.test.ts`, a real-timing two-tenant throughput comparison from an earlier phase) failed once during a `npm test --workspace=apps/worker` run with a borderline ratio (4.51 vs a 4.74 threshold) and passed cleanly on immediate retry and in every subsequent full-suite run. Out of scope for this plan (unrelated file, no changes made here); not fixed, only noted.
- Diagnosing the burst-test hang required an extended debugging session: initial hypothesis (obliterate-then-reregister corrupting job-scheduler state) was disproven by an isolated repro; the actual reproducing condition (two real-worker constructions on the same queue in one Redis instance, independent of obliterate) was found via further isolated repros before landing on the per-test-Redis fix.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- G-12-1 (blocker) is closed: all five repeatable-tick workers consume jobs under the production call shape, proven by a test that failed first for the reported reason.
- **Manual verification still outstanding (plan's own `<human-check>` item, D5 above):** boot the worker process against the real development Redis instance that held the originally-reported backlog (partition-maintenance: 107 waiting, and siblings) and confirm live: the five tick queues' waiting counts fall toward zero, `active` events appear on each of the five, nothing lands in the failed set, and partition horizon / campaign scan behavior is unaffected. This executor ran in an isolated worktree with no access to that environment and could not perform this check.
- Plan 12-13 (G-12-2, SPECIFICATION.md/ARCHITECTURE.md staleness) depends on this gap being closed before its own docs re-verification can proceed, per the UAT gap's own noted fix order.

---
*Phase: 12-worker-reliability-tenant-fairness*
*Completed: 2026-08-11*
