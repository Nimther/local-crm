---
phase: 08-quality-gates-failure-injection-foundation
plan: 06
subsystem: testing
tags: [postgres, vitest, globalsetup, rls, db-fixture, consolidation, isolation]

requires:
  - phase: 08-02
    provides: "createEphemeralDatabase / dropEphemeralDatabase / globalSetup"
provides:
  - "packages/test-support/src/db-fixture.ts — the single migration-applying fixture"
  - "MIGRATION_ADVISORY_LOCK_KEY, getMigrationsDir exported"
  - "globalSetup registered in all three DB-touching workspaces"
  - "Env var GSD_DEV_DATABASE_URL (stashed true dev DSN)"
  - "db-fixture-isolation.test.ts — the SPEC R4 concurrency backstop check"
affects: [08-09, 08-10, 08-18]

tech-stack:
  added: []
  patterns:
    - "Thin re-export shims instead of a mass import rewrite, so a regression stays bisectable"
    - "Guard runs in both globalSetup and the fixture (D-14 two layers)"

key-files:
  created:
    - packages/test-support/src/db-fixture.ts
    - packages/test-support/src/__tests__/db-fixture-isolation.test.ts
    - scripts/lint-migrations.d.mts
    - scripts/check-lint-file-floor.d.mts
  modified:
    - apps/api/src/test/db-fixture.ts
    - apps/worker/src/test/db-fixture.ts
    - packages/delivery-core/src/test/db-fixture.ts
    - apps/api/vitest.config.ts
    - packages/delivery-core/vitest.config.ts
    - packages/test-support/src/global-setup.ts
    - packages/test-support/src/index.ts
    - SPECIFICATION.md

key-decisions:
  - "globalSetup stashes the true dev DSN in GSD_DEV_DATABASE_URL; the fixture's layer-b guard compares against that, not the overwritten DATABASE_URL"
  - "DATABASE_URL must be overwritten with the ephemeral DSN because packages/tenant-context reads it directly"
  - "Shims kept rather than rewriting 91 test files' imports"

patterns-established:
  - "Prove isolation by writing distinct markers into two databases and reading each back, not by comparing names"

requirements-completed: [QG-04]

coverage:
  - id: D1
    description: "One migration-applying fixture; three copies become shims retaining only workspace-specific helpers"
    requirement: QG-04
    verification:
      - kind: other
        ref: "376 -> 127 lines; pg_advisory_lock count 0 in all three shims; createFixtureFlowRun and resetTestData each still present"
        status: pass
    human_judgment: false
  - id: D2
    description: "No path from the fixture to the dev database; the guard runs before any pool is returned"
    requirement: QG-04
    verification:
      - kind: other
        ref: "fallback-expression grep returns 0 in the fixture and all three shims; assertTestDatabaseUrl called in getTestDatabaseUrl"
        status: pass
    human_judgment: false
  - id: D3
    description: "All three DB-touching workspaces provision their own ephemeral database and tear it down"
    requirement: QG-04
    verification:
      - kind: integration
        ref: "apps/api 250, apps/worker 109, packages/delivery-core 70 tests green with no caller-supplied TEST_DATABASE_URL; leftover mega_crm_test_% = 0"
        status: pass
    human_judgment: false
  - id: D4
    description: "Two workspaces running concurrently get physically distinct databases and cannot see each other's rows"
    requirement: QG-04
    verification:
      - kind: integration
        ref: "db-fixture-isolation.test.ts — distinct marker rows, neither visible in the other"
        status: pass
      - kind: other
        ref: "parallel api+worker run: mega_crm_test_api_e098b4ed and mega_crm_test_worker_fe6c5e1a alive simultaneously, both suites green, 0 leftover"
        status: pass
    human_judgment: false

duration: 20 min
completed: 2026-07-28
status: complete
---

# Phase 8 Plan 06: db-fixture Consolidation Summary

**Three near-identical migration runners collapse into one module with the dev-database fallback deleted — and every DB-touching workspace now provisions its own ephemeral database, proven physically isolated by writing distinct markers into two of them and reading each back.**

## Performance

- **Duration:** 20 min
- **Started:** 2026-07-28T06:32:00Z
- **Completed:** 2026-07-28T06:52:00Z
- **Tasks:** 3
- **Files modified:** 12

## Accomplishments

- **376 lines → 127.** One fixture in `@mega-crm/test-support`; `apps/api` keeps `resetTestData` (23 lines), `apps/worker` keeps `createFixtureFlowRun` (98), `delivery-core` is a 6-line pure re-export.
- **The dev-database fallback is gone.** No expression in the fixture or any shim falls back from the test DSN to the dev one. The fixture runs the guard itself, so D-14 layer b holds even for an entrypoint that never went through `globalSetup`.
- **The 01-04 advisory-lock reasoning was carried across intact** — it is the only record of a real concurrent-migration bug, and a merge is exactly where such a comment gets lost.
- **429 tests green** across the three workspaces, each on its own ephemeral database, with **zero leftover** afterwards.
- **The SPEC R4 concurrency backstop is closed with real evidence**, not an argument — see below.

