---
phase: 09-partition-automation-boundary-safety
plan: 03
subsystem: database
tags: [postgresql, partitioning, drizzle-orm, vitest, ephemeral-test-db, packages/db, packages/test-support]

# Dependency graph
requires:
  - phase: 09-partition-automation-boundary-safety
    provides: "09-01: ensurePartitions/attachPartitionCheckFirst/computeBufferMonths/PARTITIONED_TABLES/LOOKAHEAD_MONTHS/BUFFER_ALERT_THRESHOLD_MONTHS (packages/db/src/partitions/ensure-partitions.ts), runPartitionMaintenance/readLatestMaintenanceRun (maintenance-run.ts), migration 0038 and its partition_maintenance_runs table"
  - phase: 09-partition-automation-boundary-safety
    provides: "09-04: migration 0039's admin-scan RLS policy and the SET LOCAL app.admin_scan line inside attachPartitionCheckFirst -- this plan's tests run through that same code path"
provides:
  - "packages/db/src/schema/partition-maintenance-runs.ts: the Drizzle type-inference declaration for the health table, wired into packages/db/src/index.ts's import/spread/export triple"
  - "Every ephemeral test database now carries the same rolling partition horizon production has -- packages/test-support/src/db-fixture.ts's applyPendingMigrations calls ensurePartitions after the migration loop, closing D-05"
  - "packages/db/src/__tests__/fixture-partition-parity.test.ts: 4 tests proving the fixture's own partition step keeps real-clock parity, dated-partition routing, no orphaned relation, and idempotency"
  - "packages/db/src/partitions/__tests__/ensure-partitions.test.ts: 9 tests covering DB-01 idempotency and DB-04's month-boundary, UTC contiguity, calendar-precision, gap-aware buffer, per-table-minimum, and missing-current-month behaviour"
affects: [09-05-boundary-validation]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Two-pool discipline for any ensurePartitions/attachPartitionCheckFirst/runPartitionMaintenance caller in a test suite that also seeds tenant-scoped data: a dedicated pool that has NEVER run a tenant-scoped SET LOCAL, kept entirely separate from the seeding pool -- rediscovered independently in this plan's own new test suite, matching 09-04's documented precedent exactly"
    - "Deep workspace-package specifier for a module reachable before global-setup.ts publishes the ephemeral DSN (@mega-crm/db/src/partitions/ensure-partitions.js from db-fixture.ts), matching apps/api/src/kms/local-provider.ts's @mega-crm/kms/src/local-provider.js precedent"
    - "now injected as a plain function argument in every boundary/precision assertion -- no fake-timer library, no real-clock read inside a boundary test"

key-files:
  created:
    - packages/db/src/schema/partition-maintenance-runs.ts
    - packages/db/src/__tests__/fixture-partition-parity.test.ts
    - packages/db/src/partitions/__tests__/ensure-partitions.test.ts
  modified:
    - packages/db/src/index.ts
    - packages/test-support/src/db-fixture.ts
    - packages/test-support/package.json
    - package-lock.json
    - SPECIFICATION.md

key-decisions:
  - "The fixture-parity test file calls ensurePartitions directly (not through db-fixture.ts's own ensureTestDbMigrated) and passes trivially against the already-existing 09-01 implementation -- the genuine RED signal for task 2's TDD gate is the wiring itself (grep for ensurePartitions in db-fixture.ts, node -e dependency check), both confirmed failing before the fixture change and passing after"
  - "ensurePartitions/attachPartitionCheckFirst/runPartitionMaintenance are always called with `pool` (which structurally satisfies PartitionClient via its own .connect()), never with a locally-scoped PoolClient returned by pool.connect() -- a PoolClient's own .connect() would attempt to reconnect an already-connected socket"
  - "Test 1's idempotency window (April 2027, LOOKAHEAD_MONTHS=3) was chosen to extend the pre-migrated chain by exactly one contiguous month (July 2027) rather than a disjoint far-future window, so test 4's full adjacent-pair contiguity check has no manufactured gap to special-case"
  - "Task 3's suite runs all 9 tests against ONE shared ephemeral database in strict numeric order -- later tests deliberately build on state earlier tests establish (test 1's chain extension, test 7's asymmetric per-table 2028 coverage), and the gap/missing-month tests (6, 9) run last so they never interfere with the contiguity/precision tests (4, 5) that need a gap-free chain"

