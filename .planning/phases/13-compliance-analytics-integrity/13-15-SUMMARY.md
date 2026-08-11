---
phase: 13-compliance-analytics-integrity
plan: 15
subsystem: infra
tags: [bullmq, redis, postgres, rls, worker, compliance, erasure]

# Dependency graph
requires:
  - phase: 13-compliance-analytics-integrity
    provides: "plan 13-10's commit-then-enqueue erasure ordering, erasure_records schema/cursors, and the injectable enqueueErasureScrub seam; plan 13-13's erasure-scrub worker and its already-complete idempotency check"
provides:
  - "A scheduled reclaim tick (erasure-scrub-reclaim.worker.ts) that finds erasure_records rows stranded pending/scrubbing past a 15-minute lease and re-enqueues their scrub through the shared job-id derivation"
  - "A failure-injection scenario proving the crash-in-the-gap recovery end to end (commit -> injected enqueue failure -> reclaim tick -> processed scrub -> complete)"
affects: [phase-13-remaining-plans, spec-13-14]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Second producer of an existing queue reuses the first producer's exported payload/job-id builders rather than re-deriving them (mirrors buildWebhookEventsJobPayload's 13-01 precedent for ERASURE_SCRUB_QUEUE)"
    - "Reclaim/reconcile tick shape: upsertJobScheduler + immediate boot job + try/catch/finally self-closing registration queue, enumerate workspaces via withCrossWorkspaceScan (organization only), then withTenant/withTenantTransaction per workspace"

key-files:
  created:
    - apps/worker/src/queues/erasure-scrub-reclaim.worker.ts
    - apps/worker/src/queues/__tests__/erasure-scrub-reclaim.test.ts
    - apps/worker/src/queues/__tests__/failure-injection/erasure-enqueue-crash.test.ts
  modified:
    - packages/shared-schemas/src/queues.ts
    - apps/worker/src/queues/queue-registry.ts
    - apps/worker/src/server.ts
    - apps/worker/src/queues/__tests__/scheduler-registration.test.ts
    - apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts
    - package.json

key-decisions:
  - "ERASURE_SCRUB_RECLAIM_LEASE_MINUTES left at the reasoned default of 15 -- plan 13-13's SUMMARY records no per-page scrub timing measurement (500-row pages, no wall-clock duration noted), so there is no observed data forcing the lease upward; the value is unchanged from the plan's own recommendation."
  - "The commit-to-enqueue failure was injected via apps/api's own DeleteContactDeps.enqueueErasureScrub seam (13-10's deliverable), imported directly from apps/worker's test file through the @mega-crm/api devDependency -- the seam required no change; a test-only cross-app import, already an established convention in this codebase (send-reconciler-health.test.ts, webhook-events-unsubscribe-convergence.test.ts)."
  - "ERASURE_SCRUB_RECLAIM_PAGE_LIMIT = 100 per workspace per tick (plan's own recommendation, unchanged)."

patterns-established:
  - "Reclaim tick over a durable outbox row (erasure_records): findReclaimableErasureRecords(client, leaseMinutes, limit) is a pure, RLS-scoped query with no explicit workspace_id parameter, mirroring findDirtyRollupDays's convention -- callers open their own withTenant scope."

requirements-completed: [CMP-04]

