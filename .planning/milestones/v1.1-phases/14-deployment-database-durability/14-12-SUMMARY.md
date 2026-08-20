---
phase: 14-deployment-database-durability
plan: 12
subsystem: database
tags: [postgres, drizzle-orm, drizzle-kit, partitions, bullmq, retention, compliance]

requires:
  - phase: 14-deployment-database-durability
    provides: "plan 14-10's pgBackRest cadence/retention window (repo1-retention-full=2, ~2 weeks) -- the backup half of this plan's combined recovery-horizon arithmetic"
  - phase: 14-deployment-database-durability
    provides: "plan 14-11's restore-drill mechanism and runbook -- the DB-10-before-DB-11 human gate this plan's enable flag encodes"
  - phase: 09-partition-automation-boundary-safety
    provides: "ensurePartitions/PARTITIONED_TABLES (the catalog-driven creation walk this plan mirrors at the opposite end of the timeline) and partition_maintenance_runs (the singleton health row this plan extends)"
provides:
  - "packages/db/src/partitions/retention.ts: PARTITION_RETENTION_MONTHS (12), RETENTION_ELIGIBLE_TABLES, RETENTION_EXCLUDED_TABLES, findExpiredPartitions/dropExpiredPartitions (catalog-driven, never name-derived), isRetentionEnabled"
  - "migration 0063: partition_maintenance_runs.retention_status/retention_error (the run record) and the new append-only partition_retention_drops ledger (the per-drop history)"
  - "runPartitionMaintenance (packages/db) now runs the retention step after partition creation, in the same tick and the same upsert -- disabled | ok | failed, never silent, creation recording unaffected by a retention failure"
  - "docs/runbooks/data-retention.md: what retention deletes/never touches, the enable flag and its DB-10-before-DB-11 precondition, the combined recovery-horizon arithmetic, safe horizon-change procedure"
affects: ["14-13 (SPECIFICATION.md filing: new migration 0063, new env var PARTITION_RETENTION_ENABLED, new table partition_retention_drops)", "any future operator enabling retention in production"]

tech-stack:
  added: []
  patterns:
    - "Catalog-driven partition enumeration (pg_class/pg_inherits/pg_partitioned_table), DEFAULT excluded by oid<>partdefid rather than by name -- the same discipline ensure-partitions.ts already established at the creation end of the timeline, now mirrored at the deletion end"
    - "Detach-and-drop as the deletion mechanism; no row-level DELETE anywhere in the retention module (grep-asserted in both the test suite and the plan's own acceptance criteria)"
    - "A run record (singleton, upserted every tick) plus an append-only ledger, covering two different questions -- 'did the most recent run succeed' vs. 'what has retention ever removed and when' -- rather than trying to answer both from one row"

key-files:
  created:
    - packages/db/src/partitions/retention.ts
    - packages/db/src/partitions/index.ts
    - packages/db/src/partitions/__tests__/retention.test.ts
    - packages/db/migrations/0063_partition_retention_drops.sql
    - packages/db/migrations/meta/0063_snapshot.json
    - packages/db/src/schema/partition-retention-drops.ts
    - apps/worker/src/queues/__tests__/partition-retention-tick.test.ts
    - docs/runbooks/data-retention.md
  modified:
    - packages/db/src/partitions/maintenance-run.ts
    - packages/db/src/schema/partition-maintenance-runs.ts
    - packages/db/src/index.ts
    - packages/db/src/migration-tiers.ts
    - packages/db/migrations/meta/_journal.json
    - packages/db/src/__tests__/migration-tiers.test.ts
    - packages/db/src/__tests__/migration-empty-diff.test.ts
    - packages/db/src/__tests__/migration-rollback-rehearsal.test.ts
    - apps/worker/src/queues/partition-maintenance.worker.ts
    - apps/worker/src/queues/__tests__/partition-maintenance.worker.test.ts
    - apps/api/src/modules/ops/__tests__/partition-watchdog.test.ts

