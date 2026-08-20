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
  warning: 1
  info: 1
  total: 2
status: issues_found
---

# Phase 12: Code Review Report

**Reviewed:** 2026-08-11T00:00:00Z
**Depth:** standard
**Files Reviewed:** 73
**Status:** issues_found

## Summary

Phase 12 (worker reliability & tenant fairness) is unusually thorough: every source file carries load-bearing rationale comments, the failure-injection/negative-cross-tenant/fairness test suites are extensive, and several findings from prior review iterations (visible in comments referencing "12-REVIEW.md iteration 2, IN-02", CR-03, CR-04, WR-01, WR-03 etc.) have already been fixed and are now pinned by regression tests. The tenant-lane semaphore, tenant-scoped RPS limiter, dead-letter pipeline, and scheduler-registration migration are all internally consistent and cross-checked by tests that assert against the real exported constants rather than restated literals.

Two of the module's own lazily-constructed `ioredis` clients (the shared worker-process connection in `apps/worker/src/server.ts`, and the rate-limiter/semaphore client in `apps/worker/src/queues/send-dispatch.ts`) never register an `'error'` listener, unlike every other long-lived Postgres `Pool` and the API's own rate-limiter Redis client in this same codebase, which is the same crash class the phase's own `partition-maintenance.worker.ts`/`dead-letter-writer.ts` comments explicitly defend against for `pg.Pool`. Empirically verified against the installed `ioredis@5.11.0`: an unhandled `'error'` event on a client with zero listeners does **not** crash the process (ioredis has its own internal fallback that logs `"[ioredis] Unhandled error event: ..."` and continues) — so this is a pattern inconsistency and an observability gap (the error bypasses this codebase's `scrubbedConsole` redaction wrapper and is invisible to every other logging/alerting path), not a proven process-crash. Recorded as a Warning below, not a Blocker.

A secondary, cosmetic issue was found in a pre-existing (Phase 6) test file that Phase 12's segment-sweep rewrite now exercises: stale "RED under current code" comments that no longer match the (passing) assertions they annotate.

## Warnings

### WR-01: Worker-side ioredis clients have no `'error'` listener — errors bypass the codebase's logging/redaction convention

**File:** `apps/worker/src/queues/send-dispatch.ts:110-119` (also `apps/worker/src/server.ts:153`, via `packages/queue-core/src/connection.ts:55-57`)

**Issue:**

`getDefaultRedisClient()` in `send-dispatch.ts` lazily constructs the singleton `ioredis` client used by **every** production call to `processSendJob` for the per-tenant RPS token bucket (`rate-limiter.ts`) and the tenant-lane semaphore (`tenant-lane-semaphore.ts`) — both `email-broadcast.worker.ts` and `email-triggered.worker.ts` call their handlers with `deps = {}`, so `deps.redisClient ?? getDefaultRedisClient()` resolves to this module-level client in every real deployment:

```ts
let defaultRedisClient: Redis | null = null;

function getDefaultRedisClient(): Redis {
  if (!defaultRedisClient) {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      throw new Error("REDIS_URL is required for apps/worker's send-dispatch rate limiter");
    }
    defaultRedisClient = new Redis(redisUrl);
  }
  return defaultRedisClient;
}
```

No `.on("error", ...)` is ever attached to `defaultRedisClient`. `apps/worker/src/server.ts`'s own shared connection (`createRedisConnection(redisUrl)`, `packages/queue-core/src/connection.ts`) has the identical gap.

Verified empirically against the exact installed version (`ioredis@5.11.0`, matching `apps/worker/package.json`): a connection error on a client with zero `'error'` listeners does **not** throw/crash the process — ioredis 5.x's own client-level fallback intercepts it and prints `"[ioredis] Unhandled error event: <err>"` directly to `console`, then continues retrying. So this is **not** the process-crash scenario the codebase's own `pool.on("error", ...)` comments describe for `pg.Pool` (those really do crash on an unhandled `'error'`, since `pg.Pool` has no equivalent internal fallback) — but it is still a real, confirmed gap:

