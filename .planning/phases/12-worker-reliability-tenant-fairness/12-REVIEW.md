---
phase: 12-worker-reliability-tenant-fairness
reviewed: 2026-08-11T00:00:00Z
depth: standard
files_reviewed: 6
files_reviewed_list:
  - apps/worker/src/queues/__tests__/worker-autorun-default.test.ts
  - apps/worker/src/queues/analytics-reconciliation.worker.ts
  - apps/worker/src/queues/campaign-scheduler.worker.ts
  - apps/worker/src/queues/flows/flow-reconciliation.worker.ts
  - apps/worker/src/queues/partition-maintenance.worker.ts
  - apps/worker/src/queues/send-reconciler.worker.ts
findings:
  critical: 0
  warning: 3
  info: 2
  total: 5
status: issues_found
---

# Phase 12: Code Review Report

**Reviewed:** 2026-08-11T00:00:00Z
**Depth:** standard
**Files Reviewed:** 6
**Status:** issues_found

## Scope note

This report is **scoped to gap-closure plans 12-12/12-13** (UAT gap G-12-1), not the full Phase 12 diff. A prior `12-REVIEW.md` already exists at this path (git history, iteration 3, `status: clean`, 70 files) covering the broader phase as it stood on 2026-08-10; this report **overwrites** that file per the reviewer's `review_path` config, and its content is preserved in git history if needed. The six files here are exactly the files gap-closure plans 12-12/12-13 touched: five worker factories (one-line `autorun` fix each, applied identically) plus one new test file that reproduces the bug and locks in the fix.

## Summary

I read all six files in full, diffed them against `323051a` (pre-gap-closure) to isolate the actual change, cross-checked the fix against BullMQ's own source (`node_modules/bullmq/dist/cjs/classes/worker.js`) to confirm the described defect mechanism and the fix's correctness, confirmed the five call sites in `apps/worker/src/server.ts` really do use the single-argument call shape the new test claims to reproduce, ran `tsc --noEmit` (clean) and `eslint` (clean) on all six files, and ran the new test file both in isolation (8/8 pass, 3 consecutive full-suite runs: 1 flake / 2 clean).

**The production fix itself is correct.** All five factories now use `{ connection, ...(options.autorun !== undefined ? { autorun: options.autorun } : {}) }`, applied identically. I verified against BullMQ's actual constructor (`Object.assign(Object.assign({ ...defaults, autorun: true, ... }, opts), { blockingConnection: true })`) that an own `autorun: undefined` property on `opts` really does clobber the default via `Object.assign`'s own-property-wins semantics, and that omitting the key entirely (via the conditional spread) is the correct fix — not a nullish-coalescing default, which the code comments correctly reject as "a second source of truth." No stray occurrences of the old `autorun: options.autorun` pattern remain anywhere in `apps/worker/src`.

**The issues found are all in the new test file**, not in the five production fixes:

1. Two of the new test cases leak `campaign-scheduler`'s long-lived kickoff producer queue, which is a very plausible contributor to a full-suite-run flake I observed empirically.
2. The one test asserting an actual job reaches `'active'` (not just `isRunning() === true`) flaked once in three full-suite runs.
3. The burst test's "without duplicated kickoff work" assertion is vacuously true given the test's own data setup, independent of whether the fix actually prevents duplication.

None of these affect the correctness of the shipped `autorun` fix — the fix is independently verifiable by reading BullMQ's source, and 4/5 workers' loop-start behavior is covered by a passing `isRunning()` assertion regardless of the issues below. They are test-reliability/coverage-quality issues in the regression guard itself, which matters more than usual here since this guard exists specifically to catch a *silent* stall (the original bug produced no error, no log — only `isRunning() === false` and a growing backlog).

## Warnings

### WR-01: Two new test cases leak `campaign-scheduler`'s kickoff producer queue — plausible cause of an observed full-suite flake

**File:** `apps/worker/src/queues/__tests__/worker-autorun-default.test.ts:181-204` and `:206-234`

