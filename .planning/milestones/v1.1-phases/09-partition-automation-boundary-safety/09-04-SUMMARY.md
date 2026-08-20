---
phase: 09-partition-automation-boundary-safety
plan: 04
subsystem: database
tags: [postgresql, partitioning, drizzle-migrations, row-level-security, tsx-cli, packages/db]

# Dependency graph
requires:
  - phase: 09-partition-automation-boundary-safety
    provides: "09-01: ensurePartitions/attachPartitionCheckFirst/PARTITIONED_TABLES/monthPartitionName/monthRangeUtc (packages/db/src/partitions/ensure-partitions.ts), the CHECK-constraint-first attach sequence this plan reuses"
provides:
  - "relocate-default.ts: relocateAllDefaultRows/relocateMonth/discoverDefaultMonths/countDefaultRowsForTable/RELOCATE_BATCH_SIZE -- the single callable entrypoint for emptying events_default/send_events_default in bounded batches"
  - "packages/db/scripts/relocate-default-partition-rows.ts: the operator CLI (npm run relocate:default-partition-rows) -- thin wrapper, no relocation logic of its own"
  - "docs/runbooks/relocate-default-partition-rows.md: operator runbook (when/how/what it locks/how to confirm/what it never does)"
  - "migration 0039: partition_relocation_admin_scan SELECT-only policy on contacts and sends, required for attachPartitionCheckFirst to attach a non-empty (multi-tenant) child"
  - "boundary-crossing-late-automation.test.ts: automated evidence for ROADMAP success criterion 3 (month boundary crossed with automation late, DEFAULT already holding rows)"
affects: [09-02-partition-maintenance-worker, 09-05-spec-updates]

# Tech tracking
tech-stack:
  added: [tsx@^4.19.2 (packages/db devDependency, already pinned at this range in apps/api/apps/worker)]
  patterns:
    - "Batched DELETE+INSERT CTE (single statement) inside one BEGIN/COMMIT per batch, FOR UPDATE SKIP LOCKED, one dedicated connection per month's whole batch loop -- mirrors campaign-scheduler.worker.ts's transaction try/catch/rollback/finally shape"
    - "Two-pool discipline for any relocate-default.ts/attachPartitionCheckFirst caller: a dedicated pool that has NEVER run a tenant-scoped SET LOCAL, kept entirely separate from any @mega-crm/tenant-context-style pool -- required because a recycled connection's app.current_workspace_id reverts to '' (not NULL) and throws inside a bare-cast RLS policy regardless of an admin-scan policy's own truth value"
    - "admin-scan permissive SELECT policy (gated on app.admin_scan='true', no further predicate) extended to a new table pair (contacts, sends) via the same precedent as campaign_scheduler_due_scan/flow_runs_due_scan/flows_segment_sweep_scan"

key-files:
  created:
    - packages/db/src/partitions/relocate-default.ts
    - packages/db/src/partitions/__tests__/relocate-default.test.ts
    - packages/db/src/partitions/__tests__/boundary-crossing-late-automation.test.ts
    - packages/db/scripts/relocate-default-partition-rows.ts
    - packages/db/migrations/0039_partition_relocation_admin_scan.sql
    - docs/runbooks/relocate-default-partition-rows.md
  modified:
    - packages/db/src/partitions/ensure-partitions.ts
    - packages/db/migrations/meta/_journal.json
    - packages/db/package.json
    - package.json
    - package-lock.json
    - SPECIFICATION.md

