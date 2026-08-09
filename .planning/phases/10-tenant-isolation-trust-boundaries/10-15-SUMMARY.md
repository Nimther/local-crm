---
phase: 10-tenant-isolation-trust-boundaries
plan: 15
subsystem: infra
tags: [node, postgres, pg, vitest, env-loading, predev, dev-tooling]

# Dependency graph
requires:
  - phase: 10-tenant-isolation-trust-boundaries
    provides: "scripts/ensure-db-roles.mjs (plan 10-01), scripts/env-path.mjs (08-15/QG-07 single decision point), scripts/lint-session-state.mjs subprocess-test house pattern (10-05)"
provides:
  - "scripts/ensure-db-roles.mjs resolves its admin DSN through resolveEnvPath() like every sibling predev-chain script, closing gap G-10-1"
  - "scripts/__tests__/ensure-db-roles-env.test.mjs — subprocess proof the fix works end to end, without touching a real database"
  - "scripts/__tests__/predev-env-loading.test.mjs — package.json-derived guard against this failure class recurring through a future predev-chain member"
  - "SPECIFICATION.md and check-env.mjs document why the admin DSN variables are not hard-required and where the guard now lives"
affects: [phase-10-uat, cold-start-onboarding, future-predev-chain-scripts]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Module-scope guarded process.loadEnvFile(resolveEnvPath()) before any DSN-resolving function, mirrored from migrate-dev.mjs — the established shape every predev-chain script must follow"
    - "Subprocess CLI tests with explicit child env (never inherited) to prove precedence/fallback contracts without ever touching a real Postgres connection"
    - "Enumeration-from-source-of-truth guards: parse package.json's predev script string instead of hand-maintaining a file list, so a future chain member is covered automatically"

key-files:
  created:
    - scripts/__tests__/ensure-db-roles-env.test.mjs
    - scripts/__tests__/predev-env-loading.test.mjs
  modified:
    - scripts/ensure-db-roles.mjs
    - scripts/check-env.mjs
    - SPECIFICATION.md

key-decisions:
  - "Fix mirrors migrate-dev.mjs's exact try/catch process.loadEnvFile(resolveEnvPath()) shape at module scope, before DEFAULT_ADMIN_DSN/resolveAdminDsn, rather than inventing a new loading pattern"
  - "The predev-chain guard matches the sibling env-path import by module specifier, not by imported binding name, so a namespace import or renamed binding still counts as compliant"
  - "check-env.mjs gets a comment-only explanation for why admin DSN vars stay outside baseRequired — hard-requiring them would fail correctly-configured compose/CI environments"

patterns-established:
  - "Any new predev-chain script that reads a DATABASE_URL-suffixed variable must import ./env-path.mjs — enforced by scripts/__tests__/predev-env-loading.test.mjs, not just review"

requirements-completed: [SEC-01, SEC-02]

coverage:
  - id: D1
    description: "scripts/ensure-db-roles.mjs resolves its admin DSN from the external env file via resolveEnvPath(), proven by a subprocess test that fails against the pre-fix script and passes after"
    requirement: "SEC-01"
    verification:
      - kind: integration
        ref: "scripts/__tests__/ensure-db-roles-env.test.mjs > Test 1 (the gap)"
        status: pass
    human_judgment: false
  - id: D2
    description: "A directly exported admin DSN variable still outranks the env file, and a missing env file is tolerated without crashing"
    requirement: "SEC-01"
    verification:
      - kind: integration
        ref: "scripts/__tests__/ensure-db-roles-env.test.mjs > Test 2, Test 3"
        status: pass
    human_judgment: false
  - id: D3
    description: "Automated guard derives the predev chain from package.json and fails if any DSN-resolving member stops routing through resolveEnvPath()"
    requirement: "SEC-02"
    verification:
      - kind: unit
        ref: "scripts/__tests__/predev-env-loading.test.mjs > The real predev chain"
        status: pass
    human_judgment: false
  - id: D4
    description: "Cold start from scratch (npm run predev then npm run dev) reaches migrations and serves live data on the Homebrew-Postgres machine that reported G-10-1"
    requirement: "SEC-01"
    verification: []
    human_judgment: true
    rationale: "Requires a specific external Homebrew-Postgres machine with the external env file already configured, and a live SendGrid-dependent npm run dev boot — not reproducible inside this sandboxed worktree. The plan's own <verification> section explicitly defers this to an end-of-phase human check, not per-plan."

# Metrics
duration: 15min
completed: 2026-08-09
status: complete
---

# Phase 10 Plan 15: Predev Admin-DSN Env-Loading Gap Closure Summary

**Closed G-10-1 by giving `scripts/ensure-db-roles.mjs` the same `resolveEnvPath()` env-loading step every sibling predev script already has, plus a package.json-derived guard that fails automatically if a future predev-chain script skips it.**

## Performance

- **Duration:** ~15 min
- **Completed:** 2026-08-09
- **Tasks:** 3
- **Files modified:** 5

## Accomplishments

