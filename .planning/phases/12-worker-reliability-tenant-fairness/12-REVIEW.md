---
phase: 12-worker-reliability-tenant-fairness
reviewed: 2026-08-11T00:00:00Z
depth: standard
files_reviewed: 3
files_reviewed_list:
  - apps/worker/src/queues/__tests__/campaign-scheduler-scan.test.ts
  - apps/worker/src/queues/__tests__/worker-autorun-default.test.ts
  - apps/worker/src/test/failure-fixtures.ts
findings:
  critical: 0
  warning: 3
  info: 3
  total: 6
status: issues_found
---

# Phase 12: Code Review Report

**Reviewed:** 2026-08-11T00:00:00Z
**Depth:** standard
**Files Reviewed:** 3
**Status:** issues_found

## Scope note

This report is scoped to plan 12-14 (gap closure for UAT gap G-12-3), commits `07c7205`, `28b99e2`, `2fb8142` on top of `f9a44c1`. It overwrites the prior `12-REVIEW.md` at this path (git history preserves that earlier report, which covered plans 12-12/12-13). Per the reviewing instructions, findings are drawn from these three files' **current** contents, not restricted to the 12-14 diff hunks alone — `worker-autorun-default.test.ts` in particular contains code untouched by 12-14 that was flagged in the prior review round and never fixed; those items are carried forward below (renumbered) since they remain true of the file as it stands today, alongside new findings specific to this round's changes.

As instructed: the burst-absorption test's kickoff-queue assertion (`kickoffTotal` summed across `waiting/active/delayed/completed/failed`, `worker-autorun-default.test.ts:331-337` and `:376-382`) is **not** re-flagged — it correctly replaces the prior review's vacuous `WR-03` with a non-vacuous, seeded-data assertion, backed by a genuine control case (`:405-461`) proving the assertion actually discriminates dedup-worked from nothing-happened.

## Summary

`campaign-scheduler-scan.test.ts` was rewritten to import `seedDueCampaign`/`readDueCampaignState` from `failure-fixtures.ts` instead of defining local copies; I diffed it against the pre-gap-closure version and confirmed the migrated SQL is byte-for-byte unchanged — no regression there. `failure-fixtures.ts` gained two new exports (`seedDueCampaign`, `readDueCampaignState`) that both `campaign-scheduler-scan.test.ts` and `worker-autorun-default.test.ts` now share, closing the "third copy" drift risk the file's own header warns about. `worker-autorun-default.test.ts`'s burst-absorption case now seeds one real due campaign and asserts a non-vacuous dedup outcome (both on the initial burst and on a subsequent re-check tick), plus an honest zero-campaign control case — this is a real strengthening of the regression guard for G-12-1/G-12-3.

Two issues from the prior review round (`WR-01`/`WR-02` in the superseded report, re-numbered below) remain present and unaddressed in the untouched parts of `worker-autorun-default.test.ts` — the `describe.each` loop-running case and the standalone pickup-probe case still leak `campaign-scheduler`'s long-lived kickoff producer `Queue`, and the pickup-probe test still has no explicit `testTimeout` despite doing real DB-backed work. One new issue was introduced in this round: `readDueCampaignState`'s declared return type promises a non-optional object while its implementation can silently return `undefined`, unlike every sibling reader in the same file. No critical/security findings.

## Warnings

### WR-01: `campaign-scheduler`'s kickoff producer queue is still leaked by two test cases (carried forward, unaddressed)

**File:** `apps/worker/src/queues/__tests__/worker-autorun-default.test.ts:186-209` (the `describe.each(FIXTURES)` case, for the `"campaign-scheduler"` fixture) and `:211-239` (the pickup-probe test)

**Issue:** `createCampaignSchedulerWorker` constructs a long-lived kickoff producer `Queue<CampaignKickoffJob>` internally (`campaign-scheduler.worker.ts:189-194`, registered via `registerTrackedQueue`, by design not closed by `worker.close()` — that queue's lifecycle is tied to process-wide shutdown, not this worker's). Both of these test cases close only `worker` and `queue`:

