---
phase: 12-worker-reliability-tenant-fairness
plan: 11
subsystem: infra
tags: [bullmq, ioredis, queue-core, redis, monorepo]

# Dependency graph
requires:
  - phase: 12-worker-reliability-tenant-fairness (plan 02)
    provides: "@mega-crm/queue-core workspace package holding the single connection builder, send-lane timing constants, and retention-parameterised buildJobOptions factory, with the worker-side half of the duplication already collapsed"
provides:
  - "apps/api's five BullMQ producer queues (campaigns, CSV import, events, webhooks, flows) resolve connection options and job options exclusively from @mega-crm/queue-core"
  - "an automated cross-application invariant test guarding all eleven duplication sites (six worker-side, five application-side) against a returning local copy"
affects: [worker-reliability, tenant-fairness, future-queue-additions]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Producer-side BullMQ queues in apps/api build connection options via buildRedisConnectionOptions(env.REDIS_URL) and job options via buildJobOptions(STANDARD_JOB_RETENTION), both imported from @mega-crm/queue-core -- no module declares its own copy of either."
    - "Source-reading invariant test (queue-core-single-definition.test.ts): strips comments with a small string/template-literal-aware state machine, then regex-matches the guarded set's remaining source for an import from the shared package and the absence of a local connection-builder or job-option-literal pattern."

key-files:
  created:
    - apps/worker/src/queues/__tests__/queue-core-single-definition.test.ts
  modified:
    - apps/api/package.json
    - apps/api/src/modules/campaigns/campaign-queues.ts
    - apps/api/src/modules/contacts/imports-csv-queue.ts
    - apps/api/src/modules/events/events-queue.ts
    - apps/api/src/modules/webhooks/enqueue.ts
    - apps/api/src/modules/flows/flow-queues.ts

key-decisions:
  - "The invariant's guarded set is exactly 11 modules (6 worker-side + 5 application-side) -- modules that themselves call buildRedisConnectionOptions or buildJobOptions directly. Modules that only import a send-lane TIMING constant (SEND_LOCK_DURATION_MS, CLAIM_TX_MARGIN_MS, RECORD_TX_MARGIN_MS) -- email-broadcast.worker.ts, email-triggered.worker.ts, tenant-lane-semaphore.ts -- never declared a connection builder or job-option literal of their own and are correctly excluded from this guarded set."
  - "apps/api/src/server.ts's rate-limit Redis client keeps its own maxRetriesPerRequest: 1 and is explicitly, permanently excluded from the consolidation -- it is not a BullMQ connection."

requirements-completed: [WRK-11]

coverage:
  - id: D1
    description: "apps/api's five BullMQ queue modules (campaigns, CSV import, events, webhooks, flows) import their connection builder and job-options factory from @mega-crm/queue-core instead of declaring local copies"
    requirement: "WRK-11"
    verification:
      - kind: unit
        ref: "npx tsc -p apps/api/tsconfig.json --noEmit"
        status: pass
      - kind: unit
        ref: "npm test --workspace=apps/api (385 tests)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Cross-application invariant test proves all 11 guarded modules (6 worker + 5 api) resolve connection/job options from one shared module, and fails loudly if a local copy reappears"
    requirement: "WRK-11"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/queue-core-single-definition.test.ts (36 assertions)"
        status: pass
    human_judgment: false

duration: 35min
completed: 2026-08-10
status: complete
---

# Phase 12 Plan 11: Application-Side Queue-Core Consolidation + Cross-App Invariant Summary

**Repointed apps/api's five BullMQ producer queues at `@mega-crm/queue-core` and landed a source-reading invariant test that pins all 11 duplication sites (6 worker + 5 api) across both processes.**

## Performance

- **Duration:** ~35 min
- **Tasks:** 2
- **Files modified/created:** 7 (6 modified, 1 created)

## Accomplishments