key-decisions:
  - "attachPartitionCheckFirst gains one line (SELECT set_config('app.admin_scan','true',true) after BEGIN) rather than a second copy of the CHECK-constraint-first sequence -- 09-01's reuse contract stays intact; the admin-scan grant is transaction-scoped and a no-op for every empty-child attach (09-01's own callers)"
  - "Did NOT add a NULLIF guard to contacts'/sends' existing workspace_isolation policy, unlike migration 0019's companion fix for campaigns -- those two tables are pinned PRE-PHASE-10 bare-cast baselines in packages/tenant-context/src/__tests__/tenant-context.test.ts, and converting all 12 fail-closed tables is Phase 10/SEC-03's own coordinated decision, not a side effect of this plan. The connection-recycling hazard that would otherwise force that guard is instead prevented at the pool level (two-pool discipline, above), which is also how production already isolates the maintenance worker's pool from the app's tenant-scoped pool"
  - "relocateMonth moves rows into the freestanding child FIRST, then attaches -- flipping this order (attach empty, then move via tenant-scoped inserts) was considered and rejected: attachPartitionCheckFirst's own exclusion CHECK constraint requires DEFAULT to already be empty for that exact month's range at ATTACH time, so the child cannot be attached before its own month's backlog is fully relocated"
  - "RELOCATE_BATCH_SIZE=500, one BEGIN/COMMIT transaction per batch, single dedicated connection per month (not per batch) for the whole relocateMonth call"

requirements-completed: [DB-03, DB-04]

coverage:
  - id: D1
    description: "relocateAllDefaultRows discovers every month actually present in DEFAULT (via date_trunc query, not a bounded window) and relocates each in RELOCATE_BATCH_SIZE=500 batches, one short transaction per batch, then attaches via the reused CHECK-constraint-first sequence"
    requirement: DB-03
    verification:
      - kind: integration
        ref: "packages/db/src/partitions/__tests__/relocate-default.test.ts#test 1: discovers exactly the months seeded into DEFAULT, including a far-future one (D-09)"
        status: pass
      - kind: integration
        ref: "packages/db/src/partitions/__tests__/relocate-default.test.ts#test 5: a month with more rows than RELOCATE_BATCH_SIZE is moved in more than one batch, and counts still conserve"
        status: pass
    human_judgment: false
  - id: D2
    description: "A far-future provider timestamp (2031-04) is relocated and attached like any other month (D-09)"
    requirement: DB-03
    verification:
      - kind: integration
        ref: "packages/db/src/partitions/__tests__/relocate-default.test.ts#test 2: a month far outside any expected window is relocated like any other (D-09)"
        status: pass
    human_judgment: false
  - id: D3
    description: "After a run, both DEFAULT partitions hold zero rows, no relation is left freestanding (relispartition=false), no leftover exclusion CHECK constraint remains, and a second run against an already-empty DEFAULT is a silent no-op"
    requirement: DB-03
    verification:
      - kind: integration
        ref: "packages/db/src/partitions/__tests__/relocate-default.test.ts#test 3, test 6, test 7, test 8"
        status: pass
    human_judgment: false
  - id: D4
    description: "Row counts are conserved: parent total unchanged, each destination partition's count matches what was seeded, across single- and both-table runs"
    requirement: DB-03
    verification:
      - kind: integration
        ref: "packages/db/src/partitions/__tests__/relocate-default.test.ts#test 4, test 9"
        status: pass
    human_judgment: false
  - id: D5
    description: "The operator CLI (npm run relocate:default-partition-rows) is a thin wrapper with no relocation logic of its own, resolves DATABASE_URL, prints only the database name, and exits non-zero on a non-zero residual DEFAULT count"
    requirement: DB-03
    verification:
      - kind: manual_procedural
        ref: "manual run against a throwaway fully-migrated ephemeral database: prints database name, zero-months report, exits 0; and against DATABASE_URL unset: prints named error, exits 1"
        status: pass
    human_judgment: false
  - id: D6
    description: "A month boundary crossed with the automation running late -- DEFAULT already holding rows -- is recovered by the exact same function the CLI calls, with row counts conserved and the cheap-attach state restored afterward"
    requirement: DB-04
    verification:
      - kind: integration
        ref: "packages/db/src/partitions/__tests__/boundary-crossing-late-automation.test.ts#test 1, test 2, test 4 (Scenario A)"
        status: pass
    human_judgment: false
  - id: D7
    description: "ensurePartitions succeeds and exercises the CHECK-constraint-first path against a genuinely non-empty DEFAULT (a different month's untouched backlog), proving the exclusion check is scoped per-month rather than requiring global emptiness (Pitfall 13)"
    requirement: DB-04
    verification:
      - kind: integration
        ref: "packages/db/src/partitions/__tests__/boundary-crossing-late-automation.test.ts#test 3 (Scenario B)"
        status: pass
    human_judgment: false
  - id: D8
    description: "The CLI entrypoint and the criterion-3 test import the same relocateAllDefaultRows symbol, so a future divergence into two implementations fails a test rather than shipping silently (D-08)"
    requirement: DB-04
    verification:
      - kind: unit
        ref: "packages/db/src/partitions/__tests__/boundary-crossing-late-automation.test.ts#test 5: procedure and test are one code path"
        status: pass
    human_judgment: false
  - id: D9
    description: "The relocation procedure runs only on deliberate operator invocation -- not wired into any scheduler, worker, lifecycle script, or CI workflow"
    verification:
      - kind: unit
        ref: "grep assertions: no setInterval/upsertJobScheduler/new Worker in relocate-default.ts; predev's actual script content never references relocate (see Deviations -- the plan's own regex-based verify check for this has a false-positive documented below, confirmed correct by direct inspection instead)"
        status: pass
    human_judgment: false
  - id: D10
    description: "Operator runbook documents when to run the procedure, how to run it, what it locks, how to confirm success, what to do on a non-zero residual count, and what it deliberately never does (delete a row, drop a partition)"
    requirement: DB-03
    verification:
      - kind: other
        ref: "docs/runbooks/relocate-default-partition-rows.md contains: relocate:default-partition-rows, DB-03, D-08, relispartition, re-run guidance, CMP-05 far-future note, DB-11 create-and-move-only note"
        status: pass
    human_judgment: false