key-decisions:
  - "Checkpoint resolved (user, pre-execution): option scheduled-12-months -- 12-month horizon, dropped automatically on the daily tick once the enable flag is on. Build now with the flag OFF everywhere; no committed configuration enables it; production enablement is explicitly gated on plan 14-11's real-host restore drill, which is a PENDING operator action (see restore-drill.md's own 'What was NOT verified locally' section) -- not a completed prerequisite as of this plan."
  - "Recovery-window decision (user): the runbook instructs widening pgBackRest's repo1-retention-full from 2 (~2 weeks) to 4-6 weekly fulls (~1-1.5 months) BEFORE the retention flag is first enabled in production, then reviewing the resulting storage cost. This plan does NOT change docker/pgbackrest/pgbackrest.conf itself -- that edit belongs to the operator's own pre-enable checklist (docker/pgbackrest/, not packages/db or apps/worker), applied and verified via a real pgbackrest info before the flag is ever set."
  - "Drop-record location (planner decision the plan's own action text delegated): BOTH halves, not one -- partition_maintenance_runs gains retention_status/retention_error (the run record: disabled|ok|failed for the MOST RECENT tick) because the singleton row can only ever describe the latest run; the new append-only partition_retention_drops table is the durable per-drop history that singleton cannot hold. Recorded in migration 0063."
  - "RETENTION_ELIGIBLE_TABLES is the SAME frozen array ensure-partitions.ts's PARTITIONED_TABLES already is (not a re-declared copy) -- one place in the codebase names which tables are partitioned at all."
  - "DEFAULT-partition exclusion is by OID comparison against pg_partitioned_table.partdefid, not by name -- holds even if a DEFAULT partition were ever renamed, and is a stronger form of T-14-76's mitigation than the plan's own text literally asked for."
  - "isRetentionEnabled/findExpiredPartitions/dropExpiredPartitions expose optional test-injection hooks on runPartitionMaintenance's own options (isRetentionEnabledFn/dropExpiredPartitionsFn) rather than a mocking library -- mirrors this codebase's existing ProcessPartitionMaintenanceDeps precedent."

patterns-established:
  - "A retention/deletion mechanism added to an existing scheduled tick composes into that tick's OWN existing run-record upsert rather than registering a second BullMQ scheduler or a second recording call -- keeps the dead-man's-switch watchdog's read shape stable (additive columns only, never removed/renamed ones)."
  - "Any new migration in this repository requires the FULL bookkeeping chain, not just the .sql file: a matching meta/_journal.json entry, a regenerated meta/<tag>_snapshot.json (via drizzle-kit's own generateDrizzleJson, never hand-typed), a migration-tiers.ts classification with its pinned newestAutoReversibleTier test updated, and (if auto-reversible) a hand-verified MIGRATION_INVERSES entry in the rollback-rehearsal test."

requirements-completed: [DB-11]