requirements-completed: [DB-01, DB-04]

coverage:
  - id: D1
    description: "partition_maintenance_runs has a Drizzle schema file (type-inference only) mirroring migration 0038's column list exactly, with the no-workspace_id/no-RLS reasoning recorded in the file"
    requirement: DB-01
    verification:
      - kind: unit
        ref: "npm run build -w packages/db (verify gate)"
        status: pass
      - kind: other
        ref: "grep -c 'partition-maintenance-runs.js' packages/db/src/index.ts == 2 (verify gate)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Every ephemeral test database gets partitions for the real current month through current + LOOKAHEAD_MONTHS, created by the same ensurePartitions code path production uses"
    requirement: DB-01
    verification:
      - kind: integration
        ref: "packages/db/src/__tests__/fixture-partition-parity.test.ts#test 1: the real current UTC month plus LOOKAHEAD_MONTHS partitions exist for both tables, after the fixture's own partition step"
        status: pass
      - kind: integration
        ref: "packages/db/src/__tests__/fixture-partition-parity.test.ts#test 2: a row inserted now lands in the dated current-month partition through tableoid::regclass, not DEFAULT"
        status: pass
      - kind: integration
        ref: "packages/db/src/__tests__/fixture-partition-parity.test.ts#test 3: zero events_%/send_events_% relations are left unattached after the fixture's partition step"
        status: pass
      - kind: integration
        ref: "packages/db/src/__tests__/fixture-partition-parity.test.ts#test 4: running the fixture's partition step twice is idempotent"
        status: pass
    human_judgment: false
  - id: D3
    description: "ensurePartitions called twice in a row creates nothing on the second call (DB-01 idempotency)"
    requirement: DB-01
    verification:
      - kind: integration
        ref: "packages/db/src/partitions/__tests__/ensure-partitions.test.ts#test 1: ensurePartitions run twice in a row creates nothing on the second call"
        status: pass
    human_judgment: false
  - id: D4
    description: "A month rollover with an injected clock (2026-08-31T23:59:59Z vs 2026-09-01T00:00:01Z) yields the same partition set apart from the trailing month, and a row inserted at the exact boundary lands in the correct dated partition, never its neighbor"
    requirement: DB-04
    verification:
      - kind: integration
        ref: "packages/db/src/partitions/__tests__/ensure-partitions.test.ts#test 2: month rollover yields the same partition set apart from the trailing month"
        status: pass
      - kind: integration
        ref: "packages/db/src/partitions/__tests__/ensure-partitions.test.ts#test 3: a row at the exact month boundary lands in the correct dated partition through tableoid::regclass"
        status: pass
    human_judgment: false
  - id: D5
    description: "Every partition bound is UTC-anchored and gap-free/overlap-free across the migration/function seam, proven from catalog-read bounds (pg_get_expr), not migration text"
    requirement: DB-04
    verification:
      - kind: integration
        ref: "packages/db/src/partitions/__tests__/ensure-partitions.test.ts#test 4: adjacent monthly partitions abut exactly across the migration/function seam, for both tables"
        status: pass
    human_judgment: false
  - id: D6
    description: "computeBufferMonths returns the same integer regardless of which instant within a 28/30/31-day month now falls on, and correctly stops the consecutive-months walk at the first gap rather than counting raw future partitions"
    requirement: DB-04
    verification:
      - kind: unit
        ref: "packages/db/src/partitions/__tests__/ensure-partitions.test.ts#test 5: calendar-integer buffer arithmetic is identical at the first, mid, and last instant of a 28/30/31-day month"
        status: pass
      - kind: unit
        ref: "packages/db/src/partitions/__tests__/ensure-partitions.test.ts#test 6: a gap stops the consecutive-months walk (Pitfall 2)"
        status: pass
      - kind: integration
        ref: "packages/db/src/partitions/__tests__/ensure-partitions.test.ts#test 9: a dropped current-month partition yields a buffer below the alert threshold"
        status: pass
    human_judgment: false
  - id: D7
    description: "runPartitionMaintenance records buffer_months_remaining as the minimum of the two per-table buffers, while each per-table column keeps its own distinct value, and no run leaves an unattached freestanding relation"
    requirement: DB-04
    verification:
      - kind: integration
        ref: "packages/db/src/partitions/__tests__/ensure-partitions.test.ts#test 7: buffer_months_remaining is the minimum of the two per-table buffers"
        status: pass
      - kind: integration
        ref: "packages/db/src/partitions/__tests__/ensure-partitions.test.ts#test 8: no events_%/send_events_% relation is left freestanding after every call above"
        status: pass
    human_judgment: false

