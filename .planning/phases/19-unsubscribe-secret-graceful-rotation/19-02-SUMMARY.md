---
phase: 19-unsubscribe-secret-graceful-rotation
plan: 02
subsystem: delivery
tags: [zod, env-validation, unsubscribe, secret-rotation, boot-guard, check-env]

# Dependency graph
requires:
  - phase: 19-unsubscribe-secret-graceful-rotation
    provides: "Plan 19-01's ordered [primary, ...previous] candidate loop inside verifyUnsubscribeToken -- this plan makes the delivery-core comma-split it relies on unambiguous by enforcing D-03's charset rule at boot"
provides:
  - "apps/api/src/env.ts's superRefine gains full D-01/D-02/D-03/D-07 validation of UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS, plus a tightened comma/whitespace .refine on the primary UNSUBSCRIBE_TOKEN_SECRET"
  - "apps/worker/src/server.ts exports assertUnsubscribeTokenSecrets(), factored out of buildWorker() with the same testability reasoning as logSendgridBaseUrlOverrideIfActive, mirroring the API contract independently"
  - "scripts/check-env.mjs's predev chain gains a conditional structural-validation block for the same variable, plus the same primary charset rule, with the variable itself deliberately absent from baseRequired"
  - "An executable three-site parity assertion (scripts/__tests__/check-env-unsubscribe-previous.test.mjs Block B) proving all three MAX_UNSUBSCRIBE_PREVIOUS_SECRETS=5 declarations agree"
  - "SPECIFICATION.md §3.1/§3.2/§3.3 now describe the real, code-enforced validation contract instead of the 19-01 placeholder"
affects: [19-03-redaction, 19-04-full-rotation-test-coverage, 19-05-runbook]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Independently hard-coded MAX_UNSUBSCRIBE_PREVIOUS_SECRETS constant at three validation sites (apps/api/src/env.ts, apps/worker/src/server.ts, scripts/check-env.mjs), proven equal only by an executable parity regex test rather than a shared import -- this codebase's accepted triplication convention (SPECIFICATION.md §3.1) extended to a new constant"
    - "Real-subprocess CLI testing against temp env-file fixtures (scripts/__tests__/check-env-unsubscribe-previous.test.mjs Block A), same shape as check-lockfile-npm10.test.mjs's execFileSync precedent"

key-files:
  created:
    - apps/worker/src/__tests__/unsubscribe-secret-boot-check.test.ts
    - scripts/__tests__/check-env-unsubscribe-previous.test.mjs
  modified:
    - apps/api/src/env.ts
    - apps/api/src/__tests__/env-schema.test.ts
    - apps/worker/src/server.ts
    - scripts/check-env.mjs
    - SPECIFICATION.md

key-decisions:
  - "Followed 19-RESEARCH.md's Open Question resolutions verbatim: MAX_UNSUBSCRIBE_PREVIOUS_SECRETS hard-coded independently at each of the three sites (no shared cross-package constant), and check-env.mjs's UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS treated as conditional structural validation (no entry in baseRequired) rather than a required-presence name."
  - "Block B's parity regex (\\bMAX\\w*PREVIOUS\\w*\\s*(?::...)?=\\s*5\\b) is deliberately declaration-shaped -- a bare comment mentioning the constant name or the digit 5 cannot satisfy it, only an actual assignment can, closing the anti-vacuity gap RESEARCH.md Pitfall 4 called out."

patterns-established: []

requirements-completed: [ROT-01]