coverage:
  - id: D1
    description: "Horizon constant (12 months, versioned, with its irreversibility and combined-recovery-horizon rationale in the comment) and a catalog-driven eligibility walk that reads partition bounds from pg_get_expr, never from a partition's name -- a straddling-by-one-day partition and an eligible-looking-name/ineligible-range partition are both handled correctly"
    requirement: "DB-11"
    verification:
      - kind: unit
        ref: "packages/db/src/partitions/__tests__/retention.test.ts (14/14 tests: real-timeline eligibility, one-day straddle rejection, exact-boundary inclusion, DEFAULT exclusion, catalog-not-name proof, excluded-table refusal guard, no-op empty result, real drop-and-record, no-DELETE grep, isRetentionEnabled matrix)"
        status: pass
    human_judgment: false
  - id: D2
    description: "The five evidence-table groups (sends, workspace_daily_rollup, subscription_status_history, erasure_records, workspace_suppressions) are named exactly and refused rather than silently skipped if ever passed to the eligibility walk"
    requirement: "DB-11"
    verification:
      - kind: unit
        ref: "packages/db/src/partitions/__tests__/retention.test.ts#test 6/test 7"
        status: pass
    human_judgment: false
  - id: D3
    description: "The retention step is wired into the existing daily tick (disabled/ok/failed distinguished in the run record; a failure never blocks the partition-creation work's own recording; no second BullMQ scheduler registered) and each real drop is recorded to partition_retention_drops"
    requirement: "DB-11"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/partition-retention-tick.test.ts (7/7 tests against a real ephemeral database and real temp Redis)"
        status: pass
    human_judgment: false
  - id: D4
    description: "docs/runbooks/data-retention.md states the excluded evidence groups and what each proves, the horizon and its rationale, the enable flag and its explicitly-pending restore-drill precondition, the combined recovery-horizon arithmetic, and the effect of narrowing the horizon"
    requirement: "DB-11"
    verification: []
    human_judgment: true
    rationale: "A runbook's completeness/clarity for an operator reading it under pressure is a judgment call automated tests cannot certify -- the arithmetic and precondition wording were reviewed during authoring, but the document itself is prose, not code with a pass/fail check."
  - id: D5
    description: "No committed configuration file sets the retention enable flag (PARTITION_RETENTION_ENABLED) to its enabling value; the flag is unset in production as of this plan"
    requirement: "DB-11"
    verification:
      - kind: other
        ref: "git grep -n PARTITION_RETENTION_ENABLED (repo-wide) -- only the flag-name constant declaration, docs prose, and a test's own set/reset in afterEach; zero occurrences in any .env/.yml/.yaml file"
        status: pass
    human_judgment: false

duration: ~2h
completed: 2026-08-13
status: complete
---

# Phase 14 Plan 12: Partition Retention (DB-11) Summary

**Catalog-driven partition-drop retention (12-month horizon, D-08) wired into the existing daily maintenance tick behind a default-off flag, with both a run-status column and an append-only drop ledger recording what was removed and when -- flag stays off everywhere in this plan; production enablement is explicitly gated on plan 14-11's real-host restore drill, which remains a pending operator action.**

## Performance

- **Duration:** ~2h
- **Tasks:** 2 (both `tdd="true"`, RED then GREEN commits)
- **Files created:** 8
- **Files modified:** 11

## Accomplishments

- **`packages/db/src/partitions/retention.ts`**: `PARTITION_RETENTION_MONTHS = 12`, `RETENTION_ELIGIBLE_TABLES` (the same frozen array `ensure-partitions.ts` already exports, not a re-declared copy), `RETENTION_EXCLUDED_TABLES` (the five evidence groups, exact physical table names verified from each schema file), `findExpiredPartitions` (reads bounds from `pg_get_expr` against the catalog, excludes DEFAULT by OID comparison against `pg_partitioned_table.partdefid` -- not by name), `dropExpiredPartitions` (detach-and-drop, no row-level DELETE anywhere), `isRetentionEnabled` (default-off, any unrecognised value off).
- **Migration 0063** (Rule 2 deviation -- see below): `partition_maintenance_runs` gains `retention_status`/`retention_error`/`partitions_dropped`; new append-only `partition_retention_drops` ledger. Full migration bookkeeping chain closed: journal entry, regenerated snapshot (via drizzle-kit's own `generateDrizzleJson`, chained from `0062_snapshot.json`'s id), `migration-tiers.ts` classification (auto-reversible), pinned `newestAutoReversibleTier` test updated, hand-verified `MIGRATION_INVERSES` entry added to the rollback-rehearsal test. `db:check-empty-diff`, `test:migrations` (217/218, 1 pre-existing skip), and the rehearsal all pass.
- **`runPartitionMaintenance`** (packages/db) now runs the retention step after `ensurePartitions`/`countDefaultRows`, wrapped in its own try/catch so a retention failure never affects the creation work's own recording -- both halves land in ONE `recordMaintenanceRun` upsert. Each real drop is additionally persisted via the new `recordPartitionDrops`.
- **`apps/worker/src/queues/partition-maintenance.worker.ts`**: logs `retentionStatus`/`partitionsDropped` on every run-complete line, and a dedicated `scrubbedConsole.error` line when `retentionStatus === "failed"` -- the loud half of "never silent". No second BullMQ scheduler registered; the existing daily 03:00 UTC job-scheduler is unchanged.
- **`docs/runbooks/data-retention.md`**: the five excluded evidence groups and what each proves, the horizon with its irreversibility rationale, the enable flag (`PARTITION_RETENTION_ENABLED`, exact value `true`) and its explicit precondition (plan 14-11's restore drill, currently pending on the real host), the combined recovery-horizon arithmetic (12-month horizon vs. today's ~2-week `repo1-retention-full=2` window; instructs widening to 4-6 weekly fulls before first enable, then reviewing storage cost), verification queries against both the run row and the ledger, and the safe horizon-change procedure (narrowing makes more partitions eligible on the very next tick).

