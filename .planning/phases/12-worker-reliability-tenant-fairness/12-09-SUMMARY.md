---
phase: 12-worker-reliability-tenant-fairness
plan: 09
subsystem: infra
tags: [bullmq, redis, worker-reliability, retention, dead-letter, queue-core]

requires:
  - phase: 12-worker-reliability-tenant-fairness
    provides: "the shared error listener (12-07/12-08, WRK-08) and the dead-letter writer (12-07, D-07) wired onto every worker in apps/worker/src/server.ts's registry -- this plan's precondition, verified before touching any retention value"
provides:
  - "packages/queue-core/src/queue-options.ts's FAILED_JOB_RETENTION_SECONDS (7 days) with a rationale comment naming RECONCILE_RESCAN_HORIZON_MS and the dead-letter-writer dependency"
  - "STANDARD_JOB_RETENTION.removeOnFail bounded to that age instead of `false` (keep forever); FLOW_RUN_ADVANCE_RETENTION byte-for-byte unchanged"
  - "apps/worker/src/queues/__tests__/failed-job-retention.test.ts -- the invariant that no queue in either application keeps failed jobs indefinitely, that the differentiated flow-run-advance policy survives, and that every guarded module actually builds its options through buildJobOptions"
  - "flows/flow-segment-sweep.worker.ts migrated onto buildJobOptions(STANDARD_JOB_RETENTION), closing the one guarded module 12-02's consolidation missed"
affects: [12-10, 15-observability]

tech-stack:
  added: []
  patterns:
    - "Retention bound derived from and asserted against the wider of the reconciler's two windows (RECONCILE_RESCAN_HORIZON_MS, 72h) rather than a hand-typed number, so a future change to that constant is visible instead of silently disagreeing with a stale copy"
    - "Value-level invariant testing for retention correctness (assert on imported constants) combined with source-reading for factory usage (reuse the existing single-definition invariant's guarded-module list and pattern) -- each technique used where it is the more robust one"

key-files:
  created:
    - apps/worker/src/queues/__tests__/failed-job-retention.test.ts
  modified:
    - packages/queue-core/src/queue-options.ts
    - packages/queue-core/src/__tests__/queue-options.test.ts
    - apps/worker/src/queues/send-reconciler.worker.ts
    - apps/worker/src/queues/partition-maintenance.worker.ts
    - apps/worker/src/queues/flows/flow-segment-sweep.worker.ts
    - apps/worker/src/queues/__tests__/queue-core-single-definition.test.ts
    - SPECIFICATION.md

key-decisions:
  - "FAILED_JOB_RETENTION_SECONDS = 7 days, checked against RECONCILE_RESCAN_HORIZON_MS (72h, the wider of the reconciler's two windows) rather than the narrower 24h RECONCILE_RESOLUTION_WINDOW_MS -- clearing the wider window (~2.33x margin) implies clearing the narrower one too"
  - "Rule 2 deviation: flows/flow-segment-sweep.worker.ts's discovery-tick queue still built its own hand-rolled job-options literal with removeOnFail: false, missed by 12-02's consolidation. Left as-is it would make this plan's own must_have truth (\"every queue... retains failed jobs for a bounded age\") false at ship time, so it was migrated onto buildJobOptions(STANDARD_JOB_RETENTION) and added to queue-core-single-definition.test.ts's GUARDED_MODULES (now 12 modules) so the existing invariant protects it going forward. Verified via server.ts's attachSharedListeners(workers) call that this worker was already covered by the dead-letter precondition before bounding its retention."
  - "The new invariant test reuses (does not re-derive) the single-definition test's GUARDED_MODULES list and source-reading style for the 'builds options through the shared factory' half, per the plan's own read_first guidance to keep the two invariants consistent; the retention-bound assertions themselves are value-level (import the constants), per the plan's explicit instruction to avoid depending on call-site source text for that part"
  - "SPECIFICATION.md SS5.3/5.8/7 and SS9 items 12/21 rewritten from the pre-queue-core duplication narrative (still describing 8-9 hand-duplicated defaultJobOptions blocks) to the current buildJobOptions/STANDARD_JOB_RETENTION state -- the stale text would have directly contradicted this plan's own new documentation if left in place"