coverage:
  - id: D1
    description: "The API zod schema (apps/api/src/env.ts) rejects a previous-secrets list longer than 5 entries, an entry shorter than 32 chars, an empty entry, an entry duplicating the primary, a duplicate entry, and any whitespace -- while accepting an absent variable and a well-formed list up to 5 entries; the primary secret itself now also rejects a comma or whitespace"
    requirement: "ROT-01"
    verification:
      - kind: unit
        ref: "apps/api/src/__tests__/env-schema.test.ts#envSchema UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS rotation validation (15 new tests) -- npm run test -w apps/api -- env-schema (30/30 pass)"
        status: pass
    human_judgment: false
  - id: D2
    description: "apps/worker/src/server.ts exports assertUnsubscribeTokenSecrets(), enforcing the identical contract independently, called from buildWorker() at the position the prior inline check occupied; no thrown message contains a secret value"
    requirement: "ROT-01"
    verification:
      - kind: unit
        ref: "apps/worker/src/__tests__/unsubscribe-secret-boot-check.test.ts (14 tests) -- npm run test -w apps/worker -- unsubscribe-secret-boot-check (14/14 pass)"
        status: pass
      - kind: other
        ref: "npm run build -w apps/worker (tsc exits 0)"
        status: pass
      - kind: regression
        ref: "npm run test -w apps/worker -- sendgrid-base-url-boot-log (3/3 pass, neighbouring boot logic undisturbed)"
        status: pass
    human_judgment: false
  - id: D3
    description: "scripts/check-env.mjs's predev chain rejects the same malformed shapes via a real subprocess against fixture env files, accepts the variable's absence, and the variable stays outside baseRequired (optional, D-01)"
    requirement: "ROT-01"
    verification:
      - kind: integration
        ref: "scripts/__tests__/check-env-unsubscribe-previous.test.mjs Block A (11 tests, real execFileSync subprocess runs) -- npx vitest run --root scripts __tests__/check-env-unsubscribe-previous.test.mjs"
        status: pass
      - kind: other
        ref: "node scripts/check-env.mjs against the real developer env file (MEGA_CRM_ENV_FILE-resolved) -- exit code 0, tightened primary charset is a no-op on the deployed secret"
        status: pass
    human_judgment: false
  - id: D4
    description: "An executable parity assertion proves apps/api/src/env.ts, apps/worker/src/server.ts and scripts/check-env.mjs all declare the same MAX_UNSUBSCRIBE_PREVIOUS_SECRETS=5, matched by a declaration-shaped regex that a bare comment mention cannot satisfy"
    requirement: "ROT-01"
    verification:
      - kind: unit
        ref: "scripts/__tests__/check-env-unsubscribe-previous.test.mjs Block B (5 tests) -- npx vitest run --root scripts __tests__/check-env-unsubscribe-previous.test.mjs (16/16 pass overall)"
        status: pass
    human_judgment: false
  - id: D5
    description: "SPECIFICATION.md §3.1/§3.2/§3.3 describe the real validation contract in place of the 19-01 placeholder, as four scoped edits (not a rewrite)"
    verification:
      - kind: other
        ref: "npm run check:spec-env-coverage (54 names checked, all present); git diff --stat SPECIFICATION.md shows 4 insertions/4 deletions across 4 lines"
        status: pass
    human_judgment: false

duration: ~40min
completed: 2026-08-20
status: complete
---

# Phase 19 Plan 02: Unsubscribe-secret env-validation triple Summary

**Wired `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` through the API zod schema, the worker's exported `assertUnsubscribeTokenSecrets()`, and the predev `check-env.mjs` script with full D-01/D-02/D-03/D-07 validation parity, tightened the primary secret's charset contract at all three sites, and proved the three agree with an executable parity assertion.**

## Performance

- **Duration:** ~40 min
- **Tasks:** 3/3 completed
- **Files modified:** 7 (2 created, 5 modified)