## Task Commits

1. **Task 1: The horizon, the eligibility walk, and the exclusions**
   - `34fbf35` (test) -- failing test for `retention.ts` (RED)
   - `0051918` (feat) -- `retention.ts`/`index.ts` + migration 0063 bookkeeping (GREEN)
2. **Task 2: Wire the drop into the daily maintenance tick, and the retention runbook**
   - `3767971` (test) -- failing test for the worker-level wiring (RED)
   - `bf6a564` (feat) -- `maintenance-run.ts`/worker wiring + runbook + two pre-existing-test fixes (GREEN)

_No separate plan-metadata commit -- this SUMMARY.md is committed directly per this worktree's repo-specific rules (`.planning/` is gitignored here)._

## Files Created/Modified

- `packages/db/src/partitions/retention.ts` -- the horizon, the eligibility walk, the drop mechanism, the enable flag
- `packages/db/src/partitions/index.ts` -- the partitions module's re-export point (new)
- `packages/db/src/partitions/__tests__/retention.test.ts` -- 14 tests against a real ephemeral database
- `packages/db/migrations/0063_partition_retention_drops.sql` -- the two-halves migration (Rule 2)
- `packages/db/migrations/meta/0063_snapshot.json`, `meta/_journal.json` -- migration bookkeeping
- `packages/db/src/schema/partition-retention-drops.ts` -- type-inference shape for the ledger
- `packages/db/src/schema/partition-maintenance-runs.ts` -- three new columns
- `packages/db/src/index.ts` -- exports the new schema file
- `packages/db/src/migration-tiers.ts`, `src/__tests__/migration-tiers.test.ts`, `src/__tests__/migration-empty-diff.test.ts`, `src/__tests__/migration-rollback-rehearsal.test.ts` -- migration-0063 bookkeeping
- `packages/db/src/partitions/maintenance-run.ts` -- retention step composed into `runPartitionMaintenance`, `recordPartitionDrops`
- `apps/worker/src/queues/partition-maintenance.worker.ts` -- retention logging (run-complete line + dedicated failure line)
- `apps/worker/src/queues/__tests__/partition-retention-tick.test.ts` -- 7 tests: real DB end-to-end (flag unset/enabled/forced-failure) + worker-layer logging + scheduler-shape sanity check
- `apps/worker/src/queues/__tests__/partition-maintenance.worker.test.ts`, `apps/api/src/modules/ops/__tests__/partition-watchdog.test.ts` -- fixed pre-existing literal object constructions that stopped type-checking once the snapshot/row interfaces gained three required fields (Rule 1)
- `docs/runbooks/data-retention.md` -- the retention runbook

## Decisions Made

See `key-decisions` in frontmatter for the full list. Summarized:

1. **Checkpoint resolution (pre-execution, user-provided):** 12-month horizon, scheduled-drop mechanism, flag built OFF, enablement explicitly gated on the pending 14-11 real-host restore drill.
2. **Recovery-window instruction (user-provided):** runbook instructs widening `repo1-retention-full` to 4-6 weekly fulls before first enable; this plan does not touch `pgbackrest.conf` itself.
3. **Drop-record location:** both the run-status columns AND the append-only ledger, because the requirement has two distinct halves ("did the last run succeed" vs. "what has retention ever removed").
4. **DEFAULT exclusion by OID, not name** -- a stronger mitigation than the plan's literal wording asked for.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Added migration 0063 (not listed in the plan's `files_modified`)**
- **Found during:** Task 1, while deciding where the drop record lives
- **Issue:** The plan's own threat register (T-14-79) and Task 2's acceptance criteria require a drop to be "answerable from the database" -- a log line alone cannot satisfy that, and the plan's `files_modified`/Task file lists name no migration at all. Same precedent as 14-05's own deviation #1 (`check-empty-diff.ts`, "the threat model's own mitigation required it but the file list omitted it").
- **Fix:** Added migration 0063 (`partition_maintenance_runs.retention_status/retention_error/partitions_dropped` + the new `partition_retention_drops` table), plus its full bookkeeping chain (journal entry, regenerated snapshot, tier classification, pinned-test update, rollback-rehearsal inverse).
- **Files created/modified:** `packages/db/migrations/0063_partition_retention_drops.sql`, `meta/_journal.json`, `meta/0063_snapshot.json`, `src/schema/partition-retention-drops.ts`, `src/schema/partition-maintenance-runs.ts`, `src/index.ts`, `src/migration-tiers.ts`, `src/__tests__/migration-tiers.test.ts`, `src/__tests__/migration-empty-diff.test.ts`, `src/__tests__/migration-rollback-rehearsal.test.ts`
- **Verification:** `npm run test:migrations` (217/218, 1 pre-existing skip), `npm run lint:migrations` (64 files, no violations), `db:check-empty-diff` (OK)
- **Committed in:** `0051918` (Task 1 GREEN commit)

