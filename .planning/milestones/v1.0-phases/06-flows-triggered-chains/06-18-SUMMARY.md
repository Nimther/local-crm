---
phase: 06-flows-triggered-chains
plan: 18
subsystem: api
tags: [postgres, transactions, flows, segments, bullmq, compliance]

requires:
  - phase: 06-flows-triggered-chains
    provides: publishFlow (flow.repository.ts), flow-enroll-existing.worker.ts's seedSnapshotOnly/enrollBatch (06-08), flow_segment_membership_snapshot table (06-01/06-08)
provides:
  - Atomic (same-transaction) do-not-enroll snapshot seed on publishFlow for enrollExisting=false segment-triggered flows
  - Publish route that only enqueues the async enroll-existing job for the enrollExisting=true back-fill case
affects: [flow-publish, flow-segment-sweep, flow-enroll-existing-worker]

tech-stack:
  added: []
  patterns:
    - "In-transaction bounded INSERT...SELECT seed (mirrors worker's seedSnapshotOnly) performed inside the same repository transaction that flips a resource live, closing an async-job race/loss window"

key-files:
  created:
    - apps/api/src/modules/flows/__tests__/flow-enroll-atomic.test.ts
  modified:
    - apps/api/src/modules/flows/flow.repository.ts
    - apps/api/src/modules/flows/flows.routes.ts

key-decisions:
  - "publishFlow gained an optional opts?: { enrollExisting?: boolean } second parameter; default (omitted or false) is the safe atomic seed-only behavior, matching the plan's stated default"
  - "Seed logic (seedMembershipSnapshotAtomic) duplicates flow-enroll-existing.worker.ts's seedSnapshotOnly SQL shape locally in flow.repository.ts rather than importing across the api/worker package boundary, mirroring the plan's explicit non-goal of touching the worker file"
  - "flow-enroll-existing.worker.ts is left completely unchanged -- its enrollExisting=false branch is now dead code from the route's perspective (never enqueued for that case anymore) but stays as a defensive/redundant handler"

requirements-completed: [FLOW-02]

coverage:
  - id: D1
    description: "Publishing a segment-triggered flow with enrollExisting=false seeds flow_segment_membership_snapshot for every current member atomically inside publishFlow's own transaction, with zero flow_runs rows created"
    requirement: "FLOW-02"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/flows/__tests__/flow-enroll-atomic.test.ts#06-18/CR-02: publishing a segment-triggered flow with enrollExisting=false seeds the snapshot atomically (zero runs, all members seen, synchronously)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Publish route only enqueues the async flowEnrollExistingQueue job for the enrollExisting=true back-fill case; event-triggered publish and the enrollExisting=true path are unaffected"
    requirement: "FLOW-02"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/flows/__tests__/flow-lifecycle.test.ts"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/flow-segment-trigger.test.ts"
        status: pass
    human_judgment: false

duration: 15min
completed: 2026-07-10
status: complete
---

# Phase 06 Plan 18: Atomic do-not-enroll snapshot seed on publish (CR-02) Summary

**Closed CR-02: the enrollExisting=false snapshot seed now runs synchronously inside `publishFlow`'s own transaction, eliminating the async-job race window that could mass-enroll an entire segment.**

## Performance

- **Duration:** 15 min
- **Started:** 2026-07-10T14:20:00Z (approx.)
- **Completed:** 2026-07-10T14:35:10Z
- **Tasks:** 2 completed
- **Files modified:** 3 (1 created, 2 modified)

## Accomplishments

- `publishFlow` now accepts `opts?: { enrollExisting?: boolean }`; for a segment-triggered flow with `enrollExisting !== true`, it seeds `flow_segment_membership_snapshot` via a bounded (60s statement_timeout) `INSERT ... SELECT ... ON CONFLICT DO NOTHING` inside its own transaction, immediately after the `flows` status UPDATE and before commit.
- The publish route (`flows.routes.ts`) now only enqueues the async `flowEnrollExistingQueue` job when `enrollExisting === true` (the resumable batch back-fill case) — the seed-only case is fully synchronous and needs no job at all.
- A new repository-level regression test (`flow-enroll-atomic.test.ts`) pins the behavior: publishing directly via the repository functions (no HTTP layer, no BullMQ worker running) proves the snapshot is fully seeded (3/3 matching members) and zero `flow_runs` rows exist, immediately after `publishFlow` returns.
- `flow-lifecycle.test.ts` (event-triggered publish/pause/resume/duplicate/D-23/D-24/06-16) and `flow-segment-trigger.test.ts` (worker's sweep/enroll-existing paths) both remain fully green — no regression to unrelated publish paths.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add a failing atomic-seed regression test (RED)** - `d0ff3d8` (test)
2. **Task 2: Make the enrollExisting=false seed atomic inside publishFlow (GREEN)** - `10c0993` (feat)

**Plan metadata:** (this commit, docs)

_TDD flow: RED (d0ff3d8, snapshotCount 0 != 3) -> GREEN (10c0993, snapshotCount 3 == 3, runCount 0)._

## Files Created/Modified

- `apps/api/src/modules/flows/__tests__/flow-enroll-atomic.test.ts` - New repository-level regression test proving the atomic seed (3 matching members seeded, 0 runs, non-matching contact never marked seen)
- `apps/api/src/modules/flows/flow.repository.ts` - `publishFlow` gains `opts?: { enrollExisting?: boolean }`; new `seedMembershipSnapshotAtomic` helper performs the bounded in-transaction seed for the `enrollExisting !== true` branch
- `apps/api/src/modules/flows/flows.routes.ts` - Publish route passes `enrollExisting` into `publishFlow` and only enqueues `flowEnrollExistingQueue.add` when `enrollExisting === true`

## Decisions Made

- Default behavior when `opts` is omitted entirely (e.g. any future direct repository caller) is the safe seed-only path, matching the plan's literal artifact description ("default: the safe seed-only behavior") — a caller must explicitly opt in to the back-fill-with-runs behavior.
- Seed SQL is duplicated locally in `flow.repository.ts` (not imported from `flow-enroll-existing.worker.ts`) to avoid a new dependency from the `apps/api` package onto `apps/worker`'s internal module — mirrors the codebase's existing api/worker package-boundary convention.
- `flow-enroll-existing.worker.ts` was deliberately left untouched per the plan's explicit instruction; its `enrollExisting=false` branch (`seedSnapshotOnly`) is no longer reachable via the route but remains as a defensive/redundant handler, and its own existing test (`flow-segment-trigger.test.ts`) stays green unmodified.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None. The RED test failed correctly for the intended reason (a real DB-observed behavioral assertion — `snapshotCount` was `0` instead of `3` — not a compile/setup error), confirming the regression was pinned before the fix landed.

## User Setup Required

None - no external service configuration required. No schema migration and no new npm dependency were introduced.

## Next Phase Readiness

CR-02 is closed: publishing a segment-triggered flow with `enrollExisting=false` can no longer race a sweep tick or lose an async job in a way that mass-enrolls the excluded segment. The `enrollExisting=true` back-fill path (resumable batch worker) and event-triggered publish are unaffected. No known blockers for downstream 06-VERIFICATION re-check of CR-02.

---
*Phase: 06-flows-triggered-chains*
*Completed: 2026-07-10*

## Self-Check: PASSED

- FOUND: apps/api/src/modules/flows/__tests__/flow-enroll-atomic.test.ts
- FOUND: apps/api/src/modules/flows/flow.repository.ts
- FOUND: apps/api/src/modules/flows/flows.routes.ts
- FOUND: commit d0ff3d8
- FOUND: commit 10c0993