## Accomplishments
- `apps/api/src/env.ts`'s `superRefine` now validates the ordered previous-secrets list end to end: absent passes (pre-rotation state, D-01), 1-5 well-formed entries pass, 6 entries fail, a 31-char entry fails, empty entries (trailing/adjacent comma) fail, an entry equal to the primary or a duplicate fails, and any whitespace fails. The primary `UNSUBSCRIBE_TOKEN_SECRET` gained a `.refine` rejecting a comma or whitespace (D-03) -- verified as a no-op against the existing `baseValidEnv()` fixture and, in Task 3, against the real deployed dev secret.
- `apps/worker/src/server.ts` factors the prior inline `UNSUBSCRIBE_TOKEN_SECRET` boot check into an exported `assertUnsubscribeTokenSecrets()`, enforcing the identical contract independently (per the codebase's triplication convention), called from `buildWorker()` at the same position. 14 direct unit tests cover every rule, including an explicit assertion that no thrown message contains a secret value.
- `scripts/check-env.mjs` gained a conditional structural-validation block, mirroring the other two sites, that runs only when `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` is present and non-empty -- the variable itself deliberately stayed out of `baseRequired` (optional per D-01). Violation messages name the variable, the rule, and a 1-based entry position, never a secret value.
- `MAX_UNSUBSCRIBE_PREVIOUS_SECRETS = 5` is declared independently at all three sites (D-07, SC4's soft structural bound), and `scripts/__tests__/check-env-unsubscribe-previous.test.mjs`'s Block B proves all three agree via a declaration-shaped regex that a bare comment mention cannot satisfy (RESEARCH.md Pitfall 4's anti-drift guard).
- `SPECIFICATION.md` §3.1, §3.2 (both the `UNSUBSCRIBE_TOKEN_SECRET` and `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` rows), and §3.3's closing note now describe the actual code-enforced contract, replacing 19-01's "validation comes in plan 19-02" placeholder. `check:spec-env-coverage` still reports 54 names, all present.

## Task Commits

Each task was committed atomically:

1. **Task 1: API zod schema — tighten the primary's charset, add the previous-list with full validation** - `15b2d51` (feat, TDD RED-then-GREEN: 10 new tests RED before the schema change, all 30 tests GREEN after)
2. **Task 2: Worker boot check — factor out an exported assertion and give it real coverage** - `ae5502a` (feat, TDD RED-then-GREEN: 7 of 14 tests RED against the not-yet-exported function, all 14 GREEN after the refactor)
3. **Task 3: Predev check-env validation, the three-site parity guard, and the SPECIFICATION.md validation filing** - `ebb88be` (feat, TDD RED-then-GREEN: 13 of 16 tests RED before the script change, all 16 GREEN after; SPECIFICATION.md filed in the same commit)

_No separate plan-metadata commit — this is a worktree-mode parallel executor; STATE.md/ROADMAP.md updates are the orchestrator's responsibility after merge._

## Files Created/Modified
- `apps/api/src/env.ts` - `UNSUBSCRIBE_TOKEN_SECRET` gains a comma/whitespace `.refine`; new optional `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` field; `superRefine` gains the full D-01/D-02/D-03/D-07 guard block; module-level `MAX_UNSUBSCRIBE_PREVIOUS_SECRETS = 5`
- `apps/api/src/__tests__/env-schema.test.ts` - new `describe("envSchema UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS rotation validation")` block, 15 tests covering every rule from both sides of each boundary
- `apps/worker/src/server.ts` - new exported `assertUnsubscribeTokenSecrets()` (with its own `MAX_UNSUBSCRIBE_PREVIOUS_SECRETS = 5`), called from `buildWorker()` in place of the prior inline check
- `apps/worker/src/__tests__/unsubscribe-secret-boot-check.test.ts` - new file, 14 tests covering the full contract plus the no-secret-in-message assertion
- `scripts/check-env.mjs` - new `MAX_UNSUBSCRIBE_PREVIOUS_SECRETS = 5` constant and a conditional validation block after the `missing` handler, before the `PUBLIC_APP_URL` warnings; primary charset check added; `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` deliberately not added to `baseRequired`
- `scripts/__tests__/check-env-unsubscribe-previous.test.mjs` - new file, Block A (11 real-subprocess behavior tests against temp fixtures) + Block B (5 three-site parity tests)
- `SPECIFICATION.md` - §3.2's `UNSUBSCRIBE_TOKEN_SECRET` row gains the charset rule; `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` row replaces the 19-01 placeholder with the real contract; §3.1's `check-env.mjs` sentence notes the new rejections; §3.3's closing note now names `assertUnsubscribeTokenSecrets`

## Decisions Made
- `MAX_UNSUBSCRIBE_PREVIOUS_SECRETS` hard-coded independently at all three sites per 19-RESEARCH.md's resolved Open Question 1 -- no shared cross-package constant, drift caught only by the executable parity test.
- `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` kept out of `check-env.mjs`'s `baseRequired` per resolved Open Question 2 -- it is optional, so there is no presence to require; its structural validation is conditional (runs only when present and non-empty).
- Block B's parity regex (`\bMAX\w*PREVIOUS\w*\s*(?::...)?=\s*5\b`) required an iteration during Task 3: an earlier, more generic form (requiring a leading identifier-start character class before the literal `MAX`) failed to match `MAX_UNSUBSCRIBE_PREVIOUS_SECRETS` because the leading class consumed the `M` before the `MAX` literal could match. Simplified to anchor on `\bMAX` directly, which correctly matches all three real declarations while still rejecting a bare comment mention (verified: the regex requires an actual `= 5` assignment, not just the substring "MAX...PREVIOUS" appearing in prose).

## Deviations from Plan

None - plan executed exactly as written. The regex fix above was iteration within Task 3's own TDD RED/GREEN cycle (the test was RED for the wrong reason on the first implementation attempt, corrected before the task's stated verify command was run to completion), not a deviation from the plan's design.

## Issues Encountered
- Task 3's Block B parity regex needed one correction mid-task (see Decisions above) — resolved within the same TDD cycle, no plan change required.

## User Setup Required
None - no external service configuration required. `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` remains optional and unset in every existing deploy; its absence is the normal pre-rotation state (D-01), proven again here by both the schema test and the check-env.mjs fixture test.

## Next Phase Readiness
- All three validation sites (API, worker, predev check) now enforce D-01/D-02/D-03/D-07 identically, with an executable parity guard proving they cannot silently drift apart.
- `node scripts/check-env.mjs` against this machine's real developer env file exits 0 — the tightened primary charset rule is confirmed a no-op against the deployed production/dev `UNSUBSCRIBE_TOKEN_SECRET`, so no rotation runbook caveat is needed for this specific environment.
- 19-03 (redaction) and 19-04 (full rotation test coverage) can build on a now-fully-validated env contract; 19-05 (runbook) can reference `MAX_UNSUBSCRIBE_PREVIOUS_SECRETS = 5` as the documented hard cap.
- No blockers.

---
*Phase: 19-unsubscribe-secret-graceful-rotation*
*Completed: 2026-08-20*
