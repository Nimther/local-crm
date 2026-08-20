---
phase: 09-partition-automation-boundary-safety
plan: 01
subsystem: database
tags: [postgresql, partitioning, drizzle-migrations, bullmq-adjacent, sendgrid, dead-mans-switch, apps/api, packages/db]

# Dependency graph
requires:
  - phase: 08-quality-gates-failure-injection-foundation
    provides: packages/test-support ephemeral-DB fixtures (createEphemeralDatabase, applyMigrationFile, listMigrationFiles), the migration linter, and the migrate-from-empty/migrate-incremental test suites this plan's migration must not break
provides:
  - "Migration 0038: catch-up monthly partitions for events/send_events from 2026-09 through 2027-06 inclusive, closing the 2026-09-01 deadline as a deploy artifact"
  - "partition_maintenance_runs: the platform-level (no-RLS) singleton health table"
  - "ensurePartitions/attachPartitionCheckFirst/computeBufferMonths (packages/db/src/partitions/ensure-partitions.ts): the single source of partition DDL, idempotent, CHECK-constraint-first on every attach"
  - "runPartitionMaintenance/countDefaultRows/recordMaintenanceRun/readLatestMaintenanceRun (packages/db/src/partitions/maintenance-run.ts)"
  - "evaluatePartitionHealth/renderOperatorAlertText/checkPartitionHealthAndAlert/claimAlertSlot/startPartitionWatchdog (apps/api/src/modules/ops/partition-watchdog.ts): the watchdog side of the two-process dead-man's-switch, not yet wired into apps/api/src/server.ts"
affects: [09-02-partition-maintenance-worker, 09-04-default-relocation, 09-05-boundary-validation]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Minimal structural PartitionClient interface (query + connect), never a concrete pg.Pool/PoolClient import -- callable from apps/worker's pool, packages/test-support's pool, and any ephemeral test pool without a nominal-type mismatch"
    - "CHECK-constraint-first ATTACH (NOT VALID -> VALIDATE CONSTRAINT -> ATTACH PARTITION -> DROP CONSTRAINT), one transaction per month, applied unconditionally on every attach"
    - "Atomic per-day alert claim: a single conditional UPDATE ... RETURNING against a singleton row, correct across concurrent apps/api replicas without a SELECT-then-UPDATE race"
    - "Injected sendMail dependency bag (PartitionWatchdogDeps), mirroring Phase 8's ProcessSendJobDeps seam, for testing the alert path without a live SendGrid account"

key-files:
  created:
    - packages/db/migrations/0038_partition_catchup_and_maintenance_runs.sql
    - packages/db/src/partitions/ensure-partitions.ts
    - packages/db/src/partitions/maintenance-run.ts
    - apps/api/src/modules/ops/partition-watchdog.ts
    - apps/api/src/modules/ops/__tests__/partition-maintenance-tracer.test.ts
    - apps/api/src/modules/ops/__tests__/partition-watchdog.test.ts
  modified:
    - packages/db/migrations/meta/_journal.json
    - SPECIFICATION.md

key-decisions:
  - "Migration 0038's catch-up horizon is 2026-09 through 2027-06 inclusive (10 months/table, 20 CREATE TABLE statements) -- deliberately overshoots D-11's +3-month steady state so the deadline-closing artifact carries slack independent of deploy date"
  - "computeBufferMonths measures the PRE-RUN state (before ensurePartitions creates anything), not the post-heal state -- otherwise a self-healing run would always report a full buffer and mask the very gap being detected"
  - "checkPartitionHealthAndAlert attempts the atomic claim only AFTER confirming unhealthy, and lets a sendMail rejection propagate uncaught -- a failed alert must never look like a healthy run"
  - "ALERT_DEDUP_HOURS=20 ties the repeat-alert cadence to the once-daily maintenance job's own schedule, not the watchdog's 15-minute poll interval"
  - "The tracer test forces the ephemeral pool's session TimeZone to UTC (pg connection `options: -c timezone=UTC`) so the boundary-continuity assertion is independent of the local Postgres server's own default TimeZone -- see Deviations"

