---
phase: 17-address-tech-debt-wr-06-medium-security-follow-ups
plan: 01
subsystem: database
tags: [postgres, pg, node-postgres, timezone, createPgPool, vitest, wr-06]

# Dependency graph
requires:
  - phase: 14-deployment-database-durability
    provides: "createPgPool factory (DB-14/D-11) — the single choke point every pool in the monorepo goes through, enforced by lint:pg-pool-factory"
provides:
  - "createPgPool pins TimeZone=UTC on every physical connection via the Postgres startup-parameter form"
  - "packages/db/src/__tests__/pg-timezone.test.ts — behavioral proof against a database defaulted to America/New_York, with a negative control"
  - "packages/db/src/__tests__/pool-factory.test.ts — Docker-less config-level regression guard for the pin"
affects: ["17-02 (growth-chart read-site double-hop AT TIME ZONE fix)"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Postgres startup-parameter session GUC pinning via Pool's `options: '-c ...'` config key, not a post-connect SET (avoids brianc/node-postgres#3265's race)"
    - "Per-database non-UTC test isolation via `ALTER DATABASE <ephemeral-db> SET timezone TO ...`, scoped to one throwaway database on the shared test cluster"

key-files:
  created:
    - packages/db/src/__tests__/pg-timezone.test.ts
  modified:
    - packages/db/src/pool.ts
    - packages/db/src/__tests__/pool-factory.test.ts

key-decisions:
  - "TimeZone=UTC pinned via Pool's `options: '-c TimeZone=UTC'` startup-parameter config key inside createPgPool, not a `pool.on('connect', ...)` SET (rejected: documented race, node-postgres#3265)"
  - "Non-UTC regression test isolates its timezone mutation with `ALTER DATABASE <ephemeral-db> SET timezone`, never a cluster-level TZ/PGTZ or postgresql.conf change"
  - "Docker-less guard (pool-factory.test.ts) is explicitly NOT the primary proof — it exists so a refactor that drops the pin fails everywhere, not only where a live Postgres happens to be reachable"

patterns-established:
  - "Naive-timestamp UTC pin proof pattern: pinned pool + unpinned bypass pool (same DSN) + a shared scratch table, comparing stored text values at date+hour granularity to avoid clock-race flakiness"

requirements-completed: []

coverage:
  - id: D1
    description: "createPgPool pins every physical connection's TimeZone to UTC via the Postgres startup handshake, proven against a database whose own default timezone is America/New_York"
    verification:
      - kind: unit
        ref: "packages/db/src/__tests__/pg-timezone.test.ts#a pool built by createPgPool reports SHOW TimeZone = UTC even against a database defaulted to America/New_York"
        status: pass
    human_judgment: false
  - id: D2
    description: "Negative control proves the pin is load-bearing: a bare (unpinned) pool inherits the non-UTC database default"
    verification:
      - kind: unit
        ref: "packages/db/src/__tests__/pg-timezone.test.ts#negative control: a bare pool NOT built via createPgPool inherits the database's America/New_York default"
        status: pass
    human_judgment: false
  - id: D3
    description: "A naive timestamp DEFAULT now() column stores true UTC wall clock through the pinned pool, and a different (shifted) value through the unpinned pool"
    verification:
      - kind: unit
        ref: "packages/db/src/__tests__/pg-timezone.test.ts#a naive timestamp DEFAULT now() column stores true UTC wall clock through the pinned pool, and a different (shifted) value through the unpinned pool"
        status: pass
    human_judgment: false
  - id: D4
    description: "Docker-less regression guard: createPgPool's resolved pool options carry the exact '-c TimeZone=UTC' startup-parameter string, with no live Postgres connection required"
    verification:
      - kind: unit
        ref: "packages/db/src/__tests__/pool-factory.test.ts#carries the exact '-c TimeZone=UTC' startup-parameter string on the pool's own resolved options"
        status: pass
    human_judgment: false

