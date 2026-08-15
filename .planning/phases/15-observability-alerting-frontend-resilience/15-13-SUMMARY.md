---
phase: 15-observability-alerting-frontend-resilience
plan: 13
subsystem: api
tags: [bullmq, redis, postgres, watchdog, ops, alerting, rls, scan-role]

requires:
  - phase: 15-observability-alerting-frontend-resilience
    provides: "ops_alert_state (migration 0064) and claimOpsAlertSlot/releaseOpsAlertSlot (plan 15-12) -- the shared keyed alert-dedup primitive both new watchdogs claim against"
provides:
  - "queue-monitor.ts: a read-only BullMQ job-count/oldest-pending-job reader over all 8 monitored send-pipeline lanes, distinguishing unreadable (blind) from empty (healthy) queues"
  - "queue-depth-watchdog.ts: per-lane depth thresholds + evaluateQueueDepthHealth + checkQueueDepthHealthAndAlert, claiming under alert name 'queue-depth'"
  - "oldest-job-age-watchdog.ts: evaluates oldest pending BullMQ job age AND oldest sends.reconciling_since (read via withCrossWorkspaceScan) into one evaluation, claiming under alert name 'oldest-job-age'"
  - "both watchdogs are pure/parameter-driven and NOT yet wired into apps/api/src/server.ts -- that boot wiring is plan 15-14's job"
affects: [15-14]

tech-stack:
  added: []
  patterns:
    - "Read-only monitoring Queue handle alongside a producer's own Queue -- reuse existing handles where they exist, add exactly one new read-only handle for a lane the process never produces onto"
    - "Two-signal-into-one-evaluation alerting: an alert covering multiple root causes (BullMQ job age + reconciling_since age) accumulates all tripped reasons into ONE evaluation so at most one email is ever sent per incident"
    - "Scan-role read / app-role write split for a single watchdog check (mirrors ingestion-health-watchdog.ts): a platform-wide aggregate over an RLS-forced tenant table goes through withCrossWorkspaceScan, while the ops_alert_state claim/release goes through the ordinary app-role pool"

key-files:
  created:
    - apps/api/src/modules/ops/queue-monitor.ts
    - apps/api/src/modules/ops/queue-depth-watchdog.ts
    - apps/api/src/modules/ops/oldest-job-age-watchdog.ts
    - apps/api/src/modules/ops/__tests__/queue-monitor.test.ts
    - apps/api/src/modules/ops/__tests__/queue-depth-watchdog.test.ts
    - apps/api/src/modules/ops/__tests__/oldest-job-age-watchdog.test.ts
  modified:
    - apps/api/src/modules/contacts/contact.repository.ts
    - apps/api/src/server.ts
    - apps/api/src/__tests__/env-schema.test.ts
    - SPECIFICATION.md

key-decisions:
  - "queue-monitor.ts reuses the 7 existing Queue handles apps/api already constructs (erasureScrubQueue exported from contact.repository.ts specifically for this reuse) plus one new read-only handle for email-triggered -- the one lane apps/api never produces onto but must still monitor"
  - "A Redis read failure surfaces as an explicit { readable: false, error } result, never as zero counts -- the distinction the queue-depth and oldest-job-age evaluators both depend on to treat blind-monitor as unhealthy"
  - "Per-lane depth thresholds (8 named constants, each with a rationale comment marked as a first estimate) instead of one global threshold -- the broadcast lane's legitimate steady-state volume is orders of magnitude above the triggered lane's"
  - "RECONCILING_SEND_AGE_ALERT_HOURS=24 is deliberately set strictly below send-reconciler-watchdog.ts's existing RECONCILING_AGE_ALERT_HOURS=30, with a module-load runtime guard enforcing the relationship, so the new live sends-table read surfaces an earlier warning rather than a simultaneous duplicate of the existing worker-health-row-based alert"
  - "oldest-job-age-watchdog.ts's reconciling_since read goes through withCrossWorkspaceScan (mega_crm_scan role, migration 0042's existing sends_scan policy), never a tenant-scoped connection -- sends is RLS-forced and a platform-wide MIN() aggregate cannot be answered any other way; this is the second apps/api file added to env-schema.test.ts's P3 withCrossWorkspaceScan allowlist"
  - "Both watchdogs claim through the SHARED ops_alert_state primitive (plan 15-12) under independent alert names ('queue-depth', 'oldest-job-age') rather than dedicated singleton tables"
  - "Neither watchdog is wired into apps/api/src/server.ts's main() in this plan -- both are pure, parameter-driven modules; the boot-time interval registration is plan 15-14's task, mirroring the 09-01/09-02 precedent for ensurePartitions"

