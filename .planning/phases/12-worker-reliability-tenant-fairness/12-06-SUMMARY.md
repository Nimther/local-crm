---
phase: 12-worker-reliability-tenant-fairness
plan: 06
subsystem: worker
tags: [bullmq, postgres, drizzle, keyset-pagination, row-level-security, flows]

requires:
  - phase: 10-tenant-isolation-trust-boundaries
    provides: mega_crm_scan cross-workspace scan role, withCrossWorkspaceScan, fail-closed RLS predicate (migration 0044)
  - phase: 06-flows-triggered-chains
    provides: flow_segment_membership_snapshot, enterSegmentTriggeredFlow entry primitive, the original unbounded flow-segment-sweep.worker.ts
provides:
  - Bounded, checkpointed, resumable segment sweep (flow_segment_sweep_checkpoint table + module)
  - Discovery/walk split for the segment sweep (flow-segment-sweep.worker.ts + flow-segment-sweep-flow.worker.ts)
  - flow-segment-sweep migrated from tickQueue.add({repeat}) to upsertJobScheduler (WRK-13)
  - segment-sweep-kill-resume failure-injection scenario in CI
affects: [worker-reliability, tenant-fairness, flow-engine]

tech-stack:
  added: []
  patterns:
    - "Discovery scan (cross-workspace, admin-scan role) enqueues one bounded per-flow job under a deterministic jobId -- mirrors campaign-scheduler -> campaign-kickoff"
    - "Per-page transaction commits the page's writes and its resume cursor together, in a Postgres row (not job.updateData(), not a bare Redis key)"
    - "Perpetual-walk cursor resets to NULL on completion, unlike a one-shot snapshot-freeze cursor (recipient-snapshot.ts)"
    - "schemaVersion-carrying job payloads, validated with safeParse, deferred (not thrown) on an unrecognized version"

key-files:
  created:
    - packages/db/migrations/0053_flow_segment_sweep_checkpoint.sql
    - packages/db/src/schema/flow-segment-sweep-checkpoint.ts
    - apps/worker/src/queues/flows/flow-segment-sweep-checkpoint.ts
    - apps/worker/src/queues/flows/flow-segment-sweep-flow.worker.ts
    - apps/worker/src/queues/__tests__/failure-injection/segment-sweep-kill-resume.test.ts
  modified:
    - apps/worker/src/queues/flows/flow-segment-sweep.worker.ts
    - apps/worker/src/queues/flows/flow-queues.ts
    - apps/worker/src/server.ts
    - packages/shared-schemas/src/queues.ts
    - packages/db/src/index.ts
    - apps/worker/src/queues/__tests__/flow-segment-trigger.test.ts
    - apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts
    - packages/tenant-context/src/__tests__/tenant-context.test.ts
    - apps/worker/src/queues/partition-maintenance.worker.ts
    - package.json
    - .github/workflows/ci.yml
    - SPECIFICATION.md

key-decisions:
  - "Checkpoint is a dedicated Postgres table (flow_segment_sweep_checkpoint), not job.updateData() or a bare Redis key -- per D-09, committed in the same transaction as the page's enrollment work"
  - "Checkpoint cursor resets to NULL when a page returns zero rows -- the sweep is perpetual, unlike recipient-snapshot.ts's one-shot freeze"
  - "Discovery's SELECT narrowed to id/workspace_id only -- the walk job re-derives the flow's trigger segment/reentry config itself from flows, never trusting a payload copy"
  - "Snapshot 'seen' diff is scoped to the current page's contact ids, not the whole flow's snapshot -- closes a second unbounded-memory path the old sweepOneFlow had"
  - "flowSegmentSweepFlowQueue gets its own removeOnComplete:true job options (not the shared 9-site default) so a retained completed job under the deterministic jobId never shadows the next discovery tick, mirroring FLOW_RUN_ADVANCE_JOB_OPTIONS's CR-01 precedent"

patterns-established:
  - "Bounded per-flow walk job budget (SWEEP_FLOW_JOB_BUDGET_MS) that yields the worker rather than completing a huge flow in one job -- the next discovery tick's deterministic-jobId job resumes from the committed cursor"

requirements-completed: [WRK-05, WRK-06]