coverage:
  - id: D1
    description: "A pending erasure_records row aged past the lease threshold is found and re-enqueued by a scheduled reclaim tick"
    requirement: "CMP-04"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/erasure-scrub-reclaim.test.ts#a pending record aged past the lease threshold is enqueued exactly once, with the erasure record's own id as the payload"
        status: pass
    human_judgment: false
  - id: D2
    description: "A pending record inside the lease, a scrubbing record inside its lease, a complete record, and a failed record are never reclaimed"
    requirement: "CMP-04"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/erasure-scrub-reclaim.test.ts (pending-fresh / scrubbing-fresh / complete / failed cases)"
        status: pass
    human_judgment: false
  - id: D3
    description: "A scrubbing record past its lease is reclaimed (worker-death-mid-scrub recovery)"
    requirement: "CMP-04"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/erasure-scrub-reclaim.test.ts#a scrubbing record whose scrub_started_at is past the lease is enqueued exactly once"
        status: pass
    human_judgment: false
  - id: D4
    description: "A reclaim of an already-queued record collides on the shared job-id derivation instead of duplicating the scrub"
    requirement: "CMP-04"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/erasure-scrub-reclaim.test.ts#two consecutive reclaim ticks over one stranded record leave exactly one job in the scrub queue"
        status: pass
    human_judgment: false
  - id: D5
    description: "The reclaim tick is cross-tenant via withCrossWorkspaceScan (organization only) with every erasure-record read inside its own workspace's withTenant scope, and introduces no new grant/policy"
    requirement: "CMP-04"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/erasure-scrub-reclaim.test.ts#the only statement inside withCrossWorkspaceScan reads organization (source-level check); #reclaimable records in two different workspaces are both found by one tick"
        status: pass
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts (Test 5 coverage gate, ErasureScrubReclaim entry)"
        status: pass
    human_judgment: false
  - id: D6
    description: "The tick is registered exactly once at every worker boot (stable scheduler id), and a per-workspace enqueue failure does not abort remaining workspaces"
    requirement: "CMP-04"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/scheduler-registration.test.ts#erasure-scrub-reclaim scheduler (CMP-04, plan 13-15)"
        status: pass
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/erasure-scrub-reclaim.test.ts#a tick whose enqueue rejects for one workspace still processes the remaining workspaces and does not throw out of the tick"
        status: pass
    human_judgment: false
  - id: D7
    description: "A crash strictly between deleteContact's transaction commit and the erasure-scrub enqueue is recovered end to end: stranded pending record -> one reclaim tick -> job processed to complete with the linked send_events payload actually scrubbed -> a second tick enqueues nothing"
    requirement: "CMP-04"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/failure-injection/erasure-enqueue-crash.test.ts#a crash strictly between deleteContact's commit and the enqueue call is recovered end to end by one reclaim tick"
        status: pass
      - kind: other
        ref: "npm run failure:erasure-enqueue-crash"
        status: pass
    human_judgment: false

duration: 55min
completed: 2026-08-12
status: complete
---

# Phase 13 Plan 15: Erasure-Scrub Reclaim Tick Summary