duration: ~70min
completed: 2026-08-06
status: complete
---

# Phase 9 Plan 4: Batched DEFAULT Relocation, Operator CLI & Late-Automation Boundary Test Summary

**`relocateAllDefaultRows` empties `events_default`/`send_events_default` in 500-row batched transactions and reuses `attachPartitionCheckFirst` to attach each month, exposed via `npm run relocate:default-partition-rows` and proven against a live late-automation scenario — required a new admin-scan RLS policy (migration 0039) to make PostgreSQL's automatic FK re-validation on ATTACH see cross-tenant `contacts`/`sends` rows.**

## Performance

- **Duration:** ~70 min
- **Completed:** 2026-08-06
- **Tasks:** 3 (task 1: tdd; task 2: auto; task 3: tdd)
- **Files modified:** 12 (6 created, 6 modified)

## Accomplishments

- `packages/db/src/partitions/relocate-default.ts`: `relocateAllDefaultRows` — the single callable entrypoint both the operator CLI and the criterion-3 test call — discovers every month actually present in `DEFAULT` via `date_trunc('month', ... AT TIME ZONE 'UTC')` (no bounded window, so a 2031 far-future timestamp is handled like any other), relocates each in `RELOCATE_BATCH_SIZE=500` batches (one `BEGIN`/`COMMIT` transaction per batch, `FOR UPDATE SKIP LOCKED`, single CTE `DELETE ... RETURNING` feeding an `INSERT` so a crash between delete and insert is impossible), then attaches via the reused, unmodified `attachPartitionCheckFirst` sequence from 09-01.
- `packages/db/scripts/relocate-default-partition-rows.ts`: thin operator CLI (`npm run relocate:default-partition-rows`), zero relocation logic of its own, prints only the resolved database name (never the connection string), exits non-zero on any non-zero residual `DEFAULT` count.
- `docs/runbooks/relocate-default-partition-rows.md`: operator-facing runbook covering when/how/what-it-locks/how-to-confirm/what-it-never-does, referencing D-08/DB-03/CMP-05/DB-11.
- `packages/db/src/partitions/__tests__/boundary-crossing-late-automation.test.ts`: 5 tests proving ROADMAP success criterion 3 — a month boundary crossed with the automation running late (DEFAULT already holding rows) is recovered by the exact code the operator runs, and (Scenario B) that `ensurePartitions` still succeeds against a genuinely non-empty `DEFAULT` as long as the specific month being attached has no rows in its own range (Pitfall 13).
- **Deviation discovered and fixed** (see below): attaching a partition already populated with real, potentially multi-tenant rows — the scenario this plan introduces for the first time — triggers PostgreSQL's automatic re-validation of `events`'/`send_events`' inherited FK constraints against `contacts`/`sends`, both of which carry `FORCE ROW LEVEL SECURITY`. Fixed with a new, precedented admin-scan RLS policy (migration 0039) plus a one-line `SET LOCAL app.admin_scan` addition inside `attachPartitionCheckFirst`.