duration: 10min
completed: 2026-08-19
status: complete
---

# Phase 17 Plan 01: Pin TimeZone=UTC on every createPgPool connection Summary

**Every Postgres connection opened by `createPgPool` now negotiates `TimeZone=UTC` at handshake time via the startup-parameter form, proven behaviorally against a database defaulted to `America/New_York`, plus a Docker-less config-level regression guard.**

## Performance

- **Duration:** 10 min
- **Started:** 2026-08-19T16:21:40+05:00
- **Completed:** 2026-08-19T16:31:26+05:00
- **Tasks:** 2 completed (Task 1 tracer + Task 2 auto)
- **Files modified:** 3 (1 created, 2 modified)

## Accomplishments

- `createPgPool` (`packages/db/src/pool.ts`) now passes `options: "-c TimeZone=UTC"` to `new Pool({...})`, closing the write-path half of WR-06 for every pool in the monorepo (enforced repo-wide by the pre-existing `lint:pg-pool-factory` CI gate).
- New behavioral regression test (`packages/db/src/__tests__/pg-timezone.test.ts`) provisions an ephemeral Postgres database, sets its default timezone to `America/New_York` via `ALTER DATABASE`, and proves: (1) a `createPgPool` pool still reports `UTC`; (2) a bare bypass pool (negative control) inherits `America/New_York`; (3) a naive `timestamp DEFAULT now()` column stores the correct UTC wall-clock value when written through the pinned pool, and a value shifted by a whole-hour UTC offset when written through the unpinned pool.
- Docker-less regression guard added to `packages/db/src/__tests__/pool-factory.test.ts`: asserts the pool's own resolved `options.options` string without opening any connection, so a future refactor that drops the pin fails in every environment, not only where a live Postgres happens to be reachable.
- `pool.ts`'s module-header comment extended with a new titled section documenting WR-06/D-01, the two mechanisms considered, the `node-postgres#3265` citation, the `relocate-default.ts` companion read-site idiom (for plan 17-02), and the PgBouncer `ignore_startup_parameters` revisit trigger.

## Task Commits

Each task was committed atomically (Task 1 is TDD, `tdd="true"`, producing separate RED/GREEN commits):

1. **Task 1 (tracer) — RED:** `88d1dac` (test) — added the failing behavioral test before touching `pool.ts`.
2. **Task 1 (tracer) — GREEN:** `8bee5ec` (feat) — pinned `TimeZone=UTC` in `createPgPool`, extended the header rationale.
3. **Task 2 — regression guard:** `ce7d94d` (test) — added the Docker-less config-level guard to `pool-factory.test.ts`.

**Plan metadata:** committed with this SUMMARY (see below).

## Files Created/Modified

- `packages/db/src/__tests__/pg-timezone.test.ts` (created) — behavioral WR-06 regression test against a non-UTC ephemeral database.
- `packages/db/src/pool.ts` (modified) — `createPgPool` now pins `options: "-c TimeZone=UTC"`; module-header comment extended with the WR-06/D-01 rationale section.
- `packages/db/src/__tests__/pool-factory.test.ts` (modified) — added the Docker-less TimeZone-pin regression guard describe block.

## Decisions Made