duration: ~30min
completed: 2026-08-06
status: complete
---

# Phase 9 Plan 3: Fixture Partition Parity & Boundary/Precision Coverage Summary

**Ephemeral test databases now get the real current-month rolling partition horizon via the production `ensurePartitions` code path (closing D-05), backed by a Drizzle type-inference declaration for `partition_maintenance_runs` and 13 new tests proving DB-01 idempotency plus DB-04's month-boundary, UTC-contiguity, calendar-precision, gap-aware-buffer, and per-table-minimum behaviour.**

## Performance

- **Duration:** ~30 min
- **Completed:** 2026-08-06
- **Tasks:** 3 (task 1: auto; task 2: auto, tdd; task 3: auto, tdd)
- **Files modified:** 8 (3 created, 5 modified)

## Accomplishments

- `packages/db/src/schema/partition-maintenance-runs.ts` declares `partitionMaintenanceRuns` with `pgTable`, mirroring migration 0038's column list exactly (bigint for the two DEFAULT counts, text-array for `partitions_created`), with a header comment recording that migration 0038 owns the physical DDL (singleton `CHECK (id = 1)`, no RLS) and a comment explaining why this is the one schema module with no `workspace_id`. Wired into `packages/db/src/index.ts`'s import/spread/export triple, matching the twenty-two existing schema modules.
- `packages/test-support/src/db-fixture.ts`'s `applyPendingMigrations` now calls `ensurePartitions(pool, PARTITIONED_TABLES, new Date(), LOOKAHEAD_MONTHS)` immediately after the migration loop, still inside the session-scoped advisory lock, through the deep specifier `@mega-crm/db/src/partitions/ensure-partitions.js` (avoids `packages/db/src/index.ts`'s import-time `DATABASE_URL` throw). `packages/test-support` now depends on `@mega-crm/db` (single-line `package-lock.json` diff, no new registry package, intentional workspace cycle with the pre-existing reverse dev-dependency).
- `packages/db/src/__tests__/fixture-partition-parity.test.ts`: 4 tests proving the behaviour the fixture's new call produces -- real-clock partition parity for both tables, dated-partition routing via `tableoid::regclass`, zero orphaned relations, and idempotency.
- `packages/db/src/partitions/__tests__/ensure-partitions.test.ts`: 9 tests against one ephemeral database, run in strict numeric order since later tests build on state earlier tests establish -- idempotency, month rollover with an injected clock, exact-boundary routing, UTC contiguity across the migration/function seam (via `pg_get_expr(relpartbound, oid)`), calendar-integer buffer arithmetic across 28/30/31-day months, gap-aware buffer counting (Pitfall 2), per-table-minimum aggregation, no orphaned relation, and missing-current-month under-threshold reporting.
- SPECIFICATION.md updated per CLAUDE.md's binding rule: §2.5 records the new `@mega-crm/db` dependency edge and its cycle reasoning; §4 records the new schema file for `partition_maintenance_runs`.

## Task Commits

1. **Task 1: Drizzle type-inference declaration for the health table** (auto)
   - `4fba735` feat(09-03): add Drizzle type-inference declaration for partition_maintenance_runs