requirements-completed: [DB-01, DB-02]

coverage:
  - id: D1
    description: "Migration 0038 creates catch-up monthly partitions for events/send_events (2026-09 through 2027-06) plus the platform-level partition_maintenance_runs table, closing the 2026-09-01 deadline as a deploy artifact"
    requirement: DB-01
    verification:
      - kind: integration
        ref: "apps/api/src/modules/ops/__tests__/partition-maintenance-tracer.test.ts#test 1: the catch-up migration closes the 2026-09-01 deadline with no gap or overlap at the month boundary"
        status: pass
      - kind: unit
        ref: "node -e migration journal idx/tag/when assertion (verify gate)"
        status: pass
    human_judgment: false
  - id: D2
    description: "ensurePartitions is idempotent, CHECK-constraint-first on every attach, and never leaves an unattached freestanding table"
    requirement: DB-01
    verification:
      - kind: integration
        ref: "apps/api/src/modules/ops/__tests__/partition-maintenance-tracer.test.ts#test 2: ensurePartitions creates missing months idempotently through CHECK-constraint-first attach"
        status: pass
    human_judgment: false
  - id: D3
    description: "runPartitionMaintenance writes one partition_maintenance_runs health row per run, read by a separate apps/api process"
    requirement: DB-02
    verification:
      - kind: integration
        ref: "apps/api/src/modules/ops/__tests__/partition-maintenance-tracer.test.ts#test 3: runPartitionMaintenance writes exactly one health row"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/ops/__tests__/partition-maintenance-tracer.test.ts#test 4: an exhausted buffer, recorded by one process, produces exactly one alert read by another"
        status: pass
    human_judgment: false
  - id: D4
    description: "evaluatePartitionHealth covers the full unhealthy-condition matrix (missing row, stale run, low buffer at the inclusive boundary, either DEFAULT count nonzero) and never defaults to healthy on missing data"
    requirement: DB-02
    verification:
      - kind: unit
        ref: "apps/api/src/modules/ops/__tests__/partition-watchdog.test.ts#test 1: a stale last run is unhealthy; 25h is still healthy on that axis"
        status: pass
      - kind: unit
        ref: "apps/api/src/modules/ops/__tests__/partition-watchdog.test.ts#test 2: an absent health row is unhealthy, and the alert body says so"
        status: pass
      - kind: unit
        ref: "apps/api/src/modules/ops/__tests__/partition-watchdog.test.ts#test 3: buffer exactly at the threshold is healthy, one below is not"
        status: pass
      - kind: unit
        ref: "apps/api/src/modules/ops/__tests__/partition-watchdog.test.ts#test 4: a non-zero DEFAULT count is unhealthy for either table, and instructs the relocation procedure"
        status: pass
    human_judgment: false
  - id: D5
    description: "claimAlertSlot guarantees at most one operator email per ALERT_DEDUP_HOURS window, correct under concurrent apps/api replicas, and a sendMail rejection is never swallowed"
    requirement: DB-02
    verification:
      - kind: integration
        ref: "apps/api/src/modules/ops/__tests__/partition-watchdog.test.ts#test 5: at most one send per ALERT_DEDUP_HOURS window, even across repeated unhealthy checks"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/ops/__tests__/partition-watchdog.test.ts#test 6: two concurrent replicas checking the same unhealthy row produce exactly one send"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/ops/__tests__/partition-watchdog.test.ts#test 8: a rejecting sendMail causes checkPartitionHealthAndAlert to reject, never swallowed"
        status: pass
    human_judgment: false
  - id: D6
    description: "The operator alert body carries no tenant data, no credential, and no connection string (threat T-09-03)"
    requirement: DB-02
    verification:
      - kind: integration
        ref: "apps/api/src/modules/ops/__tests__/partition-watchdog.test.ts#test 7: the alert body carries no tenant data, no credential, and no connection string"
        status: pass
    human_judgment: false