- `apps/api/src/modules/campaigns/campaign-queues.ts`, `contacts/imports-csv-queue.ts`, `events/events-queue.ts`, `webhooks/enqueue.ts`, and `flows/flow-queues.ts` each deleted their local `buildRedisConnectionOptions` function and local job-option object literal, importing `buildRedisConnectionOptions`/`buildJobOptions`/`STANDARD_JOB_RETENTION` from `@mega-crm/queue-core` instead. Every "this duplication is an accepted convention" comment was deleted along with the duplication it described.
- `apps/api/src/server.ts`'s distributed rate-limiter Redis client (deliberately different `maxRetriesPerRequest: 1`, not a BullMQ connection) is byte-for-byte unchanged.
- Landed `apps/worker/src/queues/__tests__/queue-core-single-definition.test.ts`: a source-reading invariant that reads all 11 guarded modules from disk, strips comments with a hand-rolled string/template-literal-aware stripper (so an explanatory comment mentioning "5 attempts" in prose can never fail the gate), and asserts each imports from `@mega-crm/queue-core` and declares neither a local connection-URL-parsing pattern nor a local job-option literal with its own numeric `attempts` count. A dedicated test asserts the explicit, permanent exclusion of `apps/api/src/server.ts`'s non-BullMQ client. A positive-case pair of tests proves `buildJobOptions`/`buildRedisConnectionOptions` return byte-identical results regardless of which "process" calls them.
- Manually verified the gate is load-bearing: temporarily reintroduced `{ attempts: 5, backoff: {...} }` as a real (unused) object literal into `campaign-queues.ts`, re-ran the invariant test, confirmed it failed with the expected assertion message naming the file and the correct remedy, then reverted (confirmed zero diff via `git diff`) before committing.

## Task Commits

1. **Task 1: Repoint the application's five queue modules at the shared package** - `bb8550d` (feat)
2. **Task 2: Cross-application single-definition invariant** - `c1fbda7` (test)

**Plan metadata:** SUMMARY commit (this file) is the final commit for this plan; STATE.md/ROADMAP.md are updated by the orchestrator after all wave agents complete (worktree execution mode).

## Files Created/Modified

- `apps/api/package.json` - adds `@mega-crm/queue-core` to dependencies
- `apps/api/src/modules/campaigns/campaign-queues.ts` - deleted local connection builder + job-options literal, imports from `@mega-crm/queue-core`
- `apps/api/src/modules/contacts/imports-csv-queue.ts` - same
- `apps/api/src/modules/events/events-queue.ts` - same
- `apps/api/src/modules/webhooks/enqueue.ts` - same
- `apps/api/src/modules/flows/flow-queues.ts` - same
- `apps/worker/src/queues/__tests__/queue-core-single-definition.test.ts` - new source-reading invariant covering all 11 guarded modules across both apps

## Decisions Made

- Defined the 11-module guarded set precisely as the modules that themselves call `buildRedisConnectionOptions`/`buildJobOptions` (6 worker-side: `server.ts`, `campaign-broadcast-producer.ts`, `flows/flow-queues.ts`, `send-reconciler.worker.ts`, `campaign-scheduler.worker.ts`, `partition-maintenance.worker.ts`; 5 application-side: this plan's five files) — not every file that merely imports a timing constant from the same package (`email-broadcast.worker.ts`, `email-triggered.worker.ts`, `tenant-lane-semaphore.ts` import only `SEND_LOCK_DURATION_MS`/`CLAIM_TX_MARGIN_MS`/`RECORD_TX_MARGIN_MS` and never declared a connection builder or job-option literal of their own, so they have nothing to guard against re-duplicating).
- Wrote a proper comment-stripping state machine (respecting `'`, `"`, and `` ` `` string/template boundaries) rather than a naive `//`-to-end-of-line regex, because `apps/worker/src/server.ts` contains one legitimate `` `file://${process.argv[1]}` `` template literal that a naive stripper would have truncated mid-line.

## Deviations from Plan

None - plan executed exactly as written. The manual regression-probe verification (reintroduce → confirm fail → revert) specified in Task 2's acceptance criteria was performed as described and left no trace in the final diff.

## Issues Encountered

- The full `npm test --workspace=apps/api` run intermittently failed 3 pre-existing `webhooks-signature.test.ts` assertions that compare absolute BullMQ `waiting` job counts on a real, shared Redis instance across parallel test files (`before`/`after` deltas drift by ±1-2 when other test files enqueue concurrently). Confirmed this is pre-existing test-isolation flakiness unrelated to this plan's change: the file passes 7/7 in isolation, and a second full-suite run passed all 385 tests with zero changes to the source. Out of scope per the deviation rules' scope boundary (not caused by this plan's edits); not fixed.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- WRK-11 is now fully closed: both the worker-side (12-02) and application-side (this plan) halves of the connection/job-option duplication are collapsed into `@mega-crm/queue-core`, and the cross-application invariant test guards both halves against regression.
- No blockers for subsequent Phase 12 plans.

---
*Phase: 12-worker-reliability-tenant-fairness*
*Completed: 2026-08-10*