**Scheduled 5-minute BullMQ tick that finds `erasure_records` rows stranded `pending`/`scrubbing` past a 15-minute lease and re-enqueues their scrub through the same `buildErasureScrubJobPayload`/`buildErasureScrubJobId` derivation the request path uses, closing the last durability gap in CMP-04 (a crash between the erasure transaction's commit and the scrub enqueue).**

## Performance

- **Duration:** ~55 min
- **Tasks:** 2
- **Files modified:** 9 (3 created, 6 modified)

## Accomplishments

- `erasure-scrub-reclaim.worker.ts`: a repeatable tick (`upsertJobScheduler`, stable id `erasure-scrub-reclaim-tick`, 5-minute interval) that enumerates workspaces via `withCrossWorkspaceScan` (reading only `organization`, already scan-granted by migration 0042), then under each workspace's own `withTenant` scope finds `pending`/`scrubbing` `erasure_records` rows whose `requested_at`/`scrub_started_at` is past `ERASURE_SCRUB_RECLAIM_LEASE_MINUTES` (15) and re-enqueues one scrub job per record, bounded to `ERASURE_SCRUB_RECLAIM_PAGE_LIMIT` (100) per workspace per tick.
- Both producers of `ERASURE_SCRUB_QUEUE` (plan 13-10's `deleteContact` and this tick) build the job through the SAME exported `buildErasureScrubJobPayload`/`buildErasureScrubJobId` from `@mega-crm/shared-schemas` -- confirmed by a test asserting the enqueued `jobId` against the function's own output, not a literal, so a reclaim of an already-queued record collides on the deterministic id instead of duplicating the scrub.
- `complete` records are never reclaimed at any age; `failed` records are excluded and left untouched (`scrub_error` unmodified) -- the reclaimer treats `failed` as a terminal, operator-visible outcome it must not loop on.
- A per-workspace enqueue/query failure is caught and logged so it never aborts the tick's remaining workspaces.
- Registered in `apps/worker/src/server.ts`'s `buildWorker` array; constructing the worker twice registers exactly one scheduler (proven in `scheduler-registration.test.ts`'s new describe block, deliberately opposite of the neighbouring `erasure-scrub` block which registers no scheduler at all).
- `erasure-enqueue-crash.test.ts` (registered as `npm run failure:erasure-enqueue-crash`, joined into `failure:all`) drives the full crash-in-the-gap recovery: injects a throw at `contact.repository.ts`'s `enqueueErasureScrub` seam strictly between the erasure transaction's commit and the enqueue call, asserts the stranded `pending` record, runs one reclaim tick, asserts the job appears with the correct payload, processes it via `runErasureScrub`, asserts the record reaches `complete` with the linked `send_events` payload no longer carrying the former address, then asserts a second tick enqueues nothing.

## Task Commits

1. **Task 1: Reclaim tick -- find stranded erasure records and re-enqueue their scrub**
   - `54928e3` (test) -- RED: failing test referencing the not-yet-existing worker module
   - `96e04f3` (feat) -- GREEN: `erasure-scrub-reclaim.worker.ts` + `queues.ts` schema addition
   - `73cbb86` (test) -- strengthened the no-side-effects assertion (all four named tables, not just `contacts`) and added a source-level scan-isolation check
2. **Task 2: Register the reclaim tick at worker boot and prove the crash-in-the-gap recovery**
   - `70e3c20` (feat) -- server.ts registration, queue-registry.ts doc addendum, scheduler-registration.test.ts extension, erasure-enqueue-crash.test.ts, package.json failure script, and the negative-cross-tenant-jobs.test.ts coverage-gate fix (see Deviations)

**Plan metadata:** (this commit, docs)

_Note: Task 2's core behavior was already implemented and green from Task 1's commit -- see "TDD Gate Compliance" below._

## Files Created/Modified

- `apps/worker/src/queues/erasure-scrub-reclaim.worker.ts` -- the reclaim tick worker
- `apps/worker/src/queues/__tests__/erasure-scrub-reclaim.test.ts` -- Task 1's behavior suite (16 tests)
- `apps/worker/src/queues/__tests__/failure-injection/erasure-enqueue-crash.test.ts` -- the crash-recovery failure-injection scenario
- `packages/shared-schemas/src/queues.ts` -- `erasureScrubReclaimTickJobSchema` + `ERASURE_SCRUB_RECLAIM_TICK_SCHEMA_VERSION`
- `apps/worker/src/queues/queue-registry.ts` -- doc-comment addendum (no code change)
- `apps/worker/src/server.ts` -- registers `createErasureScrubReclaimWorker` in `buildWorker`'s array
- `apps/worker/src/queues/__tests__/scheduler-registration.test.ts` -- new `erasure-scrub-reclaim scheduler` describe block
- `apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts` -- `ErasureScrubReclaim` added to `COVERED_FAMILIES`
- `package.json` -- `failure:erasure-enqueue-crash` script + `failure:all` entry

## Decisions Made

- **Lease/interval/page-limit final values, unchanged from the plan's own recommendation:** `ERASURE_SCRUB_RECLAIM_INTERVAL_MS = 5 * 60_000`, `ERASURE_SCRUB_RECLAIM_LEASE_MINUTES = 15`, `ERASURE_SCRUB_RECLAIM_PAGE_LIMIT = 100`. Plan 13-13's own SUMMARY does not record a per-page wall-clock timing measurement for its 500-row scrub pages, so there was no observed data to weigh against the 15-minute lease -- it stands as reasoned (an order of magnitude above the normal single-Redis-round-trip commit-to-enqueue gap and above a normal scrub's duration) rather than measured.
- **Failure-injection seam:** used unmodified. Plan 13-10's `contact.repository.ts` already exposes `DeleteContactDeps.enqueueErasureScrub` specifically for this scenario; no change to `apps/api` was needed, honoring the plan's instruction that this file stay outside 13-15's `files_modified`.
- **Cross-app test import confirmed safe:** `apps/api/src/middleware/tenant-context.ts` is a thin re-export of `@mega-crm/tenant-context` (the same package `apps/worker` uses), so calling `withTenant`/`deleteContact` together from a worker test file shares the identical AsyncLocalStorage-scoped context -- no HTTP server or cross-process boundary needed. `apps/api/src/env.ts`'s eager `process.env` validation at import time is satisfied because `apps/worker/vitest.config.ts` loads the same shared external env file (`resolveEnvPath()`) that already carries every var `apps/api`'s schema requires (`AUTH_DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `WEB_URL`, `PLATFORM_SENDGRID_API_KEY`, `PLATFORM_MAIL_FROM`, `OPERATOR_ALERT_EMAIL`) in this local/dev execution; confirmed empirically, not merely assumed.
- **Confirmation for plan 13-14 (SPECIFICATION §5 filing):** both `ERASURE_SCRUB_QUEUE` producers (plan 13-10's `deleteContact` and this reclaim tick) pass the identical `buildErasureScrubJobId(erasureRecordId)` output as `jobId` -- verified by a test comparing against the function's own return value, not a literal. No new queue name beyond `erasure-scrub-reclaim` (the tick's own lane) is introduced onto `ERASURE_SCRUB_QUEUE`'s producer side.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `negative-cross-tenant-jobs.test.ts`'s SEC-16 coverage gate broke once the reclaimer was registered in `server.ts`**
- **Found during:** Task 2
- **Issue:** `negative-cross-tenant-jobs.test.ts` (not in this plan's `files_modified`) has a "Test 5" coverage gate that scans `server.ts` for every `create*Worker(` call and requires each job family to appear in either `COVERED_FAMILIES` or `EXCLUDED_FAMILIES`. Registering `createErasureScrubReclaimWorker` made this gate fail: `ErasureScrubReclaim` was registered but neither covered nor excluded.
- **Fix:** Added an `ErasureScrubReclaim` entry to `COVERED_FAMILIES`, pointing at `erasure-scrub-reclaim.test.ts`'s own "reclaimable records in two different workspaces" case, which already proves the required per-tenant discovery/isolation property (mirrors the existing `ReputationTick` entry's precedent of pointing at coverage in a different file).
- **Files modified:** `apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts`
- **Verification:** `npx vitest run --root apps/worker src/queues/__tests__/negative-cross-tenant-jobs.test.ts` -- Test 5 passes.
- **Committed in:** `70e3c20` (Task 2 commit)

**2. [Rule 1 - Bug] Test fixture's `make_interval` call rejected a `double precision` argument**
- **Found during:** Task 1, first GREEN run
- **Issue:** The test file's `seedErasureRecord` helper cast a nullable minutes-ago override to `::float8` before calling `make_interval(mins => $5)`; Postgres has no `make_interval(mins => double precision)` overload (only `integer`), so 13 of 15 test cases failed with `function make_interval(mins => double precision) does not exist`.
- **Fix:** Cast to `::int` instead of `::float8` for both the `requestedAtMinutesAgo` and `scrubStartedAtMinutesAgo` parameters.
- **Files modified:** `apps/worker/src/queues/__tests__/erasure-scrub-reclaim.test.ts`
- **Verification:** All 15 (then 16, after strengthening) tests pass.
- **Committed in:** `96e04f3` (Task 1 GREEN commit)

---

**Total deviations:** 2 auto-fixed (1 blocking/Rule 3, 1 bug/Rule 1)
**Impact on plan:** Both were necessary to reach a passing test suite. The Rule 3 fix touches a file explicitly outside this plan's declared scope but was required by an existing, unrelated regression gate reacting correctly to a legitimate new job family; no architectural change, no scope creep.

## TDD Gate Compliance

Task 1 followed the standard RED (`54928e3`) -> GREEN (`96e04f3`) sequence, with the RED failure being a genuine `Cannot find module` error (the worker file did not yet exist).

Task 2 is marked `tdd="true"` in the plan, but its underlying behaviors (the scheduler registering correctly, and the crash-in-the-gap recovery working end to end) were ALREADY implemented and proven correct by Task 1's own reclaimer logic and by plan 13-10's pre-existing `enqueueErasureScrub` seam. Writing Task 2's test files (the `scheduler-registration.test.ts` extension and `erasure-enqueue-crash.test.ts`) and running them immediately passed -- there was no artificial failing state to manufacture, and manufacturing one (e.g., by temporarily breaking the already-correct reclaimer) would have tested nothing new. The one genuine RED state Task 2 surfaced was `negative-cross-tenant-jobs.test.ts`'s coverage gate (see Deviations #1), which was confirmed failing before the fix, then fixed in the same commit as the `server.ts` registration that caused it.

## Issues Encountered

None beyond the two auto-fixed deviations above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- CMP-04's durability chain is now closed end to end: `deleteContact`'s commit-then-enqueue ordering (13-10), the checkpointed idempotent scrub (13-13), and this reclaim tick together guarantee a committed erasure eventually reaches `complete` regardless of a crash/Redis-outage/process-kill between the commit and the enqueue.
- Plan 13-14 (SPECIFICATION.md filing) can cite this plan's confirmation that both `ERASURE_SCRUB_QUEUE` producers share `buildErasureScrubJobId`'s output, and that no new grant/policy/environment variable was introduced.
- Known, deliberately out-of-scope gap (recorded in the plan's own `flagged_assumptions`, restated here for visibility): a `failed` erasure record is not surfaced to an operator by any watchdog. Plan 13-11's ingestion-health watchdog covers the webhook ingress journal, not `erasure_records`. An erasure-health watchdog is a natural follow-on, not part of this phase.
- **Out-of-scope, not fixed (pre-existing local environment, not caused by this plan's diff):** `npm run verify:redis-config` fails against this sandbox's local Redis (`maxmemory=0`, `appendonly=no`) -- a `docker/redis.conf` / local-infra concern unrelated to any file this plan touched. Not fixed per the Scope Boundary rule; flagged for the phase's final verification pass.

---
*Phase: 13-compliance-analytics-integrity*
*Completed: 2026-08-12*