duration: 25min
completed: 2026-08-06
status: complete
---

# Phase 9 Plan 1: Partition Deadline Closure & Watchdog Tracer Summary

**Migration 0038 closes the 2026-09-01 partition deadline as a deploy artifact; `ensurePartitions` is the single idempotent, CHECK-constraint-first source of partition DDL; a two-process dead-man's-switch (worker-written health row, apps/api-read watchdog) produces at most one plain-text operator alert per 20-hour window.**

## Performance

- **Duration:** ~25 min
- **Completed:** 2026-08-06
- **Tasks:** 2 (task 1: tracer, tdd; task 2: auto, tdd)
- **Files modified:** 8 (6 created, 2 modified: `_journal.json`, `SPECIFICATION.md`)

## Accomplishments

- Migration `0038_partition_catchup_and_maintenance_runs.sql` creates 20 monthly partitions (`events`/`send_events` x 10 months, 2026-09 through 2027-06) plus the platform-level `partition_maintenance_runs` health table, closing the hard 2026-09-01 deadline independent of any runtime behavior.
- `packages/db/src/partitions/ensure-partitions.ts`: `ensurePartitions` is the single idempotent source of partition DDL, walking `0..lookaheadMonths` unconditionally and attaching via `attachPartitionCheckFirst`'s CHECK-constraint-first sequence on every call (not gated on first observing a non-empty DEFAULT) — every attach is protected against the full-scan-under-`ACCESS EXCLUSIVE` failure mode this phase exists to prevent.
- `packages/db/src/partitions/maintenance-run.ts`: `runPartitionMaintenance` composes `ensurePartitions` + DEFAULT row counts into one `partition_maintenance_runs` row per run, never touching the watchdog-owned `last_alert_sent_at` column.
- `apps/api/src/modules/ops/partition-watchdog.ts`: `evaluatePartitionHealth` (missing/stale/low-buffer/non-empty-DEFAULT is unhealthy, never defaults to healthy), `renderOperatorAlertText` (plain-text only, no tenant data), `checkPartitionHealthAndAlert` (reads the worker-written row from a separate process), and `claimAlertSlot` (a single atomic `UPDATE ... RETURNING` making Postgres row-level locking the sole arbiter of "who sends" across concurrent API replicas).
- Two failing-tests-first integration suites (13 tests total: 5 tracer + 8 watchdog) prove the entire path end to end against a real ephemeral Postgres: migration → `ensurePartitions` → `runPartitionMaintenance` → `checkPartitionHealthAndAlert`, including the full unhealthy-condition matrix, the dedup/concurrency guarantee, and the no-tenant-data-leak property.

## Task Commits

Each task followed the RED → GREEN TDD sequence with separate commits:

1. **Task 1: End-to-end tracer path** (tracer, tdd)
   - `f2ca562` test(09-01): add failing tracer test for partition maintenance path
   - `3e99b0c` feat(09-01): close the 2026-09-01 partition deadline, ship ensurePartitions and the tracer alert path
