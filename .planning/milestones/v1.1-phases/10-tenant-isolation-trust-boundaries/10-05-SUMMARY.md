---
phase: 10-tenant-isolation-trust-boundaries
plan: 05
subsystem: testing
tags: [ci, eslint, vitest, security, session-state, postgres, pgbouncer]

# Dependency graph
requires:
  - phase: 10-01
    provides: packages/tenant-context/src/index.ts's withTenantTransaction / packages/tenant-context/src/scan.ts's withCrossWorkspaceScan, the two real call sites this audit is proven against
provides:
  - scripts/lint-session-state.mjs — a Node-builtins-only, fixture-proven audit that fails the build on any connection-scoped (non-transaction-local) session-state statement, any role switch, or any set_config(...) call whose third argument isn't the literal `true`
  - npm script `lint:session-state` and a blocking `Session-state audit` step in the `static` CI job, immediately after the migration linter
  - the written "session state is transaction-local only" rule in CONVENTIONS.md, with its `session-state-exception:` marker documented in docs/lint-rule-exceptions.md
affects: [phase-14-database-lifecycle]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Gate script shape: Node builtins only, pure exported functions, CLI behind an import.meta.url guard (same shape as lint-migrations.mjs, coverage-gate.mjs, check-root-hygiene.mjs)"
    - "Detect a session-state SQL statement by its FIRST keyword, not by substring match, so UPDATE ... SET ... clauses (all over this codebase) never collide with a standalone SET/RESET statement"
    - "Case-sensitive keyword matching for SQL-shaped detection in TS source, to avoid colliding with ordinary lowercase English ('set null' as a Drizzle onDelete value, 'set X failed' in a test assertion message)"

key-files:
  created:
    - scripts/lint-session-state.mjs
    - scripts/__tests__/lint-session-state.test.mjs
    - scripts/__fixtures__/session-state/violating.ts
    - scripts/__fixtures__/session-state/compliant.ts
    - scripts/vitest.config.ts
  modified:
    - package.json
    - package-lock.json
    - vitest.config.ts
    - .github/workflows/ci.yml
    - CONVENTIONS.md
    - docs/lint-rule-exceptions.md
    - SPECIFICATION.md

key-decisions:
  - "Detection keys off the SQL string literal's FIRST keyword, not a substring search, so `UPDATE sends SET status = $2` (present in ~20 real call sites) never collides with a standalone `SET ...` session-state statement."
  - "SET/RESET/ROLE keyword matching is case-sensitive (uppercase only), deviating from the case-insensitive draft, after two real false positives surfaced during Test 6 against the actual repo tree."
  - "scripts/ needed its own vitest project (scripts/vitest.config.ts, registered in the root aggregate) — the plan's own verify command failed with \"No test files found\" against the pre-existing eight-project workspace, none of which covers scripts/."

patterns-established:
  - "Pattern 1: A gate script's JS/TS comment-stripping is string-literal-aware (tracks single/double/backtick quote state before treating `//` or `/* */` as a comment start), so a `//` inside a URL string is never misread as a comment."

requirements-completed: [SEC-16]