coverage:
  - id: D1
    description: "Bounded, checkpointed keyset-paginated per-flow walk (never OFFSET), with the resume cursor committed in the same transaction as the page's enrollment work"
    requirement: "WRK-05"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/failure-injection/segment-sweep-kill-resume.test.ts#resumes from the committed checkpoint after a simulated interruption, without reprocessing already-committed contacts, and clears the cursor on completion"
        status: pass
    human_judgment: false
  - id: D2
    description: "Cursor resets to NULL on walk completion so a contact inserted behind the old cursor position is not permanently skipped"
    requirement: "WRK-05"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/failure-injection/segment-sweep-kill-resume.test.ts#resumes from the committed checkpoint after a simulated interruption, without reprocessing already-committed contacts, and clears the cursor on completion"
        status: pass
    human_judgment: false
  - id: D3
    description: "Discovery/walk split: discovery enqueues exactly one bounded walk job per live segment-triggered flow, deterministic jobId, no double-enqueue for a still-pending flow"
    requirement: "WRK-06"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/flow-segment-trigger.test.ts#12-06: discovery enqueues exactly one walk job per live flow, under a deterministic id -- a second tick for a still-pending flow does not double-enqueue"
        status: pass
    human_judgment: false
  - id: D4
    description: "Discovery's cross-workspace scan role visibility unchanged (T-12-06-01) -- every per-flow read/write re-enters tenant-scoped context, cross-tenant enrollment proven independently per workspace"
    requirement: "WRK-06"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts#sweeps live segment-triggered flows across two workspaces and enrolls each workspace's own matching contact only"
        status: pass
    human_judgment: false
  - id: D5
    description: "Checkpoint table (flow_segment_sweep_checkpoint) is fail-closed RLS from birth, grants nothing to the scan role, and registers in the drizzle schema"
    requirement: "WRK-05"
    verification:
      - kind: integration
        ref: "packages/tenant-context/src/__tests__/tenant-context.test.ts#uses one identical predicate across exactly 23 workspace_isolation policies"
        status: pass
      - kind: integration
        ref: "npm run test:migrations (packages/db, 56 tests, includes migrate-from-empty and migrate-incremental applying migration 0053)"
        status: pass
    human_judgment: false
  - id: D6
    description: "Scheduler registration migrated from tickQueue.add({repeat}) to upsertJobScheduler with try/catch/finally and a one-time legacy-repeatable-entry removal"
    requirement: "WRK-06"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/flows/flow-segment-sweep.worker.ts (upsertJobScheduler + removeRepeatable, code inspection -- no dedicated unit test for the registration IIFE itself, matching partition-maintenance.worker.ts's own untested-registration precedent)"
        status: pass
    human_judgment: false

duration: ~75min
completed: 2026-08-10
status: complete
---

# Phase 12 Plan 06: Bounded, Checkpointed, Resumable Segment Sweep Summary

**Split the segment sweep's unbounded per-flow bulk-diff into a discovery/walk pair with a Postgres-backed, transaction-scoped resume checkpoint that resets on completion.**

## Performance

- **Duration:** ~75 min
- **Tasks:** 3
- **Files modified/created:** 17

## Accomplishments

- New `flow_segment_sweep_checkpoint` table (migration 0053): per-flow resume cursor, fail-closed RLS from birth (bare-cast predicate per migration 0044, `TO mega_crm_app`, no grant to `mega_crm_scan`), with a transaction-scoped access module (`loadSweepCheckpoint`/`advanceSweepCheckpoint`/`resetSweepCheckpoint`, all client-first).
- Split `flow-segment-sweep.worker.ts` into discovery-only (cross-workspace scan, unchanged access control, narrowed SELECT to `id`/`workspace_id`) and a new `flow-segment-sweep-flow.worker.ts` holding the bounded per-flow walk: keyset pagination on `contacts.id` (never OFFSET), a per-page statement timeout, a per-job wall-clock budget, and a bounded stale-snapshot cleanup batch loop.
- The walk's "seen" diff is now scoped to the current page's contact ids, closing a SECOND unbounded-memory path the old sweep had (it previously diffed against the flow's entire snapshot).
- Migrated `flow-segment-sweep`'s registration from the old `tickQueue.add({repeat})` form (no `try/finally`, no `queue.close()`, leaked a Redis connection for the process lifetime) to `upsertJobScheduler`, with a one-time removal of the legacy repeatable entry.
- Both new job payloads carry a `schemaVersion` (R-05 deploy-safety contract); an unrecognized version defers rather than throws.
- New `segment-sweep-kill-resume` failure-injection scenario (state-based, mirrors the 11-11-established convention for indistinguishable crash boundaries): proves the checkpoint survives an interruption, resume enrolls the remainder exactly once, the cursor resets on completion, and a contact inserted behind the old cursor position is enrolled by the next walk rather than permanently skipped.
- Wired into `package.json`'s `failure:all` chain and the CI `failure-injection` job.

## Task Commits

1. **Task 1: Checkpoint table, drizzle schema and the transaction-scoped checkpoint module** - `471c86b` (feat)
2. **Task 2: Split discovery from a bounded, resumable per-flow walk** - `4e9f857` (feat)
3. **Task 3: Kill-resume scenario and sweep regression coverage** - `ee11589` (feat)

_No separate plan-metadata commit in worktree mode -- SUMMARY.md is committed by this same executor per the worktree protocol; STATE.md/ROADMAP.md are updated centrally by the orchestrator after the wave completes._

## Files Created/Modified

- `packages/db/migrations/0053_flow_segment_sweep_checkpoint.sql` - New table, fail-closed RLS from birth
- `packages/db/src/schema/flow-segment-sweep-checkpoint.ts` - Drizzle schema module
- `packages/db/src/index.ts` - Registers the new schema module
- `apps/worker/src/queues/flows/flow-segment-sweep-checkpoint.ts` - `loadSweepCheckpoint`/`advanceSweepCheckpoint`/`resetSweepCheckpoint`
- `apps/worker/src/queues/flows/flow-segment-sweep.worker.ts` - Rewritten as discovery-only; `upsertJobScheduler` migration
- `apps/worker/src/queues/flows/flow-segment-sweep-flow.worker.ts` - New bounded per-flow walk worker
- `apps/worker/src/queues/flows/flow-queues.ts` - `flowSegmentSweepFlowQueue` producer
- `apps/worker/src/server.ts` - Registers the new walk worker
- `packages/shared-schemas/src/queues.ts` - `FLOW_SEGMENT_SWEEP_FLOW_QUEUE` + two versioned payload schemas
- `apps/worker/src/queues/__tests__/failure-injection/segment-sweep-kill-resume.test.ts` - New kill-resume scenario
- `apps/worker/src/queues/__tests__/flow-segment-trigger.test.ts` - Existing sweep assertions updated for the split, new dedup-enqueue case
- `apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts` - Cross-tenant sweep proof and worker-family coverage list updated for the split
- `packages/tenant-context/src/__tests__/tenant-context.test.ts` - Policy-count assertion 22 -> 23
- `apps/worker/src/queues/partition-maintenance.worker.ts` - Stale comment correction (flow-segment-sweep no longer on the interval-repeat form)
- `package.json` - `failure:segment-sweep-resume` script
- `.github/workflows/ci.yml` - Corresponding CI step
- `SPECIFICATION.md` - §4.2/4.3 (new table, policy count), §5.1-5.3/5.12 (discovery/walk split, scheduler migration, constants)

## Decisions Made

- Checkpoint is a dedicated Postgres row per flow, committed in the SAME transaction as that page's enrollment work (D-09) -- `job.updateData()` and a bare Redis key were both rejected per the plan's own decision log (lost on flush, not atomic with the page's DB work).
- The cursor resets to `NULL` on reaching a page with zero rows, rather than persisting forever like `recipient-snapshot.ts`'s one-shot `campaigns.snapshot_cursor` -- this sweep is perpetual, and a permanent cursor would silently skip any contact inserted behind it between ticks (D-09/Pitfall 3, the plan's own single most emphasized guard).
- Discovery's SELECT was narrowed to `id`/`workspace_id` only (previously selected the whole flow row) -- the walk job re-derives the flow's current trigger segment/reentry config itself from `flows`, mirroring `campaign-kickoff`'s/`flow-enroll-existing`'s re-derive-from-row convention, so a flow paused between discovery and the walk running is a defensive no-op rather than acting on stale settings.
- `flowSegmentSweepFlowQueue` gets its own `removeOnComplete: true` job options rather than the shared 9-site default (`removeOnComplete: { age: 86400 }`) -- a retained completed job under the deterministic `sweep-${flowId}` id would otherwise shadow the NEXT discovery tick's enqueue for that same flow, the exact CR-01 failure class `FLOW_RUN_ADVANCE_JOB_OPTIONS` already exists to prevent for a different queue.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `negative-cross-tenant-jobs.test.ts`'s sweep cross-tenant proof broke under the discovery/walk split**
- **Found during:** Task 2 (split discovery from the bounded walk)
- **Issue:** This file (not listed in the plan's `files_modified`) calls `runFlowSegmentSweepTick()` directly and immediately asserts on created `flow_runs` -- since discovery no longer sweeps inline, the assertion failed with zero created runs.
- **Fix:** Added a local `runFullSweep()` helper (discovery + direct per-flow walk invocation, mirroring this same file's existing `findDueFlowRunCandidates`/`transitionAndNudge` and `findReconcilableCandidates`/`resolveOneSend` conventions for other scan consumers) and updated the call site.
- **Files modified:** `apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts`
- **Verification:** All 15 tests in the file pass, including the cross-tenant sweep proof.
- **Committed in:** `4e9f857` (Task 2 commit)

**2. [Rule 1 - Bug] Test 5's worker-family coverage meta-test failed on the new `FlowSegmentSweepFlow` registration**
- **Found during:** Task 2 (registering `createFlowSegmentSweepFlowWorker` in `buildWorker()`)
- **Issue:** A meta-test in `negative-cross-tenant-jobs.test.ts` parses `server.ts` for every `create*Worker(` call and requires each family to be either covered by a dedicated proof in that file or explicitly excluded with a reason. The new `FlowSegmentSweepFlow` family was neither.
- **Fix:** Added it to `COVERED_FAMILIES` with a comment pointing at the same describe block that already covers `FlowSegmentSweep`'s discovery half.
- **Files modified:** `apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts`
- **Verification:** The coverage meta-test passes.
- **Committed in:** `4e9f857` (Task 2 commit)

**3. [Rule 1 - Bug] `partition-maintenance.worker.ts`'s header comment became inaccurate**
- **Found during:** Task 2 (migrating `flow-segment-sweep`'s registration to `upsertJobScheduler`)
- **Issue:** That file's own header comment named `flow-segment-sweep.worker.ts` as one of "the four existing tick workers" still on the older interval-repeat registration form -- no longer true once this plan migrated it.
- **Fix:** Corrected the comment to name three workers and note the migration explicitly.
- **Files modified:** `apps/worker/src/queues/partition-maintenance.worker.ts`
- **Verification:** Comment-only change; typecheck/lint pass.
- **Committed in:** `4e9f857` (Task 2 commit)

---

**Total deviations:** 3 auto-fixed (all Rule 1, all directly caused by Task 2's rewrite, all fixed in the same task's commit).
**Impact on plan:** All three are necessary consequences of the discovery/walk split; none represent scope creep beyond making the split's own regression surface pass.

## Issues Encountered

- **`npm run db:migrate` (drizzle-kit CLI) fails in this sandbox even with zero pending migrations.** Reproduced against a fully-migrated dev database (nothing to apply) -- the CLI's `renderWithTask`/hanji progress UI hangs on the "applying migrations..." spinner and exits 1 with no error text on stdout or stderr, regardless of migration content. This is an environment-specific issue (this sandbox runs Node v26.0.0, notably newer than the stack's targeted Node 22 LTS; `drizzle-kit@0.31.10`'s bundled `hanji` terminal-rendering library is the suspect), not a defect in migration `0053`: the exact same SQL applies cleanly via direct `psql` execution, and the migration applies correctly through `packages/db`'s own programmatic test harness (`npm run test:migrations`, 56/56 passing, including `migrate-from-empty.test.ts`/`migrate-incremental.test.ts`, which apply the full migration chain including `0053` via `@mega-crm/test-support`'s `applyRemainingMigrations` -- a different code path than the CLI). Every `apps/worker` test that provisions an ephemeral database (`ensureTestDbMigrated()`) also independently applies migration `0053` successfully -- confirmed by 256/256 `apps/worker` tests passing. Recommend a follow-up quick task to investigate `drizzle-kit`/Node-version compatibility in this environment; not blocking for this plan since the plan's actual `<verify>` intent (the migration applies and is tested) is satisfied by `test:migrations`.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- WRK-05/WRK-06 fully closed: the sweep is bounded, checkpointed, resumable, and its resets are proven by a dedicated failure-injection scenario in CI.
- No blockers for other Phase 12 plans running in the same wave -- this plan's file surface (`flow-segment-sweep*`, `flow-queues.ts`, `server.ts`, `queues.ts`, `SPECIFICATION.md`) overlaps with other Phase 12 plans' likely touch points (`server.ts`, `queue-options.ts`-adjacent files, `SPECIFICATION.md`); expect merge conflicts to resolve at the orchestrator's wave-merge step, not a functional dependency.
- The `db:migrate` CLI environment issue (see Issues Encountered) is worth a follow-up investigation but does not block this plan or the phase -- the migration itself is proven correct through two independent, passing test paths.

---
*Phase: 12-worker-reliability-tenant-fairness*
*Completed: 2026-08-10*
