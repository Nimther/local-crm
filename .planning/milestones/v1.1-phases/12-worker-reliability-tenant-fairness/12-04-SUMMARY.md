---
phase: 12-worker-reliability-tenant-fairness
plan: 04
subsystem: infra
tags: [bullmq, redis, ioredis, worker, send-dispatch, tenant-fairness, concurrency]

# Dependency graph
requires:
  - phase: 12-worker-reliability-tenant-fairness
    provides: "12-01's deferForTenantBucket/tenant_bucket deferral path, 12-02's per-lane worker fairness groundwork, 12-03's tenant-lane-semaphore.ts primitive (acquireTenantLaneSlot/releaseTenantLaneSlot/resolveTenantLaneCap/SEND_SLOT_LEASE_TTL_MS)"
provides:
  - "laneForSendJobKind(kind) helper in send-dispatch.ts deriving broadcast/triggered lane from job kind"
  - "tenant-lane concurrency slot acquired/released around all three SendGrid dispatch paths (campaign, test, flow)"
  - "over-cap sends defer through the existing tenant_bucket deferral path instead of failing or stalling"
  - "SPECIFICATION.md SS5.5 documentation of the concurrency cap's key shape, defaults, overrides and lease TTL"
affects: [12-worker-reliability-tenant-fairness, send-dispatch, worker-reliability]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Lane-slot acquire immediately after the dispatch claim is destructured, before the RPS check -- an over-cap send releases its claim and returns the same {outcome:'rate_limited', cause:'tenant_bucket'} shape an over-RPS send returns, so the worker wrapper's existing deferral branch handles both triggers with zero new code."
    - "Everything from the RPS check through the terminal ledger write, and every return in that span, wrapped in try/finally with the lane-slot release in finally (never catch) -- covers success, provider rejection, 4xx failure, thrown sendMail, and RPS deferral as five distinct exits from one release site per branch."
    - "Deterministic concurrency-cap test fixtures: pre-acquire the lane's slots directly through the semaphore module before calling processSendJob, instead of racing real parallel sends against timing."

key-files:
  created:
    - apps/worker/src/queues/__tests__/tenant-concurrency-cap.test.ts
  modified:
    - apps/worker/src/queues/send-dispatch.ts
    - SPECIFICATION.md

key-decisions:
  - "The lane is derived purely from the job's kind (laneForSendJobKind), never taken as a separate argument -- campaign/test always map to the broadcast lane and flow always maps to the triggered lane, regardless of which physical BullMQ queue delivered the job, so a job payload can never select a different lane's slot pool (T-12-04-03)."
  - "The concurrency-cap key (tenant+lane) is deliberately different from the RPS-bucket key (tenant only): the RPS ceiling models the tenant's single shared SendGrid account, while slot occupancy is a worker-capacity-fairness concern that is naturally per-lane."

requirements-completed: [WRK-02]

coverage:
  - id: D1
    description: "Campaign, test and flow dispatch paths each acquire a tenant-lane concurrency slot before calling SendGrid and release it in a finally spanning every exit"
    requirement: "WRK-02"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/tenant-concurrency-cap.test.ts"
        status: pass
      - kind: integration
        ref: "npm test --workspace=apps/worker (296 passed, no regression)"
        status: pass
    human_judgment: false
  - id: D2
    description: "An over-cap send defers through the same tenant_bucket path an over-RPS send uses, releasing its dispatch claim first, and never strands a send row in 'dispatching'"
    requirement: "WRK-02"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/tenant-concurrency-cap.test.ts#over-cap defers through the tenant_bucket path, never fails"
        status: pass
    human_judgment: false
  - id: D3
    description: "SPECIFICATION.md documents the per-tenant-per-lane concurrency cap's key shape, per-lane defaults, environment overrides and lease TTL, distinguishing its key from the RPS ceiling's"
    verification:
      - kind: other
        ref: "SPECIFICATION.md SS5.5, new paragraph after the throttling paragraph"
        status: pass
    human_judgment: false

# Metrics
duration: ~25min
completed: 2026-08-10
status: complete
---

# Phase 12 Plan 04: Wire the tenant-lane concurrency cap into send-dispatch Summary

**Acquire/release a per-tenant-per-lane Redis semaphore slot around all three SendGrid dispatch branches in `send-dispatch.ts`, so an over-cap send defers through the existing `tenant_bucket` path instead of failing or letting one tenant monopolize worker slots.**

## Performance

- **Duration:** ~25 min
- **Tasks:** 2 completed
- **Files modified:** 2 modified (`send-dispatch.ts`, `SPECIFICATION.md`), 1 created (test file)

## Accomplishments