patterns-established:
  - "Queue-metrics reader with an unreadable/empty distinction, shared by multiple independent watchdogs reading the same underlying BullMQ state"

requirements-completed: [OPS-13]

coverage:
  - id: D1
    description: "queue-monitor.ts reads waiting/delayed/active/failed counts and the oldest pending job timestamp for all 8 monitored lanes, distinguishing a Redis-unreadable queue from a genuinely empty one"
    requirement: "OPS-13"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/ops/__tests__/queue-monitor.test.ts (6 tests)"
        status: pass
    human_judgment: false
  - id: D2
    description: "queue-depth-watchdog.ts: a queue over its per-lane threshold is unhealthy naming that queue; exactly-at-threshold is healthy; an unreadable or missing metrics entry is unhealthy; alert deduped via claimOpsAlertSlot; release-on-send-failure restores retryability; alert body carries no workspace id/contact email/send id"
    requirement: "OPS-13"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/ops/__tests__/queue-depth-watchdog.test.ts (10 tests)"
        status: pass
    human_judgment: false
  - id: D3
    description: "oldest-job-age-watchdog.ts: an aged oldest pending BullMQ job AND an aged oldest sends.reconciling_since both accumulate into ONE evaluation and at most one alert; the reconciling_since read is proven against a real seeded row through withCrossWorkspaceScan"
    requirement: "OPS-13"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/ops/__tests__/oldest-job-age-watchdog.test.ts (11 tests)"
        status: pass
    human_judgment: false

duration: 30min
completed: 2026-08-15
status: complete
---

# Phase 15 Plan 13: Queue-depth and oldest-job-age watchdogs Summary

**Two new OPS-13 alerts (queue-depth, oldest-job-age) on a shared read-only BullMQ metrics reader, claiming through plan 15-12's ops_alert_state primitive; neither wired into server.ts yet (plan 15-14's job).**

## Performance

- **Duration:** ~30 min
- **Tasks:** 3 (all TDD: RED test committed and confirmed failing before each implementation)
- **Files modified/created:** 10 (3 new watchdog/reader modules, 3 new test files, 4 modified: contact.repository.ts, server.ts, env-schema.test.ts, SPECIFICATION.md)

## Accomplishments

- `queue-monitor.ts` gives both new watchdogs (and any future OPS-13 consumer) one proven reader over all 8 monitored send-pipeline lanes -- 7 reused `Queue` handles plus one new read-only handle for `email-triggered` -- with a Redis failure surfacing as an explicit unreadable result, never as a healthy-looking zero.
- `queue-depth-watchdog.ts` alerts once per 6h window when any lane's waiting+delayed+active count exceeds its own per-lane threshold (8 named, documented, first-estimate constants), pinned at the exact boundary (`>` unhealthy, `=` healthy) and proven free of any planted workspace id/contact email/send id in its alert body.
- `oldest-job-age-watchdog.ts` closes the gap the roadmap's literal "queries reconciling_since directly" wording would otherwise leave: it evaluates the oldest pending BullMQ job's age (a stalled queue with no reconciling send at all) AND the platform-wide oldest `sends.reconciling_since` (read via `withCrossWorkspaceScan`, since `sends` is RLS-forced) into ONE evaluation, so a send stuck at either stage produces exactly one alert, never two, and never collides with `send-reconciler-watchdog.ts`'s own 30h reconciling-backlog alert (this one fires at 24h, a documented, enforced-at-module-load earlier warning on the same underlying signal).

## Task Commits

Each task followed full RED/GREEN TDD -- a failing test committed and confirmed failing (module not found) before the implementation existed:

1. **Task 1: A read-only queue-metrics reader for the API process**
   - RED: `0ed2ce5` (test) -- confirmed failing (module not found)
   - GREEN: `cfc0f0d` (feat) -- 6/6 tests pass; includes Rule 3 export of `erasureScrubQueue` and Rule 3 wiring of `closeQueueMonitorQueues()` into server.ts's onClose hook
2. **Task 2: Queue-depth watchdog**
   - RED: `08b6c77` (test) -- confirmed failing (module not found)
   - GREEN: `6a0f122` (feat) -- 10/10 tests pass
3. **Task 3: Oldest-job-age watchdog**
   - RED: `339e0d9` (test) -- confirmed failing (module not found)
   - GREEN: `d76acf4` (feat) -- 11/11 tests pass; includes SPECIFICATION.md §5.18 and env-schema.test.ts allowlist update

