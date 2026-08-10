---
phase: 12-worker-reliability-tenant-fairness
reviewed: 2026-08-10T00:00:00Z
depth: standard
files_reviewed: 70
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
  warning: 3
  info: 0
  total: 3
status: issues_found
---

# Phase 12: Code Review Report

**Reviewed:** 2026-08-10T00:00:00Z
**Depth:** standard
**Files Reviewed:** 70
**Status:** issues_found

## Summary

Phase 12 consolidates worker reliability primitives (graceful shutdown, shared error/dead-letter listeners, per-tenant RPS + per-tenant-per-lane concurrency fairness, bounded/checkpointed segment sweep, job-scheduler migration off legacy repeatables) into a new `packages/queue-core` package, plus a third operator watchdog (`dead_letter_jobs`). The engineering is careful throughout: every claim in the doc comments (claim-before-SendGrid-call discipline, lane-slot release-on-every-exit-path, checkpoint-in-the-same-transaction-as-enrollment, job-scheduler idempotent re-registration, cross-tenant discovery-then-per-tenant-reverify) is backed by a corresponding test that actually exercises the failure mode described, not just the happy path. I verified the CI wiring (root `package.json` scripts, `npm-workspaces` glob) is intact for every `failure:*`/`coverage` step this phase's CI job invokes — no broken gate.

I did not find any BLOCKER-tier defects (no injection, no auth bypass, no cross-tenant data leak, no data-loss path). I found three WARNING-tier issues: one diagnostic-column bug (a health-snapshot value is silently wrong, though excluded from the alerting logic itself by design), one logging-consistency gap that is new in this phase but mirrors two pre-existing siblings, and one connection-string parsing gap that would break Redis AUTH for any password containing a character requiring percent-encoding.

## Warnings

### WR-01: `dead_letter_alert_state.last_seen_failed_at` is populated with the OLDEST, not the newest, unacknowledged failure

**File:** `apps/api/src/modules/ops/dead-letter-watchdog.ts:193-203` (call site), `apps/api/src/modules/ops/dead-letter-watchdog.ts:72-86` (`readDeadLetterHealth`), `apps/api/src/modules/ops/dead-letter-watchdog.ts:151-168` (`claimDeadLetterAlertSlot`)

**Issue:** `claimDeadLetterAlertSlot`'s own doc comment, its parameter name (`newestFailedAt`), and migration `0054_dead_letter_jobs.sql`'s table comment ("what was the newest failure it had seen at that time") all agree that `dead_letter_alert_state.last_seen_failed_at` should record the MOST RECENT unacknowledged failure's timestamp. But `readDeadLetterHealth` only ever computes `min(failed_at)` (aliased `oldest_failed_at`), and `checkDeadLetterHealthAndAlert` passes that same `snapshot.oldestFailedAt` value straight into the `newestFailedAt` parameter:

```ts
const claimed = await claimDeadLetterAlertSlot(
  deps.client,
  deps.now,
  DEAD_LETTER_ALERT_DEDUP_HOURS,
  snapshot.oldestFailedAt,   // <- oldest, not newest
);
```