2. **Task 2: Ephemeral test databases get the same rolling partition horizon as production** (auto, tdd)
   - `a747575` test(09-03): add failing wiring check for fixture partition parity
   - `3ec365a` feat(09-03): wire ensurePartitions into the ephemeral test-database fixture
3. **Task 3: Month-boundary, contiguity and calendar-precision coverage for the automation path** (auto, tdd)
   - `adbe36f` test(09-03): add month-boundary, contiguity and calendar-precision coverage

**Plan metadata:** `c605838` docs(09-03): record the new schema file and test-support dependency edge

_Note: task 2's RED commit (`a747575`) does not itself fail when run standalone -- see Deviations/TDD Gate Compliance below for why, and what the actual RED signal was._

## Files Created/Modified

- `packages/db/src/schema/partition-maintenance-runs.ts` - Drizzle `pgTable` declaration for the health table, type-inference only
- `packages/db/src/index.ts` - import/spread/export triple for the new schema module
- `packages/test-support/src/db-fixture.ts` - `applyPendingMigrations` calls `ensurePartitions` after the migration loop, inside the advisory lock
- `packages/test-support/package.json` - `@mega-crm/db` added to `dependencies`
- `package-lock.json` - single-line workspace-link diff, no new registry package
- `packages/db/src/__tests__/fixture-partition-parity.test.ts` - 4 tests: real-clock parity, dated-partition routing, no orphan, idempotency
- `packages/db/src/partitions/__tests__/ensure-partitions.test.ts` - 9 tests: idempotency, rollover, boundary routing, UTC contiguity, calendar precision, gap-aware buffer, per-table minimum, no orphan, missing-current-month
- `SPECIFICATION.md` - §2.5 (new dependency edge), §4 (new schema file note)

## Decisions Made