```ts
} finally {
  await worker.close();
  await queue.close();
}
```

Neither retrieves nor closes the kickoff queue via `getCampaignSchedulerKickoffQueueForTest(worker)`, even though that helper is already imported into this file and used correctly by the burst-absorption and control cases later in the same file (`:283-292`, `:412-423`). Each test's `TempRedis` instance is killed via SIGTERM in `afterEach` (confirmed in `packages/test-support/src/harness/temp-redis.ts:stop()` — it only terminates the server process, it has no knowledge of client-side ioredis connections), so the leaked kickoff-queue's ioredis client is left retrying against a now-dead port indefinitely for the rest of the process lifetime. This was identified as a plausible contributor to an observed full-suite flake in the prior review round and was not fixed by this gap-closure diff (`git diff f9a44c1..HEAD` touches neither of these two blocks).

**Fix:**
```ts
// describe.each case (only campaign-scheduler produces one; optional chaining
// makes this a no-op for the other four fixtures):
} finally {
  await worker.close();
  await queue.close();
  await getCampaignSchedulerKickoffQueueForTest(worker)?.close();
}

// pickup-probe test:
} finally {
  await worker.close();
  await queue.close();
  await getCampaignSchedulerKickoffQueueForTest(worker)?.close();
}
```

### WR-02: Pickup-probe test has no explicit timeout despite real DB-backed work (carried forward, unaddressed)

**File:** `apps/worker/src/queues/__tests__/worker-autorun-default.test.ts:211-239`

**Issue:** This test waits on a real `active` event from a worker whose processor calls `findDueCampaignCandidates()` (a real database round-trip) and relies on vitest's default 20s `testTimeout` (`apps/worker/vitest.config.ts:31`). The prior review round observed this specific test time out once in three full-suite runs. The burst-absorption test in this same file was given an explicit `30_000` timeout as part of this gap-closure round (`:393`) precisely because it now does comparable real DB + Redis work — the pickup-probe test does the same class of work but was not given the same treatment.

**Fix:** Pass an explicit timeout longer than the 20s default, e.g. `it("...", async () => { ... }, 30_000);`, consistent with the treatment the burst test just received in this same diff.

### WR-03: `readDueCampaignState` can return `undefined` despite a non-optional declared return type

**File:** `apps/worker/src/test/failure-fixtures.ts:303-316`