**2. [Rule 1 - Bug/breakage] Extended `packages/db/src/partitions/maintenance-run.ts` (not listed in either task's `<files>`)**
- **Found during:** Task 2, wiring the retention step into the tick
- **Issue:** The plan's Task 2 file scope is worker + worker-test + runbook only, but the retention step's outcome must land in the SAME per-tick `recordMaintenanceRun` upsert the creation work already writes -- a second, separate DB write from the worker would risk two different "as of" moments for one tick, and the plan's own action text explicitly delegates "decide where the drop record lives" to the implementer.
- **Fix:** Extended `MaintenanceRunSnapshot`/`runPartitionMaintenance` with the retention fields and the retention step itself (try/catch, non-fatal to creation), added `recordPartitionDrops`.
- **Files modified:** `packages/db/src/partitions/maintenance-run.ts`
- **Verification:** `packages/db` full suite (217/218) and the new worker-level integration tests (7/7) both pass.
- **Committed in:** `bf6a564` (Task 2 GREEN commit)

**3. [Rule 1 - Bug] Two pre-existing test files no longer type-checked after the interface change**
- **Found during:** Task 2's own `npm run build --workspaces --if-present` verification pass
- **Issue:** `apps/worker/src/queues/__tests__/partition-maintenance.worker.test.ts` and `apps/api/src/modules/ops/__tests__/partition-watchdog.test.ts` both construct `MaintenanceRunSnapshot`/`PartitionMaintenanceRunRow` object literals directly; adding three required fields to those interfaces broke their type-checking (`tsc` errors, caught before commit).
- **Fix:** Added `retentionStatus: "disabled"`, `retentionError: null`, `partitionsDropped: []` defaults to both files' fixture-object constructions.
- **Files modified:** `apps/worker/src/queues/__tests__/partition-maintenance.worker.test.ts`, `apps/api/src/modules/ops/__tests__/partition-watchdog.test.ts`
- **Verification:** `npm run build --workspaces --if-present` exits 0 across all 15 workspaces; both files' own test suites still pass (7/7, 76/76).
- **Committed in:** `bf6a564` (Task 2 GREEN commit)

---

**Total deviations:** 3 auto-fixed (1 Rule 2 -- a migration the threat model required but the file list omitted; 2 Rule 1 -- an implementation-location fix and a cross-file type-breakage fix, both necessary for the plan's own acceptance criteria and for the monorepo build to pass).
**Impact on plan:** All three were necessary for DB-11's own stated correctness requirement ("applied", "answerable from the database") or for the existing build/test gates to keep passing. No scope creep beyond what DB-11 required; the retention flag itself was never enabled anywhere.

## Issues Encountered

- **Lost prior-plan SUMMARYs:** `.planning/phases/14-deployment-database-durability/14-09-SUMMARY.md`, `14-10-SUMMARY.md`, `14-11-SUMMARY.md` do not exist on disk (worktree SUMMARY-rescue gap -- `.planning/` is gitignored, so a worktree executor's SUMMARY dies with the worktree unless copied out before merge). Recovered the load-bearing facts from primary sources instead of the missing summaries: `docs/runbooks/backups.md`/`docker/pgbackrest/pgbackrest.conf` (confirms `repo1-retention-full=2`) and `docs/runbooks/restore-drill.md`'s own "What this plan verified locally" / "What was NOT verified locally" sections (confirms the real-host drill is genuinely pending, not merely undocumented) -- both cited directly in the runbook and in this SUMMARY rather than assumed.
- **Transient test-suite flakiness under concurrent load:** one run of `npm run test:migrations` reported a failure in `migrate-runner-advisory-lock.test.ts` while a separate full `apps/worker` suite (81 files, real Postgres/Redis-backed) was running concurrently in the background -- re-ran in isolation immediately after and it passed cleanly (advisory-lock/connection-count contention from two large suites hitting the same Postgres instance at once, not a real regression from this plan's changes). Final verification run (all three suites run either sequentially or non-overlapping) was clean.

## User Setup Required

None for this plan itself -- no external service configuration required, and nothing in this plan changes production behavior (the enable flag is off everywhere).

**Operator action required before `PARTITION_RETENTION_ENABLED` is ever set to `true` on a real host** (documented in `docs/runbooks/data-retention.md`, not a blocker for this plan's own completion):
1. Perform plan 14-11's real-host restore drill (against the actual VPS/S3 repository/Docker daemon) and confirm it passes.
2. Widen `docker/pgbackrest/pgbackrest.conf`'s `repo1-retention-full` from `2` to 4-6, verify via `pgbackrest info`, and review the resulting storage cost.

## Next Phase Readiness

- DB-11 closed: retention is defined (versioned 12-month horizon) and applied (the existing daily tick drops eligible partitions once enabled), with both a run-status signal and a durable per-drop ledger.
- **Plan 14-13 (SPECIFICATION.md filing) needs:**
  - **§2 (Зависимости и версии):** no new npm package.
  - **§3 (Секреты):** new env var `PARTITION_RETENTION_ENABLED` (not a secret -- a boolean-shaped feature flag; exact enabling value `true`; unset/off in every current environment).
  - **§4 (Схема данных):** migration 0063 -- `partition_maintenance_runs` gains `retention_status text NOT NULL DEFAULT 'disabled'` / `retention_error text` / `partitions_dropped text[] NOT NULL DEFAULT '{}'`; new table `partition_retention_drops` (no RLS, no `workspace_id`, platform-operations metadata, same posture as `partition_maintenance_runs`/`dead_letter_jobs`).
  - **§5 (Планировщик и пайплайн отправки):** the existing `partition-maintenance-daily` BullMQ job-scheduler now also runs the DB-11 retention step every tick (no new scheduler, no new queue).
  - **§8 (Расхождения), if applicable:** none new -- no library/version drift from the Technology Stack section.
- **Production enablement is NOT ready** -- it is explicitly gated on the two operator actions listed under "User Setup Required" above, neither of which this plan performs.

## Self-Check: PASSED

All 11 created/referenced files confirmed present on disk. All 4 task commits (`34fbf35`, `0051918`, `3767971`, `bf6a564`) confirmed present in `git log`.

---
*Phase: 14-deployment-database-durability*
*Completed: 2026-08-13*
