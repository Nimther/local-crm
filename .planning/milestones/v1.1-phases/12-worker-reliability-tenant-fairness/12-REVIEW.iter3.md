---
phase: 12-worker-reliability-tenant-fairness
reviewed: 2026-08-11T00:00:00Z
depth: standard
files_reviewed: 73
files_reviewed_list:
  - .github/workflows/ci.yml
  - apps/api/package.json
  - apps/api/src/modules/campaigns/campaign-queues.ts
  - apps/api/src/modules/contacts/imports-csv-queue.ts
  - apps/api/src/modules/events/events-queue.ts
  - apps/api/src/modules/flows/flow-queues.ts
  - apps/api/src/modules/ops/__tests__/dead-letter-watchdog.test.ts
  - apps/api/src/modules/ops/dead-letter-watchdog.ts
  - apps/api/src/modules/webhooks/enqueue.ts
  - apps/api/src/server.ts
  - apps/worker/package.json
  - apps/worker/src/__tests__/graceful-shutdown.test.ts
  - apps/worker/src/queues/__tests__/campaign-scheduler-scan.test.ts
  - apps/worker/src/queues/__tests__/connection.test.ts
  - apps/worker/src/queues/__tests__/dead-letter-writer.test.ts
  - apps/worker/src/queues/__tests__/failed-job-retention.test.ts
  - apps/worker/src/queues/__tests__/failure-injection/rate-limit-429.test.ts
  - apps/worker/src/queues/__tests__/failure-injection/redis-restart.test.ts
  - apps/worker/src/queues/__tests__/failure-injection/segment-sweep-kill-resume.test.ts
  - apps/worker/src/queues/__tests__/failure-injection/tenant-fairness.test.ts
  - apps/worker/src/queues/__tests__/flow-run-advance-integration.test.ts
  - apps/worker/src/queues/__tests__/flow-segment-trigger.test.ts
  - apps/worker/src/queues/__tests__/loadtest/tenant-rps-sustained.test.ts
  - apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts
  - apps/worker/src/queues/__tests__/partition-maintenance.worker.test.ts
  - apps/worker/src/queues/__tests__/queue-core-single-definition.test.ts
  - apps/worker/src/queues/__tests__/scheduler-registration.test.ts
  - apps/worker/src/queues/__tests__/send-timing-invariant.test.ts
  - apps/worker/src/queues/__tests__/shared-error-listener.test.ts
  - apps/worker/src/queues/__tests__/tenant-concurrency-cap.test.ts
  - apps/worker/src/queues/__tests__/tenant-deferral.test.ts
  - apps/worker/src/queues/__tests__/tenant-lane-semaphore.test.ts
  - apps/worker/src/queues/__tests__/worker-autorun-default.test.ts
  - apps/worker/src/queues/analytics-reconciliation.worker.ts
  - apps/worker/src/queues/campaign-broadcast-producer.ts
  - apps/worker/src/queues/campaign-scheduler.worker.ts
  - apps/worker/src/queues/dead-letter/dead-letter-writer.ts
  - apps/worker/src/queues/email-broadcast.worker.ts
  - apps/worker/src/queues/email-triggered.worker.ts
  - apps/worker/src/queues/flows/flow-queues.ts
  - apps/worker/src/queues/flows/flow-reconciliation.worker.ts
  - apps/worker/src/queues/flows/flow-segment-sweep-checkpoint.ts
  - apps/worker/src/queues/flows/flow-segment-sweep-flow.worker.ts
  - apps/worker/src/queues/flows/flow-segment-sweep.worker.ts
  - apps/worker/src/queues/partition-maintenance.worker.ts
  - apps/worker/src/queues/queue-registry.ts
  - apps/worker/src/queues/rate-limiter.ts
  - apps/worker/src/queues/send-dispatch.ts
  - apps/worker/src/queues/send-reconciler.worker.ts
  - apps/worker/src/queues/tenant-deferral.ts
  - apps/worker/src/queues/tenant-lane-semaphore.ts
  - apps/worker/src/server.ts
  - apps/worker/src/shutdown-budget.ts
  - apps/worker/src/test/failure-fixtures.ts
  - apps/worker/src/test/fairness-constants.ts
  - packages/db/migrations/0053_flow_segment_sweep_checkpoint.sql
  - packages/db/migrations/0054_dead_letter_jobs.sql
  - packages/db/migrations/meta/_journal.json
  - packages/db/src/index.ts
  - packages/db/src/schema/dead-letter-jobs.ts
  - packages/db/src/schema/flow-segment-sweep-checkpoint.ts
  - packages/queue-core/package.json
  - packages/queue-core/src/__tests__/connection-error-listener.test.ts
  - packages/queue-core/src/__tests__/error-listeners.test.ts
  - packages/queue-core/src/__tests__/queue-options.test.ts
  - packages/queue-core/src/connection.ts
  - packages/queue-core/src/dead-letter-writer.ts
  - packages/queue-core/src/error-listeners.ts
  - packages/queue-core/src/index.ts
  - packages/queue-core/src/queue-options.ts
  - packages/queue-core/tsconfig.json
  - packages/queue-core/vitest.config.ts
  - packages/shared-schemas/src/queues.ts
  - packages/tenant-context/src/__tests__/tenant-context.test.ts
