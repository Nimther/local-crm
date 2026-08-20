---
phase: 08-quality-gates-failure-injection-foundation
plan: 02
subsystem: testing
tags: [postgres, pg, vitest, globalsetup, rls, ephemeral-database, tdd]

requires:
  - phase: 08-01
    provides: "@mega-crm/test-support workspace, assertTestDatabaseUrl, the globalSetup hook point"
provides:
  - "createEphemeralDatabase / dropEphemeralDatabase / buildEphemeralDatabaseName"
  - "quoteIdentifier (exported for direct assertion)"
  - "Per-run ephemeral databases named mega_crm_test_<workspace>_<runId>"
  - "globalSetup that provisions, guards, and tears down even on failure"
  - "Env vars TEST_ADMIN_DATABASE_URL, GSD_TEST_RUN_ID, TEST_APP_DB_PASSWORD"
affects: [08-06, 08-09, 08-10, 08-18]

tech-stack:
  added: []
  patterns:
    - "Destructive guard as the first statement of the destructive function, proven by rejecting against an unreachable DSN"
    - "Teardown returned from globalSetup rather than a posttest script, so it survives a failing suite"

key-files:
  created:
    - packages/test-support/src/provision-db.ts
    - packages/test-support/src/__tests__/provision-db.test.ts
  modified:
    - packages/test-support/src/guard.ts
    - packages/test-support/src/__tests__/guard.test.ts
    - packages/test-support/src/global-setup.ts
    - packages/test-support/src/index.ts
    - apps/worker/vitest.config.ts
    - SPECIFICATION.md

key-decisions:
  - "dropEphemeralDatabase uses the SAME prefix rule as guard.ts (startsWith, no trailing underscore) — a stricter rule would refuse to drop a database the guard accepts, leaking it forever"
  - "quoteIdentifier exported rather than module-local so the plan's mandated escaping assertion is real rather than notional"
  - "Config-load ordering solved by removing the eager env key and inheriting process.env — measured, not guessed; the temp-file fallback was unnecessary"

patterns-established:
  - "Assert 'validation ran before any connection' by passing an unreachable DSN and requiring the validation error"

requirements-completed: [QG-04]

coverage:
  - id: D1
    description: "DSN guard enforces both SPEC R4 conditions across all acceptance rows, including IPv6 loopback and default-port normalization"
    requirement: QG-04
    verification:
      - kind: unit
        ref: "packages/test-support/src/__tests__/guard.test.ts (14 tests)"
        status: pass
    human_judgment: false
  - id: D2
    description: "dropEphemeralDatabase refuses every non-test name before opening a connection or interpolating SQL"
    requirement: QG-04
    verification:
      - kind: unit
        ref: "packages/test-support/src/__tests__/provision-db.test.ts — 4 forbidden names rejected against an unreachable admin DSN"
        status: pass
    human_judgment: false
  - id: D3
    description: "Ephemeral database is created, reachable under the non-superuser mega_crm_app role, and dropped"
    requirement: QG-04
    verification:
      - kind: integration
        ref: "provision-db.test.ts — current_database/current_user round-trip, then absence from pg_database"
        status: pass
    human_judgment: false
  - id: D4
    description: "Worker suite provisions its own database with no TEST_DATABASE_URL from the caller, and tears it down on success AND on failure"
    requirement: QG-04
    verification:
      - kind: integration
        ref: "npm run test -w apps/worker → 109 passed; leftover mega_crm_test_% count = 0 after both a passing and a deliberately failing run"
        status: pass
      - kind: e2e
        ref: "GitHub Actions run 30333622531 — same path against compose services"
        status: pass
    human_judgment: false

duration: 12 min
completed: 2026-07-28
status: complete
---

# Phase 8 Plan 02: Ephemeral DB Provisioning + Full DSN Guard Summary

**Per-run ephemeral test databases created under the non-superuser `mega_crm_app` role and destroyed by a drop path that refuses anything outside the `mega_crm_test` namespace before it opens a connection — with the worker suite now provisioning its own database and cleaning up even when it fails.**

## Performance

- **Duration:** 12 min
- **Started:** 2026-07-28T05:54:00Z
- **Completed:** 2026-07-28T06:06:26Z
- **Tasks:** 3
- **Files modified:** 7

## Accomplishments