**Issue:** `createCampaignSchedulerWorker` constructs a long-lived kickoff producer `Queue<CampaignKickoffJob>` via `registerTrackedQueue(...)` (see `campaign-scheduler.worker.ts:189-194`). That registry is only drained by `apps/worker/src/server.ts`'s process-wide shutdown path (`queue-registry.ts`) — `worker.close()` does **not** close it, by design (it's a producer, not the worker's own queue). The test file's own burst test (lines 255-320) correctly accounts for this: it retrieves the kickoff queue via `getCampaignSchedulerKickoffQueueForTest(...)` and explicitly closes both `kickoffQueue` and `drainKickoffQueue` in its `finally` (lines 311-319).

The other two `campaign-scheduler` cases do not do this:

- The `describe.each(FIXTURES)` case (for the `"campaign-scheduler"` fixture) closes only `worker` and `queue` (lines 199-202).
- The dedicated pickup test closes only `worker` and `queue` (lines 230-233).

Both leave `createCampaignSchedulerWorker`'s kickoff `Queue` (and its underlying ioredis client) open and pointed at that test's per-test `TempRedis` instance, which `afterEach` (line 177-179) then stops out from under it. An open ioredis client whose server just vanished retries reconnecting indefinitely by default.

I ran this test file as part of the full `apps/worker` suite three times. The first run failed with the pickup test timing out, and its stderr was flooded with dozens of identical `Error: connect ECONNREFUSED 127.0.0.1:<port>` traces attributed to that exact test name — consistent with a leaked client from an *earlier* iteration of this same `describe.each`/pickup pair still retrying against a since-stopped Redis port while a later test in the same file is trying to make real progress. The next two full-suite runs passed cleanly. This is circumstantial, not a proven root cause (see WR-02), but it is a real, confirmed leak regardless of whether it's the sole cause of the flake, and the burst test in the same file demonstrates the author already knew the correct cleanup shape.

**Fix:** Close the kickoff queue in both finally blocks, mirroring the burst test:
```ts
// describe.each case (fixture-generic — only applies when fixture.label === "campaign-scheduler",
// or just always attempt-and-ignore via optional chaining since other fixtures have none):
} finally {
  await worker.close();
  await queue.close();
  await getCampaignSchedulerKickoffQueueForTest(worker)?.close();
}

// pickup test:
} finally {
  await worker.close();
  await queue.close();
  await getCampaignSchedulerKickoffQueueForTest(worker)?.close();
}
```
`getCampaignSchedulerKickoffQueueForTest` is already imported in this file for the burst test, so this needs no new import.

### WR-02: The one "job actually gets picked up" regression test is flaky under full-suite load

**File:** `apps/worker/src/queues/__tests__/worker-autorun-default.test.ts:206-234`

**Issue:** Of the six new test cases, only this one (`campaign-scheduler: a job sitting on its tick queue is picked up and reaches 'active' on a production-shape worker`) proves the fix's actual payoff — a queued job gets consumed — for any of the five workers; the other four rely solely on `worker.isRunning() === true` via `vi.waitFor` in the `describe.each` block. Running the full `apps/worker` suite (`npx vitest run src/queues`, 60 files / 394 tests) three times back-to-back:

- Run 1: this test failed with `Error: Test timed out in 20000ms` waiting on `activePromise` (the job never reached `'active'` within vitest's default 20s test timeout).
- Runs 2 and 3: all 394 tests passed, including this one.

This is the regression guard for a bug whose defining symptom was silence (no error, no log, just a run loop that never starts) — a guard for that class of bug that itself fails via silent timeout under load is a weaker signal than it looks. WR-01's kickoff-queue leak is a plausible contributing factor (a pool of leaked, endlessly-reconnecting ioredis clients from earlier tests in the same run degrading Redis-adjacent responsiveness for later ones), but three runs is too small a sample to confirm causation, and I have not proven it.

**Fix:** Fix WR-01 first (it's a genuine leak regardless), then re-run the full suite a handful of times to see if the flake persists. Independently of that, this test has no explicit `testTimeout` override despite doing real work (constructing a worker, a real DB-backed processor, waiting on an event) — pass an explicit timeout longer than vitest's 20s default (e.g., `it("...", async () => { ... }, 30_000)`) so a slow-but-healthy full-suite run doesn't get misclassified as a stalled run loop.

### WR-03: Burst test's "without duplicated kickoff work" claim is vacuously true, not actually exercised

**File:** `apps/worker/src/queues/__tests__/worker-autorun-default.test.ts:255-320`

**Issue:** This test's name and final assertion (`expect(kickoffCounts).toMatchObject({ waiting: 0, active: 0, delayed: 0, completed: 0, failed: 0 })`, lines 303-310) claim to verify that draining an accumulated 20-job tick backlog does not produce duplicated kickoff work. But the ephemeral test database seeded by `ensureTestDbMigrated()` has no `campaigns` rows at all, so `findDueCampaignCandidates()` (`campaign-scheduler.worker.ts:59-67`) returns `[]` on every single one of the 20+ ticks the burst produces — the kickoff queue would read exactly the same all-zero counts whether or not the fix (or the underlying `transitionToSending`/`jobId: campaignId` dedup logic it exercises) worked at all. The in-file comment at lines 296-301 is honest about this ("this run's ephemeral test database has no campaign rows... the kickoff producer queue never receives a single job — burst or no burst"), so this isn't a hidden gap, but the test's own name and the surrounding docstring (lines 81-117) present the "no duplicated downstream effect" claim as something this test demonstrates, which it does not: it demonstrates only that a burst drains to zero on the *tick* queue, and that a data-less scan produces a data-less kickoff queue — both true regardless of dedup correctness.

**Fix:** Either (a) seed at least one `scheduled` campaign whose `scheduled_at` is in the past before running the burst, and then assert the kickoff queue's `completed` count is exactly 1 (not 0) despite 20+ ticks scanning it, which would actually exercise the `jobId: campaignId` dedup path; or (b) rename the test and adjust its docstring to claim only what it proves (tick-queue drain to zero, no crash, no error state) and drop the "without duplicated kickoff work" framing.

## Info

### IN-01: `send-reconciler.worker.ts` has no immediate boot-time job, unlike its four siblings (pre-existing, out of scope for this gap-closure diff)

**File:** `apps/worker/src/queues/send-reconciler.worker.ts:435-451`

**Issue:** `createAnalyticsReconciliationWorker`, `createCampaignSchedulerWorker`, `createFlowReconciliationWorker`, and `createPartitionMaintenanceWorker` all call both `queue.upsertJobScheduler(...)` **and** `queue.add(JOB_NAME, {}, { ...DEFAULT_JOB_OPTIONS, jobId: bootJobId })` in their registration IIFE, so a fresh boot gets an immediate first run rather than waiting for the first scheduled tick. `createSendReconcilerWorker`'s registration IIFE (lines 435-451) only calls `queue.upsertJobScheduler(...)` — there is no boot-time `queue.add(...)` call, so after a fresh boot the first reconciler tick does not run until BullMQ's job scheduler fires its first `every: RECONCILER_TICK_MS` (5 minute) occurrence. This line was **not touched** by this gap-closure diff (`git diff 323051a..HEAD` shows only the `autorun` line and the new `waitForSendReconcilerRegistration`/`registrationSettled` addition changed in this file), and the new test file's own docstring (lines 82-117) already acknowledges this asymmetry explicitly ("kept enqueuing on schedule... for four of the five, their per-boot immediate job"). Flagging for visibility only — not a regression introduced by this change, and not something plans 12-12/12-13 were scoped to fix.

**Fix (if picked up in a future plan, not this one):** Add the same `await queue.add(JOB_NAME, {}, { ...DEFAULT_JOB_OPTIONS, jobId: bootJobId })` immediate-run call this file's four siblings already use, for consistent restart-repair latency across all five tick workers.

### IN-02: Unused `queue` handle in the `describe.each` isRunning test

**File:** `apps/worker/src/queues/__tests__/worker-autorun-default.test.ts:181-204`

**Issue:** Each iteration constructs `const queue = new Queue(fixture.tickQueueName, { connection })` (line 185) but never calls anything on it beyond `queue.close()` in the `finally` (line 201) — it contributes nothing to the assertions in this test (which only check `worker.isRunning()` and `fixture.waitForRegistration(worker)`). Harmless (BullMQ workers already implicitly attach to their queue), but it is dead weight in every one of the five `describe.each` iterations and slightly obscures that this test needs no queue handle of its own at all.

**Fix:** Either drop the unused `queue` construction/close entirely, or use it for something the test actually asserts on (e.g., confirming the queue's own job-scheduler count via `queue.getJobSchedulers()`), so a future reader isn't left wondering what it's for.

---

_Reviewed: 2026-08-11T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