patterns-established:
  - "A retention or timing constant's rationale comment names both the invariant it must satisfy AND the specific test file that enforces it at the value level (failed-job-retention.test.ts), continuing the Phase 9 D-12 convention of visible, versioned configuration"

requirements-completed: [WRK-09]

coverage:
  - id: D1
    description: "FAILED_JOB_RETENTION_SECONDS (7 days) added to packages/queue-core; STANDARD_JOB_RETENTION's removeOnFail is now age-bounded instead of `false`, strictly greater than the 72h reconciliation rescan horizon with a documented ~2.33x margin"
    requirement: "WRK-09"
    verification:
      - kind: unit
        ref: "packages/queue-core/src/__tests__/queue-options.test.ts#failed-job retention (WRK-09)"
        status: pass
      - kind: unit
        ref: "npm test --workspace=packages/queue-core"
        status: pass
    human_judgment: false
  - id: D2
    description: "FLOW_RUN_ADVANCE_RETENTION left byte-for-byte unchanged; both retention fields (removeOnComplete, removeOnFail) genuinely differ from STANDARD_JOB_RETENTION's, so the per-queue parameterisation is observable rather than nominal"
    requirement: "WRK-09"
    verification:
      - kind: unit
        ref: "packages/queue-core/src/__tests__/queue-options.test.ts#the flow-run-advance retention constant is byte-for-byte unchanged by this plan"
        status: pass
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/failed-job-retention.test.ts#the differentiated policy survives: both retention fields differ between the two constants"
        status: pass
    human_judgment: false
  - id: D3
    description: "apps/worker/src/queues/__tests__/failed-job-retention.test.ts proves, at the value level, that no queue keeps failed jobs forever and, by source-reading the same 12-module guarded set as queue-core-single-definition.test.ts, that every queue-constructing module in both applications actually builds its job options through buildJobOptions -- including flows/flow-segment-sweep.worker.ts, migrated in this plan"
    requirement: "WRK-09"
    verification:
      - kind: unit
        ref: "vitest run --root apps/worker src/queues/__tests__/failed-job-retention.test.ts"
        status: pass
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/queue-core-single-definition.test.ts"
        status: pass
    human_judgment: false
  - id: D4
    description: "Full regression: apps/worker (396 tests), apps/api (396 tests), both tsconfig noEmit checks, and the complete failure-injection suite (npm run failure:all, 10 scenarios) all pass after the retention change"
    verification:
      - kind: unit
        ref: "npm test --workspace=apps/worker"
        status: pass
      - kind: unit
        ref: "npm test --workspace=apps/api"
        status: pass
      - kind: other
        ref: "npx tsc -p apps/worker/tsconfig.json --noEmit && npx tsc -p apps/api/tsconfig.json --noEmit"
        status: pass
      - kind: integration
        ref: "npm run failure:all"
        status: pass
    human_judgment: false

duration: ~40min
completed: 2026-08-10
status: complete
---

# Phase 12 Plan 09: Bounded Failed-Job Retention Summary

**`FAILED_JOB_RETENTION_SECONDS` (7 days) replaces `removeOnFail: false` on the standard queue-options shape, checked with margin against the reconciler's 72h rescan horizon, with `flow-run-advance`'s differentiated policy left untouched and a source-plus-value invariant test proving both.**

## Performance

- **Duration:** ~40 min
- **Completed:** 2026-08-10
- **Tasks:** 2
- **Files modified:** 7 (1 created, 6 modified)

## Accomplishments

- `FAILED_JOB_RETENTION_SECONDS = 7 days` added to `packages/queue-core/src/queue-options.ts` with a rationale comment naming the reconciliation window and the dead-letter durable-record dependency; `STANDARD_JOB_RETENTION.removeOnFail` is now `{ age: FAILED_JOB_RETENTION_SECONDS }` instead of `false`
- New invariant test (`apps/worker/src/queues/__tests__/failed-job-retention.test.ts`) proves at the value level that no queue keeps failed jobs indefinitely, that `FLOW_RUN_ADVANCE_RETENTION` stays deliberately different, and — by source-reading the same 12-module guarded set as `queue-core-single-definition.test.ts` — that every queue-constructing module actually builds its options through `buildJobOptions`
- Closed the one guarded module the 12-02 consolidation missed: `flows/flow-segment-sweep.worker.ts`'s discovery-tick queue was still a hand-rolled `{ attempts: 5, ..., removeOnFail: false }` literal; migrated onto `buildJobOptions(STANDARD_JOB_RETENTION)` and added to the guarded-module list
- `SPECIFICATION.md` §5.3/§5.8/§7 and §9 items 12/21 rewritten to the current post-consolidation, post-bounded-retention state (previously still narrating pre-`queue-core` duplicated literals)