coverage:
  - id: D1
    description: "scripts/lint-session-state.mjs fails on a connection-scoped SET, a role switch (even with LOCAL), or a set_config(...) call whose third argument isn't the literal true"
    requirement: "SEC-16"
    verification:
      - kind: unit
        ref: "scripts/__tests__/lint-session-state.test.mjs#Test 1 — the violating fixture fails with exactly three violations"
        status: pass
      - kind: unit
        ref: "scripts/__tests__/lint-session-state.test.mjs#Test 4 — set_config with a non-true third argument, and the two-argument form"
        status: pass
      - kind: unit
        ref: "scripts/__tests__/lint-session-state.test.mjs#role switch is reported unconditionally, even with LOCAL"
        status: pass
    human_judgment: false
  - id: D2
    description: "A source file using only transaction-local session state (SET LOCAL, set_config(..., true)) passes cleanly"
    requirement: "SEC-16"
    verification:
      - kind: unit
        ref: "scripts/__tests__/lint-session-state.test.mjs#Test 2 — the compliant fixture passes"
        status: pass
    human_judgment: false
  - id: D3
    description: "Comment-stripping runs before matching, so prose describing the forbidden constructs in a code comment does not self-invalidate the compliant fixture"
    requirement: "SEC-16"
    verification:
      - kind: unit
        ref: "scripts/__tests__/lint-session-state.test.mjs#Test 3 — comment-stripping: prose describing the forbidden forms is not self-invalidating"
        status: pass
    human_judgment: false
  - id: D4
    description: "The audit scans the whole first-party source tree (apps/api/src, apps/worker/src, packages/*/src, packages/db/scripts) enumerated from the filesystem, not a hand-listed set, and reports zero violations against the real 309-file tree"
    requirement: "SEC-16"
    verification:
      - kind: unit
        ref: "scripts/__tests__/lint-session-state.test.mjs#Test 6 — the real repository source tree is clean"
        status: pass
    human_judgment: false
  - id: D5
    description: "The audit runs in CI as a blocking step in the static job's required check, immediately after the migration linter"
    requirement: "SEC-16"
    verification:
      - kind: other
        ref: ".github/workflows/ci.yml static job — 'Session-state audit' step running npm run lint:session-state, verified present via grep and by re-running npm run lint:session-state locally (exit 0)"
        status: pass
    human_judgment: false
  - id: D6
    description: "The documented exception marker (session-state-exception: <reason>) suppresses exactly one statement, requires a reason, and is not honoured as a file-header blanket form"
    requirement: "SEC-16"
    verification:
      - kind: unit
        ref: "scripts/__tests__/lint-session-state.test.mjs#Test 5 — the exception marker requires a reason"
        status: pass
    human_judgment: false

duration: 30min
completed: 2026-08-07
status: complete
---

# Phase 10 Plan 05: Session-State Audit Summary

**A Node-builtins-only CI gate (`scripts/lint-session-state.mjs`) that fails the build on any connection-scoped session-state statement, unconditionally on any role switch, and on `set_config(...)` calls missing a literal `true` third argument — proven against a three-violation fixture and a clean 309-file run of the real tree.**

## Performance

- **Duration:** ~30 min
- **Completed:** 2026-08-07T14:46:00Z
- **Tasks:** 2
- **Files modified:** 12 (5 created, 7 modified, including SPECIFICATION.md upkeep)

## Accomplishments

- `scripts/lint-session-state.mjs`: strips JS/TS comments in a string-literal-aware way (so a `//` inside a URL like `"https://api.sendgrid.com/..."` is never misread as a comment start), extracts every quoted/template string literal, and flags (1) a literal whose FIRST statement keyword is `SET` without `LOCAL`; (2) any role-switch form (`SET`/`RESET ROLE`, `SET SESSION AUTHORIZATION`) unconditionally, even with a `LOCAL`/`SESSION` scope qualifier; (3) `set_config(...)` calls whose third argument isn't the literal `true`, including the two-argument form.
- Fixture-proven fail-first: `scripts/__fixtures__/session-state/violating.ts` produces exactly three violations (one per rule); `compliant.ts` proves every accepted form, a correctly-marked exception, and forbidden-construct prose in a comment are all left alone.
- `npm run lint:session-state` wired into the `static` CI job as a blocking `Session-state audit` step, immediately after `Migration linter` — `static` is already a required status check under Phase 8's branch protection.
- CONVENTIONS.md's "Session state is transaction-local only" rule and its reason (Phase 14's transaction-mode PgBouncer pooling makes reuse of a connection carrying leaked session state both more frequent and less predictable); the `session-state-exception:` marker documented in `docs/lint-rule-exceptions.md` in the same register used for every other exception mechanism in the repo.
- SPECIFICATION.md as-built updated per CLAUDE.md's upkeep rule: the new root `vitest` devDependency (§2.1), the new CI step (§1.3 job table), the new `scripts/lint-session-state.mjs` paragraph, and the ninth `vitest.config.ts` project registration with the reason it was needed.

## Task Commits

Each task was committed atomically:

1. **Task 1: The audit script and its violating fixture** - `7cb8e5a` (test) — script, both fixtures, and the full test suite (21 tests, all 6 plan behaviors)
2. **Task 2: Wire the audit into npm scripts, CI, and the written conventions** - `7a2f08a` (feat) — `lint:session-state` npm script, CI step, CONVENTIONS.md rule, exception-marker docs

**Additional commit (SPECIFICATION.md upkeep, CLAUDE.md rule):** `afd85c4` (docs)