findings:
  critical: 0
  warning: 0
  info: 1
  total: 1
status: issues_found
---

# Phase 12: Code Review Report

**Reviewed:** 2026-08-11T00:00:00Z
**Depth:** standard
**Files Reviewed:** 73
**Status:** issues_found

## Summary

This is iteration 2 of the fix/re-review loop for this phase. Iteration 1 (see git history of this file) found two issues — WR-01 (missing ioredis `'error'` listeners on two lazily-constructed clients) and IN-01 (stale TDD-red comments in a passing test) — both addressed in commits `33af0a4` and `408f727`. This iteration verifies those two fixes directly and checks for regressions; it does not re-derive the full-phase findings from iteration 1 (already recorded as fixed, and this iteration's `git diff --stat` confirms no other source file changed between iterations).

**WR-01 — verified fixed, both sites.**

- `apps/worker/src/queues/send-dispatch.ts`'s `getDefaultRedisClient()` now attaches `.on("error", ...)` immediately after constructing `defaultRedisClient`, routing through `scrubbedConsole.error` with an identifying message, exactly matching the previous review's suggested fix.
- `packages/queue-core/src/connection.ts`'s `createRedisConnection()` now does the same for the shared BullMQ-adjacent connection used by `apps/worker/src/server.ts`. `@mega-crm/redaction` was already a declared dependency of `packages/queue-core` (`package.json` confirmed), so this isn't a new/undeclared import.
- Confirmed via `grep -rn "new Redis(" apps/worker/src apps/api/src packages` that all three direct `ioredis` construction sites in the codebase (`send-dispatch.ts`, `connection.ts`, and the pre-existing `apps/api/src/server.ts` rate-limit client) now register an error listener — no fourth site was missed.
- A new regression test (`packages/queue-core/src/__tests__/connection-error-listener.test.ts`) proves the `connection.ts` wiring: exactly one `'error'` listener registered, and an emitted error reaches the mocked `scrubbedConsole.error` with the expected message. Ran `packages/queue-core`'s full suite (`npx vitest run` in that package): 3 files, 24 tests, all passing.
- `send-dispatch.ts`'s `getDefaultRedisClient` is not exported and has no equivalent direct regression test proving its own wiring (see IN-01 below) — the fix itself was verified by direct code read, not by a new automated test.
- `tsc --noEmit` on both `apps/worker` and `packages/queue-core` project configs: clean. `eslint` on both changed source files plus the new/edited test files: clean.

**IN-01 — verified fixed, comment-only change.**

- The diff for `apps/worker/src/queues/__tests__/flow-segment-trigger.test.ts` touches only the two stale "RED under current code" comment blocks; the `expect(...)` assertion lines are byte-for-byte unchanged from before the fix.
- Ran the full test file (`flow-segment-trigger.test.ts`): 9/9 passing, confirming the fix introduced no assertion drift.

**Regression scope check.** `git diff --stat cb5e872..HEAD` for source (non-`.planning`) files shows only the four files touched by the two fix commits (`send-dispatch.ts`, `connection.ts`, the new `connection-error-listener.test.ts`, and `flow-segment-trigger.test.ts`'s comments) — no incidental changes elsewhere. Additionally ran `send-dispatch-idempotency.test.ts` and `send-dispatch-durability.test.ts` (the two existing test files exercising `send-dispatch.ts`'s other logic) to check for regressions from the WR-01 edit: 11/11 passing.

One residual gap remains, downgraded from the original WR-01 to an Info item below since the production defect it stemmed from is now closed at both sites — this is a test-coverage nit, not a functional regression.

## Info

### IN-02: `send-dispatch.ts`'s new error-listener wiring has no direct regression test

**File:** `apps/worker/src/queues/send-dispatch.ts:110-128`

**Issue:** The WR-01 fix added a matching regression test for `packages/queue-core/src/connection.ts`'s `createRedisConnection` (`connection-error-listener.test.ts`), but no equivalent test exists for `send-dispatch.ts`'s `getDefaultRedisClient`. That function is module-private (not exported, no reset hook), so it cannot currently be driven directly from a test file; the fix there was verified by direct code inspection in this review, not by an automated assertion. If a future refactor of `send-dispatch.ts` drops or breaks this listener, no test in the suite would catch it — `send-dispatch-idempotency.test.ts` and `send-dispatch-durability.test.ts` both inject their own `deps.redisClient`, bypassing `getDefaultRedisClient()` entirely, and no other test exercises the no-`deps` production path.

**Fix:** Either export `getDefaultRedisClient` (or add a `__resetDefaultRedisClientForTests` hook) so a test can construct it and assert `listenerCount("error") === 1` / that an emitted error reaches `scrubbedConsole.error`, mirroring `connection-error-listener.test.ts`'s pattern; or, if keeping it private is preferred, add a small integration-style test that calls `processSendJob` with `deps = {}` against a fake Redis URL and asserts the singleton's error path fires. Low priority — the production gap this stemmed from is closed at both sites and confirmed by direct read.

---

_Reviewed: 2026-08-11T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