2. **Task 2: Atomic once-per-day alert claim and full unhealthy matrix** (auto, tdd)
   - `a426f77` test(09-01): add failing test for the atomic alert claim and full unhealthy matrix
   - `c2217fd` feat(09-01): add the atomic per-day alert claim to the partition watchdog
   - `5484d16` test(09-01): fold the standalone claimAlertSlot probe into test 5 (kept the suite at the acceptance criteria's exact 8-test count)

**Plan metadata:** `a49dcfd` docs(09-01): record migration 0038, partition_maintenance_runs, and the watchdog in SPECIFICATION.md

## Files Created/Modified

- `packages/db/migrations/0038_partition_catchup_and_maintenance_runs.sql` - Catch-up partitions (2026-09..2027-06) for `events`/`send_events` + `partition_maintenance_runs` table (no RLS, comment explains why)
- `packages/db/migrations/meta/_journal.json` - Registered migration 0038 (idx 38)
- `packages/db/src/partitions/ensure-partitions.ts` - `ensurePartitions`, `attachPartitionCheckFirst`, `computeBufferMonths`, `monthPartitionName`, `monthRangeUtc`, `PARTITIONED_TABLES`, `LOOKAHEAD_MONTHS`, `BUFFER_ALERT_THRESHOLD_MONTHS`, `PARTITION_MAINTENANCE_CRON`
- `packages/db/src/partitions/maintenance-run.ts` - `runPartitionMaintenance`, `countDefaultRows`, `recordMaintenanceRun`, `readLatestMaintenanceRun`
- `apps/api/src/modules/ops/partition-watchdog.ts` - `evaluatePartitionHealth`, `renderOperatorAlertText`, `checkPartitionHealthAndAlert`, `claimAlertSlot`, `startPartitionWatchdog`, `ALERT_DEDUP_HOURS`, `WATCHDOG_INTERVAL_MS`, `STALE_THRESHOLD_HOURS`
- `apps/api/src/modules/ops/__tests__/partition-maintenance-tracer.test.ts` - 5-test end-to-end tracer against a fresh ephemeral database
- `apps/api/src/modules/ops/__tests__/partition-watchdog.test.ts` - 9 tests: 4 pure `evaluatePartitionHealth`/`renderOperatorAlertText` unit tests + 5 DB-backed dedup/concurrency/leak/failure-propagation tests
- `SPECIFICATION.md` - §4.2/§4.4/§4.6/§7 updated per CLAUDE.md's binding update rule (new table, new partitions, new alert channel — not yet wired into a boot process)

## Decisions Made

- **Buffer is measured pre-run, not post-heal.** `computeBufferMonths` runs on the month-presence array observed BEFORE `ensurePartitions` creates anything this call. If it measured the post-creation state instead, a manufactured gap would always show "healthy" by the time the health row is written (since the same `ensurePartitions` call that measures the gap also fixes it), making the unhealthy-buffer alert path untestable and, worse, invisible in production the one time it matters.
- **`checkPartitionHealthAndAlert` claims only after confirming unhealthy**, and a `sendMail` rejection propagates uncaught — matches `context_deviation` D-01's design: the email path is the sole loud signal for DB-02 in this phase (Bull Board is not installed — RESEARCH.md assumption A1), so a swallowed send failure would silently defeat the entire mechanism.
- **`ALERT_DEDUP_HOURS = 20`**, distinct from the watchdog's own `WATCHDOG_INTERVAL_MS` (15 min poll) — ties D-03's "repeat every run while unhealthy" to the daily maintenance job's cadence, not the watchdog's poll frequency, per RESEARCH.md's explicit "watchdog email flooding" threat note.
- **`PartitionClient` is a structural interface with both `query()` and `connect()`**, not a `pg.Pool` import — `attachPartitionCheckFirst` needs one dedicated connection per month's five-statement transaction (`campaign-scheduler.worker.ts`'s `findDueCampaignCandidates` shape), which a bare pool-level `.query()` call cannot provide (each pool `.query()` may be served by a different physical connection).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `claimAlertSlot`'s parameterized timestamp subtraction needed an explicit cast**
- **Found during:** Task 2, first GREEN run against a real Postgres
- **Issue:** `last_alert_sent_at < $1 - make_interval(hours => $2)` failed with `operator does not exist: timestamp with time zone < interval` — Postgres could not disambiguate `$1`'s type from the bare subtraction expression alone, resolving it to `interval` instead of `timestamptz`.
- **Fix:** Added an explicit `$1::timestamptz` cast in both the `SET` and `WHERE` clauses.
- **Files modified:** `apps/api/src/modules/ops/partition-watchdog.ts`
- **Verification:** `apps/api/src/modules/ops/__tests__/partition-watchdog.test.ts` (all 9 tests, including the direct `claimAlertSlot` unit test)
- **Committed in:** `c2217fd`