## Task Commits

All three tasks landed in one commit, `f601f0e`, because Task 2's shims cannot typecheck without Task 1's module and Task 3's config changes are what make the shims resolve at runtime; splitting them would have committed a knowingly-red tree.

## Concurrency backstop — the evidence

The SPEC's backstop edge asks whether two workspaces' suites can corrupt each other. Two findings:

1. **`npm run test --workspaces` cannot exhibit the condition at all** — npm runs workspaces sequentially, so at most one ephemeral database exists at a time (polled throughout a full run: max simultaneous = 1). The acceptance criterion as written is unsatisfiable by that command.
2. **Running `apps/api` and `apps/worker` genuinely in parallel does exhibit it**, and the isolation holds:

```
max simultaneous ephemeral DBs: 2
  mega_crm_test_api_e098b4ed
  mega_crm_test_worker_fe6c5e1a
api exit=0   worker exit=0   leftover: 0
```

`db-fixture-isolation.test.ts` proves the underlying property directly: two databases created concurrently, a distinct marker row written into each, and each read back confirming the other's marker is absent. The shared advisory lock serializes *migrations*; it does nothing for *rows* — isolation comes from separate databases, and that is now asserted rather than assumed.

## Deviations from Plan

### 1. [Rule 1 — Bug] The layer-b guard tripped on itself

- **Found during:** Task 3, first full run of all three suites — every one failed with `FATAL: TEST_DATABASE_URL resolves to the same host+port+database as DATABASE_URL`.
- **Issue:** 08-02's `globalSetup` overwrites `process.env.DATABASE_URL` with the ephemeral DSN — which it must, because `packages/tenant-context` reads `DATABASE_URL` directly (SPECIFICATION §3.2); leaving it at dev would send tenant-scoped pools to the dev database. But this plan makes the fixture re-run the guard comparing `TEST_DATABASE_URL` against `DATABASE_URL`, and by then both hold the *same* ephemeral value. The equality check fired against itself on every run.
- **Fix:** `globalSetup` now stashes the original dev DSN in `GSD_DEV_DATABASE_URL` before overwriting; the fixture compares against that, falling back to `DATABASE_URL` when the hook never ran (the bypass case layer b exists for). Both paths keep a meaningful comparand.
- **Verification:** all three suites green.
- **Note:** this is precisely the branch 08-01's SUMMARY flagged as untested and 08-02 covered with the default-port row. The composition, not the function, was wrong.

### 2. [Rule 1 — Bug] The typecheck had been red since 08-05

- **Found during:** Task 2's `npm run build --workspaces`.
- **Issue:** `migration-lint.test.ts` (08-05) and `lint-gate.test.ts` (08-03) import `.mjs` modules with no type declarations → `TS7016`, plus one implicit `any`. **`npm run build --workspaces` IS the typecheck (D-04), so CI would have been red.** I ran the full build in 08-02 but not after 08-05 or 08-03, and neither of those pushed.
- **Fix:** hand-written `scripts/lint-migrations.d.mts` and `scripts/check-lint-file-floor.d.mts`, keeping the scripts dependency-free JavaScript as their plans require; typed the one loose parameter.
- **Verification:** `npm run build --workspaces --if-present` exits 0 across all 12 workspaces.

### 3. [Rule 1 — Bug] The blanket-disable scan flagged itself

- **Found during:** Task 3's full-workspaces run.
- **Issue:** `lint-gate.test.ts`'s scan matched a literal example directive inside its own explanatory comment. It passed in 08-03 only because the file was not yet tracked by `git ls-files`; committing it brought the file into its own scan.
- **Fix:** reworded the comment to carry no literal example, rather than excluding the file — an exclusion would create a genuine blind spot in the very check that guards D-06.

**Total deviations:** 3 auto-fixed, all bugs. Two were pre-existing regressions from earlier plans that this plan's fuller verification surfaced.

## Issues Encountered

**A criterion matched documentation, not code** (the third time this phase): the "no fallback expression" grep hit the header comment quoting the *removed* expression. Reworded so the check measures code.

**Lesson worth carrying:** the two pre-existing regressions both existed because earlier plans verified narrowly — `npx vitest run <one file>` rather than the full build and full suite. Later plans in this phase should run `npm run build --workspaces` before closing out.

## User Setup Required

None. `TEST_ADMIN_DATABASE_URL` still needs setting locally; unchanged from 08-02.

## Next Phase Readiness

**Ready for 08-07** (lint remediation, 556 violations). Note 48 of those live in `packages/test-support` — code written by 08-01/02/03/06.

**Note for 08-09 and 08-10:** the fixture now exports `getMigrationsDir()` and `MIGRATION_ADVISORY_LOCK_KEY`, so the migration tests can assert against the same resolution path rather than recomputing it.

---
*Phase: 08-quality-gates-failure-injection-foundation*
*Completed: 2026-07-28*
