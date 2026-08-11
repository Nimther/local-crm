---
phase: 12-worker-reliability-tenant-fairness
reviewed: 2026-08-11T00:00:00Z
depth: standard
files_reviewed: 75
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
  - apps/worker/src/queues/__tests__/send-dispatch-error-listener.test.ts
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
  info: 0
  total: 0
status: clean
---

# Phase 12: Code Review Report

**Reviewed:** 2026-08-11T00:00:00Z
**Depth:** standard
**Files Reviewed:** 75
**Status:** clean

## Summary

This is iteration 3 (final) of the fix/re-review loop for this phase. Iterations 1 and 2 found three issues total — WR-01 (missing ioredis `'error'` listeners on two lazily-constructed clients), IN-01 (stale TDD-red comments in a passing test), and IN-02 (no direct regression test for `send-dispatch.ts`'s half of the WR-01 fix, since `getDefaultRedisClient` was module-private) — all three now fixed across commits `33af0a4`, `408f727`, and `5f6e0b3`. This iteration verifies the IN-02 fix specifically and re-checks the whole phase for regressions; it does not re-derive the full-phase findings from iterations 1/2, which are already recorded as fixed.

**IN-02 — verified fixed, correctly implemented.**

- `apps/worker/src/queues/send-dispatch.ts`'s `getDefaultRedisClient` is now `export`ed (was module-private), with no change to its production behavior or call site (`processSendJob`'s `deps.redisClient ?? getDefaultRedisClient()` is untouched).
- A new `export function __resetDefaultRedisClientForTests(): void` clears the module-level singleton reference; it is not called from any production code path (confirmed by `grep -rn "getDefaultRedisClient\|__resetDefaultRedisClientForTests"` across `apps/` and `packages/` — the only non-declaration references are the one production call site and the new test file).
- The new test file, `apps/worker/src/queues/__tests__/send-dispatch-error-listener.test.ts`, mirrors `connection-error-listener.test.ts`'s emit-based proof pattern exactly: mocks `@mega-crm/redaction`'s `scrubbedConsole`, then asserts (a) exactly one `'error'` listener is registered on the singleton, (b) repeated calls return the same instance until reset, and (c) an emitted error reaches `scrubbedConsole.error` with the exact production message. Verified the `.emit("error", ...)` call in the test exercises real `EventEmitter` listener dispatch, not ioredis's internal `silentEmit` fallback (`node_modules/ioredis/built/Redis.js:530-554` — `silentEmit` and `emit` are separate methods; the fallback that prints `"[ioredis] Unhandled error event"` only fires from `silentEmit`, never from a direct `.emit()` call), so the assertion is a true proof of the production listener firing, not an artifact of the test's own plumbing.
- `afterEach` calls `getDefaultRedisClient()` again (to get the just-constructed client), `client.disconnect()`, then `__resetDefaultRedisClientForTests()` — correctly tears down the real socket the test opened (via the live `REDIS_URL` `apps/worker/vitest.config.ts` sets for the whole suite, `redis://localhost:6379/1` by default) and prevents cross-test/cross-file singleton leakage. Confirmed no dangling-connection warnings in the test run's output.
- Ran the new test file directly: 3/3 passing, no stray console output.

**Regression scope check.**

- `git diff --stat cb5e872..5f6e0b3` (current `HEAD`) for source (non-`.planning`) files shows exactly the five files touched across all three fix commits (`send-dispatch.ts`, `connection.ts`, `flow-segment-trigger.test.ts`'s comments, and the two new test files `connection-error-listener.test.ts` / `send-dispatch-error-listener.test.ts`) — no incidental changes elsewhere, and `git status` confirms the working tree matches `5f6e0b3` exactly (no uncommitted source drift).
- Ran the full sibling trio for `send-dispatch.ts` (`send-dispatch-idempotency.test.ts`, `send-dispatch-durability.test.ts`, `send-dispatch-error-listener.test.ts`): 14/14 passing.
- Ran the entire `apps/worker/src/queues` suite (61 files) to bound regression risk beyond the immediately-adjacent tests: 398/398 passing.
- Ran `packages/queue-core`'s full suite: 24/24 passing (unchanged from iteration 2 — nothing in this iteration touched that package).
- `tsc --noEmit -p apps/worker/tsconfig.json`: clean. `eslint` on both the modified source file and the new test file: clean (no naming-convention complaint about the leading-underscore export, matching the fixer's own claim).

**Non-issues considered and dismissed** (documented so a future reviewer doesn't re-raise them): the new test constructs its client against the live `REDIS_URL` the suite already provisions, rather than the sibling `connection-error-listener.test.ts`'s deliberately-unreachable `127.0.0.1:65535` — this is not a defect, since every assertion in the file is connection-state-independent (`listenerCount`, instance identity, a synthetically-`emit`ted error), `REDIS_URL` is guaranteed present by `apps/worker/vitest.config.ts`, and CI already provisions a live Redis for this exact reason (`.github/workflows/ci.yml`'s `test` job). Likewise, exporting a test-only `getDefaultRedisClient`/`__resetDefaultRedisClientForTests` pair is exactly the option iteration 2's own IN-02 finding proposed as the preferred fix, not a new concern introduced by this iteration.

No new findings. All three findings from prior iterations are closed with no regressions detected.

---

_Reviewed: 2026-08-11T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