_Note: Task 1 is `tdd="true"`; the fixture-and-test work landed as a single `test(...)` commit rather than a separate RED/GREEN pair, since the script's correctness was proven interactively against the fixtures and the real tree before committing (all 21 tests passing at commit time, not a deliberately-failing intermediate state)._

## Files Created/Modified

- `scripts/lint-session-state.mjs` - the audit: comment-stripping, string-literal extraction, first-keyword SET/role-switch detection, set_config argument validation, exception-marker suppression, filesystem-enumerated directory walk, CLI entry
- `scripts/__tests__/lint-session-state.test.mjs` - 21 tests covering all 6 plan behaviors plus two extra guard-rail groups (UPDATE...SET is not flagged; role switch is unconditional even with LOCAL)
- `scripts/__fixtures__/session-state/violating.ts` - three distinct violations (connection-scoped assignment, role switch, set_config non-true third arg)
- `scripts/__fixtures__/session-state/compliant.ts` - SET LOCAL, set_config(..., true), a correctly-marked exception, and forbidden-construct prose in a comment
- `scripts/vitest.config.ts` - new vitest project so `scripts/__tests__/*.test.mjs` is discoverable at all (deviation, see below)
- `package.json` - `lint:session-state` script; `vitest` added to root devDependencies
- `package-lock.json` - regenerated via `npm install --package-lock-only` after the devDependency addition
- `vitest.config.ts` - `scripts/vitest.config.ts` added to the root aggregate's `projects` array
- `.github/workflows/ci.yml` - `Session-state audit` step in the `static` job
- `CONVENTIONS.md` - "Session state is transaction-local only" rule section; `lint-session-state.mjs` added to the "Gate scripts" bullet's example list
- `docs/lint-rule-exceptions.md` - `session-state-exception` marker documentation section
- `SPECIFICATION.md` - as-built updates across §1.3 (CI job table, new script paragraph, vitest.config.ts paragraph) and §2.1 (root vitest devDependency)

## Decisions Made

- **First-keyword detection, not substring search.** The checker only flags a SQL string literal whose FIRST token (after trimming) is `SET`/`RESET`. This is what lets `UPDATE sends SET status = $2::send_status` — present in roughly 20 real call sites across `apps/api/src` and `apps/worker/src` — pass cleanly, while a standalone `SET app.current_workspace_id = ...` is caught. A substring-based approach would have false-positived on every UPDATE statement in the codebase.
- **Case-sensitive SET/ROLE keyword matching.** Discovered while proving Test 6 (the real-tree clean run): a case-insensitive `/^SET\s+/i` pattern matched Drizzle's `{ onDelete: "set null" }` API string (three schema files) and a test assertion message starting `` `set externalId failed: ...` ``. Every real session-state SQL statement in this codebase is written in uppercase SQL-keyword style, so restricting the match to uppercase loses no real detection coverage while eliminating both false-positive classes.
- **`scripts/` needed its own vitest project.** The plan's own verify command (`npx vitest run scripts/__tests__/lint-session-state.test.mjs`) is not merely a suggestion — it's what CI would run. Against the pre-existing root `vitest.config.ts`'s `test.projects` workspace array (eight projects, none matching `scripts/`), it failed with "No test files found". Added `scripts/vitest.config.ts` (same minimal node-environment shape as `packages/kms`/`packages/segments-core`) and registered it in the aggregate. `scripts/` is deliberately absent from `coverage.include`, so the new project runs tests without joining the backend coverage denominator.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Case-insensitive SET/ROLE detection produced two real false positives**
- **Found during:** Task 1, while proving Test 6 (repo-wide clean run) as required by the plan's own action text ("if it fails, fix the offending source in this plan and record it in the SUMMARY")
- **Issue:** The first draft of `SET_STATEMENT_PATTERN`/`ROLE_SWITCH_PATTERN`/`SET_LOCAL_PATTERN` used the `/i` flag. This matched `packages/db/src/schema/{flow-run-steps,send-events,sends}.ts`'s Drizzle `{ onDelete: "set null" }` values and `apps/api/src/modules/contacts/__tests__/contact-crud.test.ts`'s `` `set externalId failed: ${...}` `` assertion message — neither is a SQL statement.
- **Fix:** Removed the `/i` flag from all three patterns (kept case-insensitive only for `set_config(` detection, which is a much narrower literal-substring match with no realistic collision risk). Documented the reasoning inline in the script.
- **Files modified:** scripts/lint-session-state.mjs
- **Verification:** Test 6 passes with 0 violations across 309 files (was 4 violations before the fix); `npm run lint:session-state` from repo root also exits 0.
- **Committed in:** `7cb8e5a` (Task 1 commit — the fix landed before the first commit, so there is no separate "before/after" pair in git history)