- `laneForSendJobKind(kind)` derives the broadcast/triggered lane from the job's validated `kind`, never from a separate caller-supplied argument.
- All three dispatch branches (campaign, test, flow) in `processSendJob`/`processFlowSendJob` acquire a lane slot via `acquireTenantLaneSlot` before the per-tenant RPS check, and release it via `releaseTenantLaneSlot` in a `finally` covering every exit — success, provider rejection (429/5xx), permanent 4xx failure, a thrown `sendMail`, and RPS deferral.
- An over-cap campaign or flow send releases its already-committed dispatch claim (mirroring the existing over-RPS release) before returning `{outcome: "rate_limited", cause: "tenant_bucket"}` — the exact same shape and cause the worker wrapper's existing deferral branch already handles, so no worker-wrapper code changed.
- An over-cap test send returns the same rate-limited shape directly (no dispatch claim exists on that path, per D-12).
- A new integration test (`tenant-concurrency-cap.test.ts`) proves all eight behaviors from the plan's `<behavior>` block deterministically, by pre-acquiring the lane's slots directly through the semaphore module rather than racing real concurrent sends.
- `SPECIFICATION.md` §5.5 gained a new paragraph documenting the cap's key shape (`tenant-lane-sem:{workspaceId}:{lane}`), per-lane defaults (broadcast:3/triggered:12), environment overrides, lease TTL derivation, and why its key is deliberately different from the RPS bucket's tenant-only key.

## Task Commits

Each task was committed atomically:

1. **Task 1: Acquire and release a lane slot around every SendGrid dispatch** - `818b857` (feat)
2. **Task 2: Concurrency-cap integration test** - `106833d` (test)

**Plan metadata:** committed alongside this SUMMARY (see below)

## Files Created/Modified

- `apps/worker/src/queues/send-dispatch.ts` - Added `laneForSendJobKind` and wired `acquireTenantLaneSlot`/`releaseTenantLaneSlot` into the campaign, test and flow dispatch branches
- `apps/worker/src/queues/__tests__/tenant-concurrency-cap.test.ts` - New integration test covering deferral, release-on-every-path, and cross-tenant isolation
- `SPECIFICATION.md` - New paragraph in §5.5 documenting the concurrency cap

## Decisions Made

- The lane is a pure function of the job's `kind` (`laneForSendJobKind`), never a separate argument, so a job payload can never select a different lane's slot pool (T-12-04-03, mitigated in the threat model as an Elevation of Privilege concern).
- The concurrency-cap's Redis key intentionally differs from the RPS-bucket's key: RPS is keyed on `workspaceId` alone (one SendGrid account per tenant), while the concurrency cap is keyed on `workspaceId` + `lane` (worker-capacity fairness is inherently per-lane, per 12-03's D-02).
- Chose `try { ... } finally { release }` spanning the RPS check through the terminal ledger write (rather than a release call duplicated at each return site) so the slot's release can never be forgotten at a future return site added to any of the three branches.

## Deviations from Plan

None - plan executed exactly as written. Both tasks' `<action>` and `<behavior>` requirements were implemented literally: the lane-derivation helper, the three-part acquire/guard/finally-release pattern on each dispatch branch, and the SPECIFICATION.md update.

## Issues Encountered

None. Full worker test suite (`npm test --workspace=apps/worker`) passed at 296/296 (up from 287/287 pre-plan, +9 new tests), `npx tsc -p apps/worker/tsconfig.json --noEmit` passed cleanly, and `npm run failure:429` (the pre-existing deferral-path regression check named in the plan's overall `<verification>`) passed at 5/5.

## User Setup Required

None - no external service configuration required. The two new environment overrides (`TENANT_LANE_CONCURRENCY_BROADCAST`/`TENANT_LANE_CONCURRENCY_TRIGGERED`) were already introduced by 12-03 and merely consumed here; both are optional with versioned defaults (3/12).

## Next Phase Readiness

- WRK-02 (per-tenant concurrency cap) is now fully wired end-to-end: the primitive (12-03) is consumed by every dispatch path (12-04).
- No blockers for subsequent plans in this phase. Any future plan touching `send-dispatch.ts`'s three branches should preserve the `try { rate-check → dispatch → terminal write } finally { releaseTenantLaneSlot }` shape established here.

---
*Phase: 12-worker-reliability-tenant-fairness*
*Completed: 2026-08-10*

## Self-Check: PASSED

- `apps/worker/src/queues/send-dispatch.ts` - FOUND
- `apps/worker/src/queues/__tests__/tenant-concurrency-cap.test.ts` - FOUND
- `SPECIFICATION.md` - FOUND
- `.planning/phases/12-worker-reliability-tenant-fairness/12-04-SUMMARY.md` - FOUND
- Commit `818b857` (Task 1) - FOUND in git log
- Commit `106833d` (Task 2) - FOUND in git log
- Commit `a222965` (plan metadata) - FOUND in git log