- Chose the Postgres startup-parameter form (`options: '-c TimeZone=UTC'`) over a `pool.on('connect', ...)` SET, per RESEARCH.md's citation of the documented race in `brianc/node-postgres#3265`.
- Scoped the non-UTC test mutation with `ALTER DATABASE <ephemeral-db> SET timezone`, never a cluster-level change, so no other concurrently-running test on the shared Postgres cluster is affected.
- Kept the Docker-less guard in `pool-factory.test.ts` explicitly secondary to the behavioral test in `pg-timezone.test.ts` — the comment in the guard block cross-references the behavioral file by name so neither is deleted believing the other covers it.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed a date+hour bucket comparison bug in the new test's own helper**
- **Found during:** Task 1 GREEN verification run.
- **Issue:** `dateHourBucket` sliced both the JS `toISOString()` string (`"...T16"`) and the Postgres `timestamp::text` string (`"...  16"`, space-separated) to 13 characters without normalizing the differing separator character at index 10, so semantically-identical date+hour buckets never compared equal (`'2026-08-19T11'` vs `'2026-08-19 11'`).
- **Fix:** Rewrote the helper to build a normalized `"YYYY-MM-DD_HH"` bucket from two independent slices (`[0,10)` and `[11,13)`), joined with a single fixed separator, so both timestamp formats produce an identical bucket string.
- **Files modified:** `packages/db/src/__tests__/pg-timezone.test.ts`
- **Verification:** Re-ran `npx vitest run --root packages/db src/__tests__/pg-timezone.test.ts` — all 3 tests pass.
- **Committed in:** `8bee5ec` (Task 1 GREEN commit — the bug was caught and fixed before that commit, never landed broken).