There is no code path anywhere in this file that computes a "newest failure" value at all. The stored diagnostic column will always read as the oldest outstanding failure rather than the most recent one — an operator inspecting `dead_letter_alert_state` to answer "is this backlog still growing, or is it stale" gets the wrong signal. This is WARNING, not BLOCKER, because the value is explicitly documented and structurally excluded from the alert-dedup arbiter itself (`claimDeadLetterAlertSlot`'s `WHERE` clause never references `last_seen_failed_at`) — no alerting/dedup behavior is affected, only the diagnostic record. No test in `dead-letter-watchdog.test.ts` reads back the stored `last_seen_failed_at` value, which is why this went unnoticed (test 5 only checks the alert *text*, which correctly uses `oldestFailedAt` for its own, different, purpose).

**Fix:** Add a `max(failed_at)` to the health query and thread it through as its own field, distinct from `oldestFailedAt`:

```ts
// readDeadLetterHealth
const { rows } = await client.query<RawDeadLetterHealthRow>(
  `SELECT count(*)::int AS unacknowledged_count,
          array_remove(array_agg(DISTINCT queue_name), NULL) AS queue_names,
          min(failed_at) AS oldest_failed_at,
          max(failed_at) AS newest_failed_at
     FROM dead_letter_jobs
    WHERE acknowledged_at IS NULL`,
);
// ...
return {
  unacknowledgedCount: row ? Number(row.unacknowledged_count) : 0,
  queueNames: row?.queue_names ?? [],
  oldestFailedAt: row?.oldest_failed_at ?? null,
  newestFailedAt: row?.newest_failed_at ?? null,
};

// checkDeadLetterHealthAndAlert
const claimed = await claimDeadLetterAlertSlot(
  deps.client,
  deps.now,
  DEAD_LETTER_ALERT_DEDUP_HOURS,
  snapshot.newestFailedAt,
);
```

Add a test asserting the persisted `dead_letter_alert_state.last_seen_failed_at` column value after a check with rows at two different `failed_at` timestamps, so this cannot silently regress again.

---

### WR-02: `startDeadLetterWatchdog`'s interval-check catch logs through raw `console.error`, bypassing the redaction convention this module otherwise follows

**File:** `apps/api/src/modules/ops/dead-letter-watchdog.ts:237-241`

**Issue:**

```ts
export function startDeadLetterWatchdog(deps: StartDeadLetterWatchdogDeps): NodeJS.Timeout {
  return setInterval(() => {
    void checkDeadLetterHealthAndAlert({ ...deps, now: new Date() }).catch((err: unknown) => {
      console.error("dead-letter-watchdog: health check failed", err);
    });
  }, DEAD_LETTER_WATCHDOG_INTERVAL_MS);
}
```

This is a wholly new file in this phase (242 lines added, per `git diff --stat`), and every other file this phase touches or introduces (`packages/queue-core/src/error-listeners.ts`, `packages/queue-core/src/dead-letter-writer.ts`, `apps/worker/src/queues/queue-registry.ts`, `apps/worker/src/server.ts`, `apps/worker/src/queues/partition-maintenance.worker.ts`, etc.) routes every log line through `scrubbedConsole` from `@mega-crm/redaction` specifically so an error object that happens to carry a raw email address, API key fragment, or SQL parameter never lands in plain logs. This module's own header comment is explicit about caring about exactly this ("the alert body is deliberately never includes any job payload field... keeping it free of job data means the mail carries nothing that would ever need redacting"), which makes the raw `console.error` here a visible gap in an otherwise redaction-conscious file: a rejected `checkDeadLetterHealthAndAlert` call (a DB error, or a `sendMail` rejection whose message could echo request data) is logged unscrubbed.

This exact pattern already exists in this module's two named siblings — `apps/api/src/modules/ops/partition-watchdog.ts:263` and `apps/api/src/modules/ops/send-reconciler-watchdog.ts:291` both use `console.error(...)` in the identical position — so this is a pre-existing gap being extended to a third watchdog rather than a net-new defect. It is still worth fixing now (and in the two siblings) before a fourth watchdog copies the same pattern again.

**Fix:** Import and use `scrubbedConsole` for consistency with the rest of the codebase this phase touches:

```ts
import { scrubbedConsole } from "@mega-crm/redaction";
// ...
export function startDeadLetterWatchdog(deps: StartDeadLetterWatchdogDeps): NodeJS.Timeout {
  return setInterval(() => {
    void checkDeadLetterHealthAndAlert({ ...deps, now: new Date() }).catch((err: unknown) => {
      scrubbedConsole.error("dead-letter-watchdog: health check failed", err);
    });
  }, DEAD_LETTER_WATCHDOG_INTERVAL_MS);
}
```

Note this also requires updating `apps/api/src/modules/ops/__tests__/dead-letter-watchdog.test.ts`'s "test 10" (`startDeadLetterWatchdog`), which currently asserts on `vi.spyOn(console, "error")` directly — that assertion would need to move to whatever `scrubbedConsole.error` delegates to (or spy on `scrubbedConsole` itself).

---

### WR-03: `buildRedisConnectionOptions` passes the URL's username/password through without percent-decoding

**File:** `packages/queue-core/src/connection.ts:11-23`

**Issue:**

```ts
export function buildRedisConnectionOptions(redisUrl: string): RedisOptions {
  const url = new URL(redisUrl);
  const db = url.pathname && url.pathname !== "/" ? Number(url.pathname.slice(1)) : undefined;

  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    username: url.username || undefined,
    password: url.password || undefined,
    db,
    maxRetriesPerRequest: null,
  };
}
```

The WHATWG `URL` object's `.username`/`.password` getters return the **percent-encoded** form of the credential, not the decoded original. Any Redis password containing a character that must be percent-encoded in a URL (`@`, `:`, `/`, `%`, space, etc. — exactly the characters a generated secret is likely to contain) comes back from `url.password` still encoded:

```
$ node -e "console.log(new URL('redis://user:p%40ss@host').password)"
p%40ss
```

`ioredis` uses `options.password` verbatim in its `AUTH` command — it does not decode it. So a real production `REDIS_URL` with an encoded special character in the password causes every BullMQ `Queue`/`Worker` connection built through this function (which is now, per this phase's own WRK-11 consolidation, the SOLE connection-options builder for both `apps/api` and `apps/worker`) to fail Redis authentication at boot. This is not hypothetical: this exact function is also used by `apps/api/src/server.ts`'s non-BullMQ rate-limit client... no — that client is explicitly excluded from this builder (see `queue-core-single-definition.test.ts`'s own carve-out) — but every other Redis connection in both processes goes through this one function, so the blast radius on a real deploy with such a password is total send-pipeline failure, not a single queue.

It fails loudly (an AUTH error at boot, not silent data corruption), which is why this is WARNING rather than BLOCKER, but the existing test coverage (`packages/queue-core/src/__tests__/queue-options.test.ts` and `apps/worker/src/queues/__tests__/connection.test.ts`) only exercises a plain `user:pass` with no characters requiring encoding, so the gap is untested and would only surface against a real secret in a real environment.

**Fix:**

```ts
export function buildRedisConnectionOptions(redisUrl: string): RedisOptions {
  const url = new URL(redisUrl);
  const db = url.pathname && url.pathname !== "/" ? Number(url.pathname.slice(1)) : undefined;

  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db,
    maxRetriesPerRequest: null,
  };
}
```

Add a test case with a password containing an encoded reserved character (e.g. `redis://user:p%40ss@host:6379/1`) asserting `options.password === "p@ss"`.

---

_Reviewed: 2026-08-10T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