1. **It bypasses `scrubbedConsole`.** Every other error path in this codebase — `worker.on("error", ...)` (`packages/queue-core/src/error-listeners.ts`), every dedicated `pg.Pool`'s `.on("error", ...)`, `apps/api/src/server.ts`'s `rateLimitRedis.on("error", ...)` — routes through `scrubbedConsole.error(...)` so a leaked credential or contact address in an error message is redacted before it reaches logs. ioredis's own built-in fallback logs via raw `console.error`, unredacted, unlabeled, and untestable by this codebase's own conventions.
2. **It is invisible to operators.** Every other connection-error path in this file's own review scope is deliberately loud and consistent ("without this listener, an idle-connection termination surfaces as an uncaught 'error' event and crashes the whole apps/worker process" — the stated rationale in `partition-maintenance.worker.ts`/`dead-letter/dead-letter-writer.ts`). This client's failures instead show up only as an ad hoc `[ioredis] Unhandled error event` line an operator has to know to grep for, with no queue name, no correlation to the rate limiter/semaphore it backs, and no `dead_letter_jobs`/watchdog visibility.
3. **It is untested.** `failure-injection/redis-restart.test.ts` exercises a plain `Queue`/`Worker` pair whose connection is BullMQ-internal (BullMQ manages its own reconnection/error handling for that), never `getDefaultRedisClient()`'s client or `server.ts`'s shared `connection`; every test in `tenant-lane-semaphore.test.ts`, `tenant-concurrency-cap.test.ts`, and the fairness suite injects its own `redisClient` via `deps`, bypassing this code path entirely.

**Fix:**

```ts
// apps/worker/src/queues/send-dispatch.ts
function getDefaultRedisClient(): Redis {
  if (!defaultRedisClient) {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      throw new Error("REDIS_URL is required for apps/worker's send-dispatch rate limiter");
    }
    defaultRedisClient = new Redis(redisUrl);
    defaultRedisClient.on("error", (err) => {
      scrubbedConsole.error("send-dispatch: default rate-limiter/semaphore Redis client error", err);
    });
  }
  return defaultRedisClient;
}
```

```ts
// packages/queue-core/src/connection.ts
export function createRedisConnection(redisUrl: string): Redis {
  const client = new Redis(buildRedisConnectionOptions(redisUrl));
  client.on("error", (err) => {
    scrubbedConsole.error("queue-core: shared ioredis connection error", err);
  });
  return client;
}
```
(`connection.ts` would need to import `scrubbedConsole` from `@mega-crm/redaction`, already a dependency of `packages/queue-core`.) Add a regression test mirroring the existing `pool.on("error", ...)` proofs: emit `"error"` on the constructed client and assert it routes through `scrubbedConsole.error`, the same way `shared-error-listener.test.ts` and `error-listeners.test.ts` already prove for `worker.on("error", ...)`.

## Info

### IN-01: Stale "RED under current code" comments no longer match the (passing) assertions they annotate

**File:** `apps/worker/src/queues/__tests__/flow-segment-trigger.test.ts:472-474, 479-481`

**Issue:** The test "06-19/WR-04/FLOW-04: a contact who leaves the trigger segment (sweep-detected) and rejoins re-enters..." carries two comments claiming the test is currently failing under a known-bad implementation:

```ts
// RED under current code: the snapshot row is never cleared on segment
// exit, so this stays true instead of false.
expect(await getSnapshotSeen(...)).toBe(false);
...
// RED under current code: the rejoin never re-enters, so this stays at
// length 1 instead of 2.
expect(await getRunsForContact(...)).toHaveLength(2);
```

The assertions themselves already expect the *fixed* behavior (`false`, length `2`), and Phase 12's rewritten `flow-segment-sweep-flow.worker.ts` implements exactly that fix via `drainStaleSnapshotBatches`/`deleteStaleSnapshotBatch`, which anti-joins and deletes a flow's stale `flow_segment_membership_snapshot` rows for contacts no longer matching the trigger segment before every page loop runs. Given the phase's stated verification result (16/16 passing), this test passes today — the "RED under current code" comments are leftover TDD-red documentation that was never updated once the fix landed.

**Risk:** A future maintainer who sees a regression here (e.g. someone modifies `drainStaleSnapshotBatches` and only skims the comment, not the assertion) could "fix" it by reverting the assertions to match the stale comment instead of investigating the actual regression, silently reintroducing the FLOW-04 leave/rejoin bug this test exists to catch.

**Fix:** Update the two comments to state the current, passing expectation (e.g. "the sweep's stale-snapshot cleanup clears this on segment exit, so a rejoin re-enters") and drop the "RED under current code" framing now that the fix is in place.

---

_Reviewed: 2026-08-11T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