## Task Commits

Each task was committed atomically (TDD RED/GREEN for Task 1):

1. **Task 1 RED: add failing test for bounded failed-job retention** - `3b93b7e` (test)
2. **Task 1 GREEN: bound the shared failed-job retention** - `bbff9cc` (feat)
3. **Task 2: retention invariant across every constructed queue** - `926a50e` (feat)

**Plan metadata:** committed with this SUMMARY.

_TDD: RED (`3b93b7e`) confirmed 3 assertions failing against the pre-change `removeOnFail: false`/missing constant, then GREEN (`bbff9cc`) turned them green by adding the constant and bounding the retention._

## Files Created/Modified

- `packages/queue-core/src/queue-options.ts` - `FAILED_JOB_RETENTION_SECONDS` constant; `STANDARD_JOB_RETENTION.removeOnFail` now age-bounded
- `packages/queue-core/src/__tests__/queue-options.test.ts` - retention-bound and differentiated-policy assertions at the constant level
- `apps/worker/src/queues/__tests__/failed-job-retention.test.ts` - new invariant (value-level retention bound + source-level factory-usage across 12 guarded modules)
- `apps/worker/src/queues/send-reconciler.worker.ts` - stale `removeOnFail: false` prose comment refreshed to name the bounded value
- `apps/worker/src/queues/partition-maintenance.worker.ts` - same comment refresh
- `apps/worker/src/queues/flows/flow-segment-sweep.worker.ts` - migrated from a hand-rolled job-options literal to `buildJobOptions(STANDARD_JOB_RETENTION)`
- `apps/worker/src/queues/__tests__/queue-core-single-definition.test.ts` - `GUARDED_MODULES` extended to 12 entries with the sweep discovery worker
- `SPECIFICATION.md` - §5.3/§5.8/§7 retention narrative updated; §9 items 12 and 21 marked closed

## Decisions Made

- Measured the retention margin against `RECONCILE_RESCAN_HORIZON_MS` (72h, the wider of the reconciler's two windows), not the narrower 24h `RECONCILE_RESOLUTION_WINDOW_MS` — clearing the wider window with ~2.33x margin implies clearing the narrower one automatically, and the comment documents both.
- Reused the existing `queue-core-single-definition.test.ts` `GUARDED_MODULES` list verbatim in the new test rather than re-deriving it, so the two invariants about "every queue-constructing module" can never silently diverge on which modules that means.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] `flows/flow-segment-sweep.worker.ts` retained failed jobs indefinitely, missed by 12-02's consolidation**
- **Found during:** Task 1 (reading every queue-constructing module before writing the retention invariant)
- **Issue:** This discovery-tick queue (`FLOW_SEGMENT_SWEEP_QUEUE`, constructed directly in this file) still declared its own hand-rolled `DEFAULT_JOB_OPTIONS = { attempts: 5, ..., removeOnFail: false }` instead of importing `buildJobOptions` from `@mega-crm/queue-core` like every other queue in the registry. It was not in `queue-core-single-definition.test.ts`'s `GUARDED_MODULES`, so the existing invariant never caught it. Left unbounded, this plan's own must_have truth — "every queue in both applications retains failed jobs for a bounded age" — would be false at ship time, and no test would notice.
- **Fix:** Confirmed via `apps/worker/src/server.ts` that `attachSharedListeners(workers)` already attaches the shared error listener (and therefore the dead-letter writer) to this worker before making the change — the WRK-09/WRK-10 causal-ordering precondition was already satisfied. Migrated the file to import `buildJobOptions`/`STANDARD_JOB_RETENTION` from `@mega-crm/queue-core` and delete the local literal; added the module to `GUARDED_MODULES` (now 12 entries) so the single-definition invariant protects it going forward; updated its stale comment accordingly.
- **Files modified:** `apps/worker/src/queues/flows/flow-segment-sweep.worker.ts`, `apps/worker/src/queues/__tests__/queue-core-single-definition.test.ts`
- **Verification:** `queue-core-single-definition.test.ts` (39 tests) and `failed-job-retention.test.ts` (16 tests) both pass with the module included; full `apps/worker` suite (396 tests) green.
- **Committed in:** `bbff9cc` (Task 1 GREEN commit)