- **Guard completed to the full SPEC R4 table** — 14 tests over 7 rejecting and 2 accepting rows plus explicit message-content contracts. The default-port row is the first test that actually **reaches the equality condition**, closing the gap 08-01 recorded as a carry-forward.
- **`provision-db.ts`** with the destructive guard as the literal first statement of `dropEphemeralDatabase`, proven by rejecting all four forbidden names against an *unreachable* admin DSN — a connection-error rejection would have shown the guard ran too late.
- **Tests receive a `mega_crm_app` DSN, never the admin one** (D-11) — asserted by a live `current_user` round-trip. A superuser DSN would silently make every RLS assertion in the existing suites vacuous.
- **Teardown survives failure** — a deliberately failing run leaves **zero** `mega_crm_test_%` databases behind, which is the property a `posttest` script could not provide.
- **Validated in both environments** — 109 tests green locally against native Homebrew Postgres, and CI run `30333622531` green against compose services.

## Task Commits

1. **Task 1: full SPEC R4 guard table** — `7f44241` (test)
2. **Task 2: provisioning module** — `cfd6e24` (feat)
3. **Task 3: provision-and-teardown globalSetup** — `620261f` (feat)

## Decisions Made

- **Drop-rule prefix aligned with the guard's.** See Issues Encountered — this was a real bug the tests caught.
- **`quoteIdentifier` exported** rather than module-local. The plan mandates asserting that it escapes embedded double quotes; a module-local helper cannot be asserted directly, and an untested quoting helper is one nobody can trust. It is defense in depth — the `^[a-z0-9_]+$` allow-list already rejects anything containing a quote.
- **Config-load ordering solved by measurement.** `apps/worker/vitest.config.ts` froze `env.DATABASE_URL` from `process.env` at config-evaluation time, before `globalSetup`. Removing the eager key and letting forked workers inherit the mutated `process.env` was **confirmed working in vitest 4.1.9**. The plan's temp-file fallback was not needed.

## Deviations from Plan

### 1. [Rule 1 — Bug] Drop rule was stricter than the guard rule, which would have leaked databases

- **Found during:** Task 2, by the `mega_crm_testing_ground` test row.
- **Issue:** `assertDroppableName` required `mega_crm_test_` (trailing underscore) while `guard.ts` accepts any `mega_crm_test` prefix. A database named e.g. `mega_crm_testing_ground` would therefore pass the guard as a legitimate test database but be **refused at teardown** — leaking it permanently. The two rules disagreeing is worse than either rule alone.
- **Fix:** Aligned `assertDroppableName` to the guard's exact `startsWith(TEST_DATABASE_PREFIX)` rule, with a comment recording why the rules must not diverge.
- **Verification:** `provision-db.test.ts` — the row now passes; all four forbidden names still rejected.
- **Committed in:** `cfd6e24`

**Total deviations:** 1 auto-fixed (1 bug).
**Impact:** Correctness fix within plan scope. No scope creep.

## Issues Encountered

**Two acceptance criteria are mis-specified proxies (both intents verifiably met):**

1. **`grep -c "expect(" guard.test.ts` ≥ 9** contradicts the same task's instruction to use `it.each` — a table collapses assertions into one callback. Resolved by breaking out the message-content assertions the `<behavior>` block separately mandates, which is faithful to the plan rather than a workaround. Now 11 `expect(` calls, 14 tests, 9 table rows.
2. **`grep -c "createEphemeralDatabase" global-setup.ts` = 1** returns 2, because the import line and the call site both match. Both references are genuine.

**Superseded tracer database removed.** 08-01's hand-named `mega_crm_test_worker` was dropped, since this plan replaces it with per-run naming. The pre-existing `mega_crm_test` database was deliberately left alone — it predates Phase 8 and `apps/api` / `delivery-core` still use it until 08-06 consolidates the fixtures.

**`ci.yml` now has a redundant step.** The workflow still creates `mega_crm_test_worker` and exports `TEST_DATABASE_URL`; `globalSetup` overwrites both, so CI passes, but the step creates a stray unused database each run. 08-18 already plans to "remove the tracer's inline creation step" — left for that plan since `ci.yml` is outside this plan's `files_modified`.

## User Setup Required

None. `TEST_ADMIN_DATABASE_URL` must be set locally (no `postgres` role on the Homebrew instance); the compose default works unchanged in CI. Recorded in SPECIFICATION.md §3.2.

## Next Phase Readiness

**Ready for 08-05** (migration linter) and the rest of wave 2. `packages/test-support` now exports the guard and the full provisioning API that 08-06's db-fixture consolidation will build on.

---
*Phase: 08-quality-gates-failure-injection-foundation*
*Completed: 2026-07-28*