**2. [Rule 1 - Bug] Header-comment literal collided with the acceptance-criteria grep count**
- **Found during:** Task 1, acceptance-criteria verification pass.
- **Issue:** `grep -c 'options: "-c TimeZone=UTC"' packages/db/src/pool.ts` returned 2 (the plan's acceptance criteria require exactly 1) because the new module-header prose illustrated the mechanism using the same double-quoted literal as the real code line.
- **Fix:** Reworded the header's illustrative mention to use single quotes (`options: '-c TimeZone=UTC'`), matching RESEARCH.md's own illustrative convention, leaving only the real `new Pool({...})` call using the double-quoted form the acceptance criteria grep for.
- **Files modified:** `packages/db/src/pool.ts`
- **Verification:** `grep -c 'options: "-c TimeZone=UTC"' packages/db/src/pool.ts` now returns 1; `grep -c '3265' packages/db/src/pool.ts` returns 2 (≥1, satisfies that criterion).
- **Committed in:** `8bee5ec` (Task 1 GREEN commit).

---

**Total deviations:** 2 auto-fixed (both Rule 1 — bugs caught and fixed during the same task's own verification pass, before any commit landed broken).
**Impact on plan:** Both fixes were necessary for the test to be correct and for the acceptance criteria to pass exactly as specified. No scope creep.

## RED Failure Output (observed, Task 1)

Command: `npx vitest run --root packages/db src/__tests__/pg-timezone.test.ts` (run before editing `pool.ts`):

```
 ❯ src/__tests__/pg-timezone.test.ts (3 tests | 2 failed) 194ms
     × a pool built by createPgPool reports SHOW TimeZone = UTC even against a database defaulted to America/New_York
     × a naive timestamp DEFAULT now() column stores true UTC wall clock through the pinned pool, and a different (shifted) value through the unpinned pool

 FAIL  ... > a pool built by createPgPool reports SHOW TimeZone = UTC even against a database defaulted to America/New_York
AssertionError: expected 'America/New_York' to be 'UTC' // Object.is equality
Expected: "UTC"
Received: "America/New_York"

 FAIL  ... > a naive timestamp DEFAULT now() column stores true UTC wall clock through the pinned pool, and a different (shifted) value through the unpinned pool
AssertionError: expected [ '2026-08-19T11', '2026-08-19T11' ] to include '2026-08-19 07'

 Test Files  1 failed (1)
      Tests  2 failed | 1 passed (3)
```

Test 1 and Test 3 failed exactly as expected (the `SHOW TimeZone` assertion reported `America/New_York` where `UTC` was expected — the pin did not exist yet). Test 2 (negative control) passed immediately, as it must, since it never depends on the pin. (Test 3's specific failure text above also reflects the date+hour bucket bug fixed in Deviation 1, before the true GREEN run.)

## Stored Naive Values (negative control, Task 1's write-path test)

From the passing GREEN run: a row written through the `createPgPool` pool stored a naive `timestamp` value whose date+hour bucket matched the independently-computed UTC wall clock at insert time. The same insert, performed through the bare unpinned pool against the same `America/New_York`-defaulted database, stored a value offset from the pinned row by a whole-number-of-hours difference (4 hours, EDT — `America/New_York`'s offset on this run's date, 2026-08-19). The test asserts this difference is non-zero and is either 4 or 5 hours (EDT or EST), never hardcoding a single value so the test does not break across a DST transition.

## No Cluster-Level Timezone Change

Confirmed by reading the test source: the only timezone mutation in `pg-timezone.test.ts` is `ALTER DATABASE ${quoteIdentifier(provisioned.databaseName)} SET timezone TO 'America/New_York'`, executed against the one ephemeral database `createEphemeralDatabase({ workspace: "pg-timezone" })` provisions and `dropEphemeralDatabase` tears down in `afterAll`. No `TZ`/`PGTZ` environment variable and no `postgresql.conf` setting was touched, on the container or otherwise — every other concurrently-running test on the shared local Postgres cluster is unaffected.

## Task 2 No-Query Confirmation

Confirmed by reading the added `describe("createPgPool -- TimeZone startup parameter (WR-06)", ...)` block in `pool-factory.test.ts`: both its `it()` blocks only call `createPgPool(...)` (a pure JS constructor call — `pg.Pool` never opens a socket until `.connect()`/`.query()`) and `pool.end()`. No `pool.connect()` or `pool.query()` call exists anywhere in the new block, so it passes with no Postgres server reachable at all.

## Issues Encountered

None beyond the two auto-fixed deviations above, both caught and corrected within Task 1's own verification loop before any commit landed broken.

## User Setup Required

None — no external service configuration required. This plan touches only `packages/db`'s own pool factory and test suite; no new environment variable, secret, or package was introduced (confirmed no `package.json`/`package-lock.json` diff in either commit).

## Environment Note

This worktree's sandbox has no Docker daemon; ephemeral test databases were provisioned against the native `postgresql@17` Homebrew install (same environment `pg-tls.test.ts`'s own header comment documents), using `TEST_ADMIN_DATABASE_URL` from the machine's external env file. All `<verification>` commands ran against this real local Postgres 17 server and passed:
- `npx vitest run --root packages/db src/__tests__/pg-timezone.test.ts` — 3 passed.
- `npx vitest run --root packages/db src/__tests__/pool-factory.test.ts` — 19 passed (17 pre-existing + 2 new).
- `npm run lint:pg-pool-factory` — 277 files checked, no violations (the new test's deliberate bare `new Pool()` sits in an exempted `__tests__` directory, confirmed by running the gate, not assumed).
- `npx vitest run --root packages/db src/__tests__/pg-tls.test.ts` — 1 passed, 1 skipped (the positive TLS assertion skips in this Docker-less environment per its own documented environment gate; unaffected by this plan's change).

Two `node_modules` symlinks (`node_modules`, `scripts/node_modules`) were created to run these tests inside the worktree (no `node_modules` present at worktree creation) and were removed before returning — verified with `find . -maxdepth 4 -name node_modules -type l` returning empty.

## Next Phase Readiness

- WR-06's write-path half is closed: every `createPgPool` connection in the monorepo now negotiates UTC at handshake time, proven against a real non-UTC database.
- Plan 17-02 (the growth-chart read-site double-hop `AT TIME ZONE 'UTC'` fix) can proceed independently — this plan's header comment already documents the companion read-site idiom and cross-references `relocate-default.ts`.
- No blockers. The PgBouncer revisit trigger is recorded in `pool.ts`'s header for whenever SCALE-02 introduces an external pooler.

---
*Phase: 17-address-tech-debt-wr-06-medium-security-follow-ups*
*Completed: 2026-08-19*