**2. [Rule 1 - Bug] Tracer test's month-boundary assertion was sensitive to the local Postgres server's default session TimeZone**
- **Found during:** Task 1, first GREEN run
- **Issue:** The pre-existing hand-written migrations (`0007`/`0020`) use bare date literals (e.g. `'2026-08-01'`) with no explicit UTC offset, so their stored bound is whatever the session's `TimeZone` GUC was AT MIGRATION-APPLY TIME. This plan's migration 0038 deliberately uses explicit `'... +00'` bounds (per the plan's own T-09-01 discipline). Against this environment's local Postgres server (default `TimeZone=Asia/Tashkent`, confirmed via `SHOW timezone`), the two conventions produced textually different — though both individually correct — bound representations, failing the continuity assertion for reasons unrelated to either migration's own correctness.
- **Fix:** The tracer test's own ephemeral `Pool` now forces every connection it opens onto a UTC session (`options: "-c timezone=UTC"`), matching what a correctly configured production/CI Postgres already assumes by default. This affects only the test's own pool, not `packages/test-support`'s shared migration runner or any other suite.
- **Files modified:** `apps/api/src/modules/ops/__tests__/partition-maintenance-tracer.test.ts`
- **Verification:** `apps/api/src/modules/ops/__tests__/partition-maintenance-tracer.test.ts` test 1 (month-boundary continuity assertion)
- **Committed in:** `3e99b0c`

---

**Total deviations:** 2 auto-fixed (both Rule 1 — bug fixes discovered while making the plan's own written tests pass; no scope creep).
**Impact on plan:** Both fixes are internal to test/implementation correctness against a real Postgres instance; no behavior described in the plan was changed.

## Issues Encountered

- **Worktree had no `node_modules`.** This git worktree was created without an `npm install`/`npm ci` step, so nothing (not even resolving `@mega-crm/*` workspace packages) could run initially. Ran `npm ci --prefer-offline` from the worktree root (matches the committed `package-lock.json`, isolated to this worktree, touched no shared state) before any test could execute. Documented here since a future worktree-based executor may hit the same gap.

## User Setup Required

None — no external service configuration required. Note: `apps/api/src/modules/ops/partition-watchdog.ts` is fully implemented and tested but deliberately NOT wired into `apps/api/src/server.ts` in this plan (no `OPERATOR_ALERT_EMAIL` env var added either) — that boot-time integration, plus the BullMQ `partition-maintenance.worker.ts` that actually calls `runPartitionMaintenance` on a schedule, is 09-02's scope.

## Next Phase Readiness

- The deadline-closing artifact (migration 0038) is committed and independently sufficient — 2026-09-01 is safe even if no later plan in this phase ships on time.
- `ensurePartitions`/`runPartitionMaintenance`/the watchdog module are all fully implemented, exported, and tested — 09-02 can call `runPartitionMaintenance` from a new BullMQ repeatable worker and `startPartitionWatchdog`/`checkPartitionHealthAndAlert` from `apps/api/src/server.ts` boot code without touching this plan's files (both were designed parameter-driven specifically for this handoff).
- `attachPartitionCheckFirst` is exported and ready for 09-04's DEFAULT-relocation script to reuse directly, per the plan's own cross-plan design note.
- No blockers. This plan's own migration/module set has zero dependency on 09-02 through 09-05 landing first.

## Self-Check: PASSED

All 7 created files verified present on disk; all 6 task/docs commits (`f2ca562`, `3e99b0c`, `a426f77`, `c2217fd`, `a49dcfd`, `5484d16`) verified present in `git log --oneline --all`.

---
*Phase: 09-partition-automation-boundary-safety*
*Completed: 2026-08-06*