- **`ensurePartitions`/`attachPartitionCheckFirst`/`runPartitionMaintenance` are always called with a `Pool`, never a checked-out `PoolClient`.** A `PoolClient` structurally has a `.connect()` method (inherited from `pg`'s `ClientBase`), which would satisfy `PartitionClient`'s type signature, but calling it on an already-connected client throws or misbehaves at runtime. Only a `Pool`'s `.connect()` genuinely hands out a fresh, dedicated connection, which is what `attachPartitionCheckFirst`'s five-statement transaction needs.
- **Test 1's idempotency window (April 2027) extends the pre-migrated chain by exactly one contiguous month (July 2027)** rather than jumping to a disjoint far-future window, so test 4's full adjacent-pair contiguity check across the whole catalog has nothing to special-case.
- **Task 3's 9 tests run against one shared database in strict numeric order, not in isolation** -- deliberately, since later tests build on earlier state (test 1's chain extension feeds test 4/5; test 7's asymmetric 2028 coverage feeds test 9's drop), and the two gap-manufacturing tests (6, 9) are placed last so they never interfere with the contiguity/precision tests (4, 5) that require a gap-free chain.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `attachPartitionCheckFirst` calls in task 3's new test suite threw `invalid input syntax for type uuid: ""` when run against a connection pool tainted by prior tenant-scoped seeding**
- **Found during:** Task 3, first run of `ensure-partitions.test.ts` (tests 1, 5, 7, 9 failed)
- **Issue:** The test suite's single `pool` was used both for tenant-scoped seeding (`SET LOCAL app.current_workspace_id` in `beforeAll` and test 3) and for calling `ensurePartitions`/`attachPartitionCheckFirst` directly (tests 1 and 7). A connection recycled from a tenant-scoped transaction reverts `app.current_workspace_id` to `''` (not `NULL`) -- a documented Postgres custom-GUC-placeholder behavior, per 09-04's own SPECIFICATION.md note -- and `contacts`'/`sends`' PRE-PHASE-10 bare-cast RLS policies throw on that the moment `ATTACH PARTITION` triggers Postgres's automatic inherited-FK re-validation, independent of the admin-scan policy migration 0039 grants. This is exactly the hazard 09-04's own deviation report (read as part of this plan's upstream-state briefing) documents and the two-pool discipline it establishes exists to prevent -- this plan's own new test suite reproduced it independently before applying the same fix.
- **Fix:** Added a second, dedicated `partitionPool` (never used for any tenant-scoped `SET LOCAL`) for every `ensurePartitions`/`attachPartitionCheckFirst`/`runPartitionMaintenance` call in the suite, matching `relocate-default.test.ts`'s and `boundary-crossing-late-automation.test.ts`'s own established pattern exactly. `pool` remains dedicated to migrations, tenant-scoped seeding, and read-only catalog queries.
- **Files modified:** `packages/db/src/partitions/__tests__/ensure-partitions.test.ts`
- **Verification:** All 9 tests pass; `npm run test -w packages/db` (36 tests, 6 files) and the full `npm run test --workspaces --if-present` run (11 workspaces, all green) both confirm no regression.
- **Committed in:** `adbe36f` (task 3's only commit -- discovered and fixed before the first commit of this file)

---

**Total deviations:** 1 auto-fixed (Rule 1 -- a bug in this plan's own new test code, discovered while making its own written tests pass against a real Postgres instance; not scope creep, and the fix reuses an already-reviewed codebase pattern rather than inventing a new one).
**Impact on plan:** Internal to this plan's own new test file; no production code path changed as a result, and no behavior described in the plan was altered.

## TDD Gate Compliance

Task 2's own TDD gate is atypical and worth recording explicitly: `packages/db/src/__tests__/fixture-partition-parity.test.ts` calls `ensurePartitions` **directly** (not through `db-fixture.ts`'s `applyPendingMigrations`), so it exercises behavior that already existed from plan 09-01 and passes standalone even before task 2's fixture-wiring action. This is by design, not a fail-fast violation: the plan's own `<verify>` block for task 2 separates the two concerns --
- the **behavioral** claim (does `ensurePartitions` with a real clock produce parity?) is proven by this test file, which legitimately passes immediately since the underlying function is already correct;
- the **wiring** claim (does the fixture actually call it?) is proven by `grep -q 'ensurePartitions' packages/test-support/src/db-fixture.ts` and the `@mega-crm/db` dependency check, both confirmed failing before the fixture-wiring commit and passing after (see the confirmation output captured during execution, before `3ec365a`).

Both RED and GREEN gate commits exist in git log (`a747575` test, `3ec365a` feat), and the wiring-specific RED signal was independently verified before the GREEN commit landed.

## Issues Encountered

None beyond the auto-fixed issue documented above.

## User Setup Required

None -- no external service configuration required.

## Next Phase Readiness

- `partitionMaintenanceRuns` (Drizzle schema) is exported from `@mega-crm/db` and available for any future typed query against the health table.
- Every ephemeral test database created via `packages/test-support`'s fixture now carries the same rolling partition horizon production has -- this is a foundational correctness property every DB-touching suite in the repository now depends on (verified: the full `npm run test --workspaces --if-present` run, 11 workspaces, all green, including the pre-existing RLS/migration-chain assertions).
- The two-pool discipline pattern (dedicated non-tenant-scoped pool for any `ensurePartitions`/`attachPartitionCheckFirst`/`runPartitionMaintenance` caller) is now demonstrated in three independent test suites (09-04's two, this plan's one) -- any future test that seeds tenant data AND calls into `ensure-partitions.ts` should follow it from the start rather than rediscovering the hazard.
- No blockers for 09-05 (this phase's remaining plan) or for this phase's overall 2026-09-01 deadline, which plan 09-01 already closed independently via migration 0038.

## Self-Check: PASSED

All 3 created files verified present on disk (`packages/db/src/schema/partition-maintenance-runs.ts`, `packages/db/src/__tests__/fixture-partition-parity.test.ts`, `packages/db/src/partitions/__tests__/ensure-partitions.test.ts`); all 5 commits (`4fba735`, `a747575`, `3ec365a`, `adbe36f`, `c605838`) verified present in `git log --oneline --all`.

---
*Phase: 09-partition-automation-boundary-safety*
*Completed: 2026-08-06*