## Task Commits

Each task followed the RED → GREEN TDD sequence where applicable, with separate commits:

1. **Task 1: Batched DEFAULT relocation core with discovered-month coverage** (auto, tdd)
   - `efcb976` test(09-04): add failing test for batched DEFAULT relocation core
   - `e3c7a46` feat(09-04): implement batched DEFAULT relocation core (relocateAllDefaultRows)
2. **Task 2: Operator CLI entrypoint and npm scripts** (auto)
   - `b295f90` feat(09-04): add operator CLI entrypoint and npm scripts for DEFAULT relocation
3. **Task 3: Runbook plus the late-automation boundary test (criterion 3)** (auto, tdd)
   - `a031e5f` test(09-04): add late-automation boundary crossing test (criterion 3)
   - `5b90950` docs(09-04): add operator runbook for DEFAULT partition relocation

## Files Created/Modified

- `packages/db/src/partitions/relocate-default.ts` - `relocateAllDefaultRows`, `relocateMonth`, `discoverDefaultMonths`, `countDefaultRowsForTable`, `RELOCATE_BATCH_SIZE`, `RelocationReport`/`TableRelocationReport`/`MonthRelocationReport`/`MonthRelocationResult` types
- `packages/db/src/partitions/__tests__/relocate-default.test.ts` - 9 tests: discovery (incl. D-09 far-future), attach, DEFAULT emptied, row conservation, batching (>1 batch), no orphaned relations, no leftover CHECK constraint, idempotent re-run, both-tables coverage
- `packages/db/src/partitions/__tests__/boundary-crossing-late-automation.test.ts` - 5 tests across two independent ephemeral databases: relocate-then-ensure recovery (Scenario A), ensure-first against a genuinely non-empty DEFAULT (Scenario B, Pitfall 13), and CLI/test one-code-path source inspection
- `packages/db/scripts/relocate-default-partition-rows.ts` - operator CLI wrapper: env resolution, database-name-only printing, report formatting, non-zero exit on residual > 0
- `packages/db/migrations/0039_partition_relocation_admin_scan.sql` - `partition_relocation_admin_scan` SELECT-only, `app.admin_scan`-gated permissive policy on `contacts` and `sends` (new — see Deviations)
- `packages/db/migrations/meta/_journal.json` - registered migration 0039 (idx 39)
- `packages/db/src/partitions/ensure-partitions.ts` - `attachPartitionCheckFirst` now sets `app.admin_scan` (transaction-scoped) immediately after `BEGIN`, before the CHECK-constraint-first sequence — one-line addition, sequence itself untouched
- `packages/db/package.json` - `relocate:default-partition-rows` script, `tsx@^4.19.2` devDependency
- `package.json` (root) - `relocate:default-partition-rows` passthrough
- `package-lock.json` - single-line diff (`tsx` entry for `packages/db`'s workspace node), no new registry package
- `docs/runbooks/relocate-default-partition-rows.md` - operator runbook (new)
- `SPECIFICATION.md` - §4.3 (new admin-scan policy row + rationale), §4.4 (relocate-default.ts module), §4.6 (migration count 39→40)

## Decisions Made

- **`relocateMonth` moves rows into the freestanding child before attaching, never the reverse.** Attaching first (while the child is empty, then moving rows in via tenant-scoped inserts through the parent) was considered specifically to sidestep the FK-validation problem below, but rejected: `attachPartitionCheckFirst`'s own exclusion CHECK constraint requires `DEFAULT` to already hold zero rows in the exact month's range at ATTACH time — the CHECK-first design fundamentally requires the move to happen first, confirmed empirically (a premature attach fails with "check constraint ... is violated by some row").
- **The admin-scan RLS fix stays narrowly scoped to `contacts`/`sends`, and deliberately does NOT touch their `workspace_isolation` policy's cast variant.** `packages/tenant-context/src/__tests__/tenant-context.test.ts` pins both tables as PRE-PHASE-10 bare-cast baselines with an explicit "do not fix these by changing the expectation" comment — Phase 10/SEC-03 owns converting all 12 fail-closed tables in one coordinated decision. The connection-recycling hazard that migration 0019's NULLIF guard exists to prevent (for `campaigns`) is instead prevented here at the connection-pool level: `attachPartitionCheckFirst`'s caller must never hand it a connection previously used for a tenant-scoped `SET LOCAL` — true by construction in production (a maintenance worker/CLI script's own dedicated pool) and enforced in both new test suites via a second, dedicated pool never shared with the tenant-scoped seeding pool.
- **`RELOCATE_BATCH_SIZE=500`, one connection per month (not per batch), one transaction per batch.** Bounds every lock to the duration of one 500-row move; a single dedicated connection is checked out once for the whole month's batch loop and released in `finally`, matching `campaign-scheduler.worker.ts`'s transaction shape.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical Functionality] `attachPartitionCheckFirst`'s automatic FK re-validation on ATTACH cannot see cross-tenant `contacts`/`sends` rows**
- **Found during:** Task 1, first integration-test run against a real ephemeral Postgres with real seeded events
- **Issue:** Attaching a partition already populated with real rows (the scenario this plan introduces for the first time — 09-01 only ever attached empty new months) triggers PostgreSQL's automatic re-validation of `events.contact_id -> contacts(id)` / `send_events.send_id -> sends(id)`, the inherited FK constraints every partition of a partitioned table carries. Both `contacts` and `sends` have `FORCE ROW LEVEL SECURITY`, so without a visibility grant that internal validation scan sees zero rows (no single `app.current_workspace_id` covers a `DEFAULT` backlog spanning many tenants at once), and the ATTACH fails with a spurious foreign key violation. A follow-on discovery (same debugging session): naively adding the admin-scan policy alone still crashed with `invalid input syntax for type uuid: ""` — Postgres evaluates every permissive policy for a command together as one OR'd expression, so `contacts`'/`sends`' EXISTING bare-cast `workspace_isolation` policy throws on a connection whose `app.current_workspace_id` has previously reverted to `''` (not NULL, a documented custom-GUC-placeholder behavior — see `SPECIFICATION.md` §4.3's own pre-existing "Эмпирическое подтверждение" note), independent of whether the new admin-scan policy's own condition would grant access.
- **Fix:** Migration `0039_partition_relocation_admin_scan.sql` adds a SELECT-only, `app.admin_scan`-gated permissive policy on `contacts` and `sends`, mirroring this codebase's own established, already-reviewed precedent (`campaign_scheduler_due_scan` / `flow_runs_due_scan` / `flows_segment_sweep_scan`). `ensure-partitions.ts`'s `attachPartitionCheckFirst` sets that GUC (transaction-scoped `SET LOCAL` semantics) immediately after `BEGIN` — a no-op for every empty-child attach 09-01's own callers perform. Rejected pairing this with a NULLIF guard on `contacts`'/`sends`' existing policy (unlike migration 0019's companion fix for `campaigns`) because both tables are explicitly pinned as PRE-PHASE-10 bare-cast baselines in `tenant-context.test.ts`, whose own docstring says "do not fix these by changing the expectation" — that conversion is Phase 10/SEC-03's coordinated decision. Instead, the invariant is enforced at the connection-pool level: both new test suites use a dedicated pool for every `relocate-default.ts`/`ensurePartitions` call, never shared with the tenant-scoped seeding pool — matching production, where the maintenance worker/CLI script already owns a pool entirely separate from `@mega-crm/tenant-context`.
- **Files modified:** `packages/db/migrations/0039_partition_relocation_admin_scan.sql` (new), `packages/db/migrations/meta/_journal.json`, `packages/db/src/partitions/ensure-partitions.ts`, `packages/db/src/partitions/__tests__/relocate-default.test.ts` (two-pool discipline), `packages/db/src/partitions/__tests__/boundary-crossing-late-automation.test.ts` (two-pool discipline), `SPECIFICATION.md`
- **Verification:** All 14 tests in `packages/db/src/partitions/__tests__/` pass; `packages/tenant-context/src/__tests__/tenant-context.test.ts`'s pinned bare-cast baseline assertions (7 tests, unmodified) still pass, confirming `contacts`' fail-closed posture is unchanged; `apps/api/src/modules/ops/__tests__/` (13 tests, exercises `ensure-partitions.ts`) still pass.
- **Committed in:** `e3c7a46` (Task 1's GREEN commit)

---

**Total deviations:** 1 auto-fixed (Rule 2 — missing critical functionality, discovered while making the plan's own written tests pass against a real database; not scope creep, since without it Task 1's core correctness requirement — attaching a relocated, populated month — cannot function at all).
**Impact on plan:** One new migration (0039) and one new admin-scan-gated RLS policy pair beyond the plan's declared `files_modified`, both narrowly scoped, reusing an already-reviewed codebase pattern, and fully covered by the automated test suite plus a regression check against the specific test that pins the security posture this fix deliberately did not touch.

## Issues Encountered

- **The plan's own `<verify>` command for "relocation not wired into a lifecycle script" produces a false positive.** `node -e '...if(/predev.*relocate|pretest.*relocate/.test(JSON.stringify(p.scripts)))...'` matches across the ENTIRE stringified `scripts` object with a greedy `.*`, so it fires whenever `predev` is declared anywhere before `relocate:default-partition-rows` in key order — true for virtually any package.json that lists `predev` first (a normal convention) and completely independent of `predev`'s actual command content. Confirmed directly: `predev`'s value is `"node scripts/check-env.mjs && node scripts/migrate-dev.mjs"`, which never mentions `relocate` in any form. The underlying requirement (T-09-22: no lifecycle script or CI workflow references the relocation script) is satisfied and verified by direct inspection instead. Not fixed by reordering `package.json`'s keys — that would be gaming a broken check rather than correcting the property it claims to test.
- **`mega_crm_test` (the shared, persistent local test database) does not have migration 0039 applied**, and manually running the CLI script against it produced a genuine-looking FK violation that was actually an RLS-masking artifact (confirmed via a superuser bypass query — the referenced contact does exist). Resolved by running the manual CLI smoke test against a throwaway, fully-migrated ephemeral database instead, rather than migrating the shared `mega_crm_test` database (which another parallel executor, plan 09-02, may depend on in its current state) as a side effect of this plan's manual verification step.

## User Setup Required

None — no external service configuration required. Migration 0039 will be applied to any environment the next time its migration chain runs (`npm run db:migrate` / `drizzle-kit migrate`); no manual step needed beyond the normal deploy-time migration application already documented in `SPECIFICATION.md` §4.6.

## Next Phase Readiness

- `relocateAllDefaultRows`/`RelocationReport` are fully implemented, tested, and exported — ready for any future phase (or a manual operator run) to invoke without further changes.
- The admin-scan RLS policy addition (migration 0039) is narrowly scoped and does not preempt Phase 10/SEC-03's broader fail-closed-to-NULLIF unification decision — `contacts`/`sends` remain bare-cast, matching the pinned baseline.
- `docs/runbooks/relocate-default-partition-rows.md` is ready for an operator to follow the next time `partition-watchdog.ts`'s daily alert (09-02's scope: wiring that watchdog into `apps/api/src/server.ts`) reports a non-zero DEFAULT count.
- No blockers for 09-03 (Drizzle schema/test-fixture parity/month-boundary suite, Wave 3) or 09-02 (Wave 2 sibling, daily job scheduler) — this plan touched no files either of those plans own, apart from the shared `packages/db/migrations/meta/_journal.json` append (additive, no conflict with 09-02's or 09-03's own migration numbering since 0039 is the next free index after 09-01's 0038).

## Self-Check: PASSED

All 6 created files verified present on disk; all 5 task commits (`efcb976`, `e3c7a46`, `b295f90`, `a031e5f`, `5b90950`) verified present in `git log --oneline --all`.

---
*Phase: 09-partition-automation-boundary-safety*
*Completed: 2026-08-06*