- `scripts/ensure-db-roles.mjs` now loads the external env file (`resolveEnvPath()`) before resolving its admin DSN, mirroring `migrate-dev.mjs`'s exact pattern — the recurrence of the 08-07 failure class (SPECIFICATION.md:107) is closed
- Three subprocess tests prove the fix end to end without ever opening a real Postgres connection: the gap itself (file-only DSN was invisible pre-fix), precedence preserved (an exported var still outranks the file), and missing-file tolerance
- A package.json-derived guard (`predev-env-loading.test.mjs`) makes this failure class non-recurring: it parses the `predev` script string for its member scripts and fails if any of them mentions a `DATABASE_URL`-suffixed variable without importing `./env-path.mjs`
- SPECIFICATION.md and `check-env.mjs` now document the three-level admin-DSN precedence (`GSD_ADMIN_DATABASE_URL` → `TEST_ADMIN_DATABASE_URL` → compose-default) and why those two variables are deliberately absent from the hard-required env-check list

## Task Commits

Each task was committed atomically (TDD RED/GREEN split for Task 1):

1. **Task 1a (RED): Add failing test for admin DSN env-loading gap** - `feb0621` (test)
2. **Task 1b (GREEN): Load the external env file before resolving the admin DSN** - `bdb67d1` (feat)
3. **Task 2: Guard the predev chain with a package.json-derived rule** - `a050cab` (test)
4. **Task 3: Record the admin-DSN resolution contract in SPECIFICATION.md and check-env.mjs** - `3bdf145` (docs)

_Note: Task 1 is `type="tracer" tdd="true"`, so it split into a RED test-only commit and a GREEN fix commit per the TDD execution flow — both tasks in the plan's own numbering are covered by these four commits._

## Files Created/Modified

- `scripts/ensure-db-roles.mjs` - Added the guarded `process.loadEnvFile(resolveEnvPath())` load at module scope, before `DEFAULT_ADMIN_DSN`/`resolveAdminDsn`; no change to precedence order or the fallback constant
- `scripts/__tests__/ensure-db-roles-env.test.mjs` - Three subprocess cases against the real CLI with an explicit (never-inherited) child env, asserting on the `host:port` substring in node-postgres's connection-refused message, never on a printed DSN
- `scripts/__tests__/predev-env-loading.test.mjs` - Pure rule (`checkEnvPathCompliance`) plus anti-vacuity cases and a real-chain case that enumerates `predev`'s script members from `package.json` and fails on the first non-compliant one
- `SPECIFICATION.md` - New `GSD_ADMIN_DATABASE_URL` table row with full precedence, extended `TEST_ADMIN_DATABASE_URL` row naming the second consumer, new Phase 10 paragraph cross-referencing 08-07 as the same failure class
- `scripts/check-env.mjs` - Comment-only block above `baseRequired` explaining why the admin DSN variables are deliberately not hard-required, and pointing at the Task 2 guard as the check that now covers that seam

## Decisions Made

- Mirrored `migrate-dev.mjs`'s exact env-loading shape rather than introducing a new pattern — keeps every predev-chain script following one convention, which is also what the Task 2 guard now enforces mechanically
- The predev-chain guard matches the sibling import by module specifier (`"./env-path.mjs"`), not by the imported binding name, so a future script using a namespace import or a renamed binding is still recognized as compliant
- No production code changes were needed for Task 2 (only a new test file) — the underlying fix already landed in Task 1, so Task 2 is a load-bearing regression guard rather than a second fix

## Deviations from Plan

None — plan executed as written. One judgment call, documented below rather than as a Rule 1-4 deviation since it did not require a code change:

**Tracer feedback gate on a plan-deferred human check:** Task 1 is `type="tracer"`, whose `<verify>` block includes a `<human-check>` step ("On the Homebrew-Postgres machine that reported the gap... run `npm run predev`... then `npm run dev`..."). The plan's own `<verification>` section explicitly labels this "Human cold-start check (end-of-phase)" — i.e., designed to run once at phase-end on the specific machine that reported G-10-1, not per-plan inside this sandboxed worktree (which has no such machine or SendGrid-live boot available). The tracer feedback gate's automated re-verify (both `<automated>` lines: the vitest suite and the grep check) was re-run post-fix and passed, which is treated as satisfying the gate for this autonomous wave-execution context. The deferred human check is tracked as coverage item D4 (`human_judgment: true`) above so it is visible to the phase-end UAT.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required. (The phase-level human cold-start check on the Homebrew-Postgres machine remains an end-of-phase UAT item per the plan's own design — see coverage item D4.)

## Next Phase Readiness

- Gap G-10-1 is closed at the code level: `npm run predev` no longer aborts at step 2 when the admin DSN lives only in the external env file
- Remaining: the end-of-phase human cold-start check (UAT Test 1) on the Homebrew-Postgres machine that originally reported the gap, plus `npm run dev` confirming a live authenticated call — both explicitly deferred by the plan's own `<verification>` section, not a blocker introduced by this plan

---
*Phase: 10-tenant-isolation-trust-boundaries*
*Completed: 2026-08-09*