**2. [Rule 1 - Bug/doc accuracy] Stale prose comments and SPECIFICATION.md sections still described the pre-`queue-core`, pre-bounded-retention state**
- **Found during:** Task 1, while reading every call site of `STANDARD_JOB_RETENTION` per the plan's `<read_first>` list
- **Issue:** `send-reconciler.worker.ts` and `partition-maintenance.worker.ts` each carried a comment literally naming `removeOnFail: false` as the current, load-bearing behavior — both became factually wrong the moment `STANDARD_JOB_RETENTION` changed. Separately, `SPECIFICATION.md` §5.3/§5.8/§7 and §9 items 12/21 still narrated the pre-12-02 state (8-9 hand-duplicated `defaultJobOptions` literals, `removeOnFail: false` bare fact) even though 12-02/12-08/12-11 had already consolidated most of those sites into `queue-core` — this plan's own required §5 retention update would have directly contradicted that stale text if left in place.
- **Fix:** Updated both worker-file comments to name the new bounded value and the dead-letter dependency. Rewrote the SPECIFICATION.md sections to the current, accurate state (single source via `queue-core`, `FAILED_JOB_RETENTION_SECONDS` rationale, per-queue parameterisation, the one differentiated queue) and marked §9 items 12 and 21 as closed by this plan (21's `UNSUBSCRIBE_TOKEN_TTL_SECONDS` duplicate is called out as a separate, still-open item).
- **Files modified:** `apps/worker/src/queues/send-reconciler.worker.ts`, `apps/worker/src/queues/partition-maintenance.worker.ts`, `SPECIFICATION.md`
- **Verification:** Manual re-read of every edited passage against the actual code state; `npx tsc --noEmit` on both apps unaffected (comment-only in the worker files).
- **Committed in:** `bbff9cc` (Task 1 GREEN commit)

---

**Total deviations:** 2 auto-fixed (1 missing critical functionality, 1 documentation accuracy)
**Impact on plan:** Both were necessary to make the plan's own stated truths and required documentation actually hold at ship time. No scope creep beyond what the plan's must_haves already required.

## Issues Encountered

- Running `npm test --workspace=apps/api` under default Vitest file parallelism produced 3 flaky failures in `src/modules/webhooks/__tests__/webhooks-signature.test.ts` (drifting `getJobCounts("waiting")` assertions) caused by concurrent test files sharing one Redis instance — unrelated to this plan's changes (that module was never touched). Confirmed pre-existing and environmental by re-running the same file in isolation (7/7 pass) and the full suite with `--no-file-parallelism` (396/396 pass). Not fixed (out of this plan's scope per the deviation rules' scope boundary) — logged here for visibility, not filed to `WINDOWS.md` from this worktree per the worktree-execution constraint.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- WRK-09 complete: every queue-constructing module in both `apps/worker` and `apps/api` now retains failed jobs for a bounded, documented age instead of forever, with the one deliberately different queue (`flow-run-advance`/`flow-segment-sweep-flow`) preserved and proven distinct by an automated invariant.
- No blockers for 12-10 or later phases. The pre-existing webhooks-signature test-parallelism flakiness (see Issues Encountered) is worth a follow-up if it recurs, but does not block this plan or the phase.

---
*Phase: 12-worker-reliability-tenant-fairness*
*Completed: 2026-08-10*

## Self-Check: PASSED

- FOUND: `apps/worker/src/queues/__tests__/failed-job-retention.test.ts`
- FOUND: `packages/queue-core/src/queue-options.ts` (exports `FAILED_JOB_RETENTION_SECONDS`)
- FOUND commit `3b93b7e` (test RED)
- FOUND commit `bbff9cc` (feat GREEN)
- FOUND commit `926a50e` (feat invariant test)