**Issue:**
```ts
export async function readDueCampaignState(
  workspaceId: string,
  campaignId: string,
): Promise<{ status: string; sendingStartedAt: Date | null }> {
  return withTenant(workspaceId, () =>
    withTenantTransaction(async (client) => {
      const { rows } = await client.query<{ status: string; sendingStartedAt: Date | null }>(
        `SELECT status, sending_started_at as "sendingStartedAt" FROM campaigns WHERE id = $1`,
        [campaignId],
      );
      return rows[0];
    }),
  );
}
```
`rows[0]` is `undefined` when no row matches `campaignId` (or when it's scoped to the wrong `workspaceId` under RLS), but the function's declared return type claims a guaranteed non-optional object. The project's `tsconfig.base.json` does not set `noUncheckedIndexedAccess`, so this type lie compiles cleanly, and a caller doing `(await readDueCampaignState(...)).status` on a bad id gets a runtime `TypeError: Cannot read properties of undefined` at the call site rather than a clear, attributable failure. This is inconsistent with sibling helpers in the same file: `sendsStatusFor` (`:178-192`) correctly declares `Promise<string | undefined>` and uses `rows[0]?.status`, and `arrangeCrashedBeforeResultWrite` (`:244-263`) explicitly throws a named error when its own row lookup comes back empty. `readDueCampaignState` is a new export in this diff and is now called from two files (`campaign-scheduler-scan.test.ts:50-51`, `worker-autorun-default.test.ts:343,363`), so a future typo'd `campaignId` in either would fail confusingly rather than loudly.

**Fix:**
```ts
export async function readDueCampaignState(
  workspaceId: string,
  campaignId: string,
): Promise<{ status: string; sendingStartedAt: Date | null }> {
  return withTenant(workspaceId, () =>
    withTenantTransaction(async (client) => {
      const { rows } = await client.query<{ status: string; sendingStartedAt: Date | null }>(
        `SELECT status, sending_started_at as "sendingStartedAt" FROM campaigns WHERE id = $1`,
        [campaignId],
      );
      const row = rows[0];
      if (!row) {
        throw new Error(`readDueCampaignState: no campaign row for workspace=${workspaceId} campaign=${campaignId}`);
      }
      return row;
    }),
  );
}
```

## Info

### IN-01: Unused `queue` handle in the `describe.each` loop-running test (carried forward)

**File:** `apps/worker/src/queues/__tests__/worker-autorun-default.test.ts:186-209`

**Issue:** Each iteration constructs `const queue = new Queue(fixture.tickQueueName, { connection })` (`:190`) but never queries it — the test asserts only `worker.isRunning()` and `fixture.waitForRegistration(worker)`. Harmless, but it's dead weight in all five `describe.each` iterations and slightly obscures that no queue handle is actually needed here.

**Fix:** Drop the unused `queue` construction/close, or use it to assert something (e.g. `queue.getJobSchedulers()` count) so its presence is self-explanatory.

### IN-02: Module-level `authPool` in `failure-fixtures.ts` is never closed

**File:** `apps/worker/src/test/failure-fixtures.ts:38-48`

**Issue:** `getAuthTestPool()` lazily creates a singleton `Pool` and caches it in a module-level `let authPool`, but no function in this file (or, per grep, anywhere in `apps/worker/src`) ever calls `authPool.end()`. This predates the current gap-closure round (10-09), but its reach has grown: `seedDueCampaign` (new in this diff) now routes both `campaign-scheduler-scan.test.ts` and `worker-autorun-default.test.ts` through `insertFixtureOrganization` → `getAuthTestPool()`, so more test files now open this pool without ever closing it. In practice this is reclaimed by process exit at the end of the vitest run and doesn't corrupt test correctness — flagging for visibility, not urgency.

**Fix:** Export a `closeAuthTestPool()` alongside `getAuthTestPool()` and call it from a `globalTeardown`/shared `afterAll`, if/when this becomes a real resource-pressure problem in CI.

### IN-03: Cross-workspace "empty scan" arrange guards are a suite-wide invariant, not a per-test one

**File:** `apps/worker/src/queues/__tests__/worker-autorun-default.test.ts:266`, `:410`

**Issue:** `expect(await findDueCampaignCandidates()).toEqual([])` asserts that **no workspace in the entire ephemeral database** has a due `scheduled` campaign at that instant — not just that this test's own fixtures are clean. `findDueCampaignCandidates()` is a genuinely cross-tenant scan (Phase 10 SEC-01/SEC-02) by design, so this guard is only as reliable as every other test file in the `apps/worker` suite never leaving a `scheduled` campaign with a past `scheduled_at` uncommitted-to-`sending` at the moment these two tests run. Today that holds (grep confirms no other `*.test.ts` file under `apps/worker/src` inserts `status = 'scheduled'`), and the in-file comments show the authors deliberately chose "fail loud here" over "produce a confusing count mismatch elsewhere" as the trade-off. Noting this only so a future test file that seeds a due campaign and fails before transitioning it out of `scheduled` knows this guard is where that leak will surface as an unrelated-looking failure.

**Fix:** No action needed now; if this guard ever starts flaking, the first thing to check is a `scheduled`-status leftover row from a different, unrelated test file rather than a defect in `campaign-scheduler.worker.ts` itself.

---

_Reviewed: 2026-08-11T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