_No separate plan-metadata commit -- SUMMARY.md is force-added under this worktree's `.planning/` gitignore rules (see below)._

## Files Created/Modified

- `apps/api/src/modules/ops/queue-monitor.ts` - read-only BullMQ metrics reader (`readQueueMetrics`/`readAllQueueMetrics`), the new `emailTriggeredQueue` handle, `closeQueueMonitorQueues()`
- `apps/api/src/modules/ops/queue-depth-watchdog.ts` - per-lane thresholds, `evaluateQueueDepthHealth`, `renderQueueDepthAlertText`, `checkQueueDepthHealthAndAlert`, `startQueueDepthWatchdog`
- `apps/api/src/modules/ops/oldest-job-age-watchdog.ts` - `readOldestReconcilingSince` (scan-role), `evaluateOldestJobAgeHealth`, `renderOldestJobAgeAlertText`, `checkOldestJobAgeHealthAndAlert`, `startOldestJobAgeWatchdog`
- `apps/api/src/modules/contacts/contact.repository.ts` - `erasureScrubQueue` exported (was module-private) so `queue-monitor.ts` can reuse it instead of constructing a duplicate handle
- `apps/api/src/server.ts` - imports and wires `closeQueueMonitorQueues()` into the existing `onClose` hook
- `apps/api/src/__tests__/env-schema.test.ts` - P3 `withCrossWorkspaceScan` allowlist extended to include `oldest-job-age-watchdog.ts` (second permitted apps/api consumer, after `ingestion-health-watchdog.ts`)
- `SPECIFICATION.md` - new §5.18 documenting both watchdogs' names, intervals, thresholds and what each queries, noting neither is wired into `server.ts` yet
- Test files: `apps/api/src/modules/ops/__tests__/queue-monitor.test.ts`, `queue-depth-watchdog.test.ts`, `oldest-job-age-watchdog.test.ts`

## Decisions Made

- `queue-monitor.ts` reuses all 7 existing `apps/api` `Queue` handles rather than constructing duplicates; the one genuinely new handle (`email-triggered`) is read-only and closed via the existing `onClose` hook.
- Per-lane depth thresholds instead of one global number, each documented as a first estimate (FLAGGED ASSUMPTION per 15-13-PLAN.md) to be tuned from real operation.
- `RECONCILING_SEND_AGE_ALERT_HOURS=24` chosen strictly below `send-reconciler-watchdog.ts`'s existing `RECONCILING_AGE_ALERT_HOURS=30`, enforced by a runtime guard at module load, so the two watchdogs' reconciling-age signals cannot fire on the same tick.
- The reconciling_since read uses `withCrossWorkspaceScan` (mega_crm_scan role), mirroring `ingestion-health-watchdog.ts`'s established scan-role/app-role split for exactly the same structural reason (`sends` is RLS-forced; a platform-wide MIN() cannot be answered by a tenant-scoped connection).
- Both watchdogs claim through the shared `ops_alert_state`/`claimOpsAlertSlot` primitive from plan 15-12 under independent alert names, never a dedicated singleton table.
- Neither watchdog is wired into `server.ts`'s `main()` in this plan -- both are pure, parameter-driven modules; the boot-time interval registration is explicitly deferred to plan 15-14 (mirrors the 09-01/09-02 precedent).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Exported `erasureScrubQueue` from `contact.repository.ts`**
- **Found during:** Task 1
- **Issue:** The plan instructs reusing "the seven `Queue` handles apps/api already constructs", but `erasureScrubQueue` was a module-private `const`, unreachable from `queue-monitor.ts` without either exporting it or constructing a second, duplicate `Queue` for the same `ERASURE_SCRUB_QUEUE` name (which the plan explicitly forbids).
- **Fix:** Added `export` to the existing declaration, with a doc-comment explaining why.
- **Files modified:** `apps/api/src/modules/contacts/contact.repository.ts`
- **Verification:** `npx vitest run --root apps/api` -- full suite green, no behavior change (same singleton, same connection).
- **Committed in:** `cfc0f0d` (Task 1 GREEN commit)

**2. [Rule 3 - Blocking] Wired `closeQueueMonitorQueues()` into `server.ts`'s existing `onClose` hook**
- **Found during:** Task 1
- **Issue:** Task 1's own acceptance criterion requires "Any new Queue handle is closed from the API's existing shutdown hook" -- this necessarily touches `server.ts`, which was not in the plan's `files_modified` list for this task.
- **Fix:** Added a second `app.addHook("onClose", ...)` call invoking `closeQueueMonitorQueues()`, alongside the existing `rateLimitRedis.disconnect()` hook.
- **Files modified:** `apps/api/src/server.ts`
- **Verification:** `npx vitest run --root apps/api` -- full suite (508 tests) exits cleanly with no hanging Redis handle.
- **Committed in:** `cfc0f0d` (Task 1 GREEN commit)