**2. [Rule 1 - Bug] `SET LOCAL ROLE ...` was misclassified as the accepted transaction-local form**
- **Found during:** Task 1, while writing the role-switch test cases
- **Issue:** The initial `ROLE_SWITCH_PATTERN` (`^(SET\s+SESSION\s+AUTHORIZATION|SET\s+ROLE|RESET\s+ROLE|RESET\s+SESSION\s+AUTHORIZATION)`) required `SET` to be immediately followed by `ROLE`. `SET LOCAL ROLE mega_crm_admin` is valid Postgres grammar and would instead match `SET_LOCAL_PATTERN` first in evaluation order, misreading a role switch as the accepted assignment form — exactly the gap T-10-05-02 exists to close (a role switch has no accepted form "at all," LOCAL or not).
- **Fix:** Extended the pattern to `^(SET\s+(?:LOCAL\s+|SESSION\s+)?(?:ROLE\b|SESSION\s+AUTHORIZATION\b)|RESET\s+(?:ROLE\b|SESSION\s+AUTHORIZATION\b))`, checked before `SET_LOCAL_PATTERN`.
- **Files modified:** scripts/lint-session-state.mjs
- **Verification:** `scripts/__tests__/lint-session-state.test.mjs`'s "role switch is reported unconditionally, even with LOCAL" test case (`SET LOCAL ROLE mega_crm_admin`) passes.
- **Committed in:** `7cb8e5a` (Task 1 commit)

**3. [Rule 3 - Blocking] `scripts/` had no vitest project, so the plan's verify command couldn't run at all**
- **Found during:** Task 1, first attempt to run `npx vitest run scripts/__tests__/lint-session-state.test.mjs`
- **Issue:** Root `vitest.config.ts`'s `test.projects` workspace array listed eight projects, none of which matches `scripts/`. Running the exact command the plan's `<verify>` block specifies returned "No test files found, exiting with code 1" against every configured project.
- **Fix:** Added `scripts/vitest.config.ts` (minimal node-environment config, mirroring `packages/kms`/`packages/segments-core`'s own standalone configs) and registered it as a ninth entry in the root aggregate's `projects` array. Also added `vitest` to root `package.json` devDependencies (it was previously declared only per-workspace) to satisfy `import-x/no-extraneous-dependencies` for the new root-level import, and regenerated `package-lock.json` via `npm install --package-lock-only`.
- **Files modified:** scripts/vitest.config.ts (new), vitest.config.ts, package.json, package-lock.json
- **Verification:** `npx vitest run scripts/__tests__/lint-session-state.test.mjs` now discovers and runs all 21 tests, exit 0. `npm run lint` still exits 0 (confirms the new devDependency satisfies the lint rule). `npm run build --workspaces --if-present` unaffected (scripts/ has no tsconfig, unchanged by this addition).
- **Committed in:** `7cb8e5a` (Task 1 commit)

---

**Total deviations:** 3 auto-fixed (2 correctness bugs found via the plan's own fail-first requirement, 1 blocking test-infrastructure gap)
**Impact on plan:** All three were necessary to make the plan's own stated `<verify>` command actually pass, and to make Test 6 (the real-tree clean run) a genuine proof rather than a vacuous one. No scope creep — no source files outside `scripts/`, `package.json`, `vitest.config.ts`, and the documentation files the plan already named were touched.

## Issues Encountered

None beyond the three deviations documented above.

## Known Stubs

None. Both fixtures are deliberately minimal but fully functional demonstrations (one violating, one compliant) — not stubs standing in for unimplemented behavior.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `npm run lint:session-state` is a blocking CI gate on `master` (via the `static` required check) starting with this plan's merge — any future connection-scoped session-state statement or role switch fails the build immediately, closing the precondition Phase 14 (DB-14) needs before PgBouncer transaction-mode pooling can be introduced safely.
- The exception marker mechanism exists and is tested but has zero live uses in the codebase today — every current session-state call site already uses an accepted form.
- No blockers for the remaining Phase 10 plans.

---
*Phase: 10-tenant-isolation-trust-boundaries*
*Completed: 2026-08-07*