**3. [Rule 2 - Missing Critical] Added `apps/api/src/modules/ops/__tests__/queue-monitor.test.ts`**
- **Found during:** Task 1
- **Issue:** Task 1 has `tdd="true"` but the plan's `files_modified` list names no test file for `queue-monitor.ts` itself (only for the two watchdogs).
- **Fix:** Added a dedicated test file exercising `readQueueMetrics`/`readAllQueueMetrics` against fake `QueueMonitorQueueLike` objects, following full RED/GREEN discipline.
- **Files modified:** `apps/api/src/modules/ops/__tests__/queue-monitor.test.ts` (new)
- **Verification:** 6/6 tests pass.
- **Committed in:** `0ed2ce5` (RED) / `cfc0f0d` (GREEN)

**4. [Rule 3 - Blocking] Extended `env-schema.test.ts`'s P3 `withCrossWorkspaceScan` allowlist**
- **Found during:** Task 3
- **Issue:** `oldest-job-age-watchdog.ts`'s `readOldestReconcilingSince` structurally needs `withCrossWorkspaceScan` (same reason `ingestion-health-watchdog.ts` already does), but `env-schema.test.ts`'s existing P3 guard hard-codes a one-file allowlist that would fail on any second consumer.
- **Fix:** Extended the allowlist array and updated the test's own doc comment and assertion message to name both permitted files, mirroring the precedent's own reasoning.
- **Files modified:** `apps/api/src/__tests__/env-schema.test.ts`
- **Verification:** `npx vitest run --root apps/api src/__tests__/env-schema.test.ts` -- passes; full suite still green.
- **Committed in:** `d76acf4` (Task 3 GREEN commit)

---

**Total deviations:** 4 auto-fixed (3 Rule 3 -- blocking gaps directly required by the plan's own acceptance criteria/architecture, 1 Rule 2 -- a test-coverage gap for a `tdd="true"` task).
**Impact on plan:** All four are necessary consequences of completing this plan's own stated tasks and acceptance criteria; none change what the plan asked for.

## Issues Encountered

- **Worktree module-resolution artifact (not a plan defect):** this worktree has no `node_modules` of its own, and `bullmq` is nested (not hoisted) specifically inside `apps/api/node_modules` in the main checkout. Fixed with an untracked, gitignored symlink (`apps/api/node_modules/bullmq -> <main checkout>/apps/api/node_modules/bullmq`) -- same class of fix the 15-12 executor documented for `packages/db`/`apps/worker`.
- **Self-caught bug during Task 3's implementation (never reached a commit):** an early draft of `checkOldestJobAgeHealthAndAlert` bound a local `const readOldestReconcilingSince` whose fallback initializer referenced the SAME identifier (shadowing the module-level import), causing infinite recursion the first time it was invoked -- surfaced as a 20s test hook timeout during development, not as a shipped defect. Fixed by renaming the local binding to `resolveOldestReconcilingSince` before the GREEN commit; caught by this plan's own test suite, not left in the codebase.
- **Full-repo `npm run lint` reports ~300 pre-existing `@typescript-eslint/no-unsafe-*` errors across `apps/worker`, `packages/queue-core`, etc.** -- none in any file this plan touched (confirmed by grepping the full lint output for this plan's file names: zero matches). Per this plan's own `<lint_note>`, these are spurious type-aware-rule errors caused by the worktree lacking `bullmq` type resolution outside `apps/api`, not a regression from this plan.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plan 15-14 can wire `startQueueDepthWatchdog`/`startOldestJobAgeWatchdog` into `apps/api/src/server.ts`'s `main()` alongside the existing five watchdogs, and build the remaining two OPS-13 alerts (webhook-lag, failed-send-share) on the same `queue-monitor.ts`/`ops_alert_state` foundation.
- `queue-monitor.ts`'s `MONITORED_QUEUES` map and `QueueMetricsResult` type are ready for any future consumer needing the same 8-lane BullMQ snapshot.
- No blockers. Phase 15's single migration slot (0064, consumed by plan 15-12) is unaffected -- this plan added no migration.

---
*Phase: 15-observability-alerting-frontend-resilience*
*Completed: 2026-08-15*
