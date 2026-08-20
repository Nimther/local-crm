---
phase: 19-unsubscribe-secret-graceful-rotation
plan: 03
subsystem: security
tags: [redaction, pino, logging, secrets, unsubscribe, hmac]

# Dependency graph
requires:
  - phase: 19-unsubscribe-secret-graceful-rotation
    provides: "19-01's ordered [primary, ...previous] candidate loop inside verifyUnsubscribeToken and the UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS env var it introduced"
provides:
  - "Two new keyRules entries in packages/redaction/src/rules.ts (UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS, UNSUBSCRIBE_TOKEN_SECRET), covering both unsubscribe signing-secret variable names in the single rule table both compiled redaction forms derive from"
  - "Parity test proof (Test 13/14) that a field carrying either name is censored identically by pino-redact.ts and scrub.ts, at root and nested, without narrowing existing coverage"
affects: [19-04-full-rotation-test-coverage, 19-05-runbook]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Rule key spelled as the literal environment-variable name (not camelCase), because scrub.ts's matcher is exact lower-cased-string equality, not substring/prefix matching -- confirmed against the actual matcher source rather than assumed from 19-PATTERNS.md's camelCase suggestion"

key-files:
  created: []
  modified:
    - packages/redaction/src/rules.ts
    - packages/redaction/src/__tests__/rules-parity.test.ts

key-decisions:
  - "Corrected 19-PATTERNS.md's suggested camelCase rule key (e.g. unsubscribeTokenSecretPrevious) to the exact environment-variable spelling (UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS) after reading scrub.ts's matcher: KEY_RULE_NAMES.has(key.toLowerCase()) is exact-match, not substring, so a camelCase key would never match a field literally named after the env var and the rule would be a no-op."
  - "Split the plan's single 'lower-cased spelling redacts in both forms' assertion into two tests: Test 13 covers both compiled forms for the exact-cased env-var spelling (root, nested, non-secret sibling untouched); Test 14 scopes the lower-cased-spelling assertion to scrub() only, because empirical probing showed Pino's fast-redact path list does exact case-sensitive string matching with no case-folding -- the case-insensitive contract documented in rules.ts's header only actually holds for scrub.ts's matcher. This is a pre-existing structural limit shared by every rule already in the table (e.g. sendgridKey vs sendgridkey), not a gap this plan introduces or could close without editing pino-redact.ts, which the plan explicitly forbids."

patterns-established: []

requirements-completed: [ROT-01]

coverage:
  - id: D1
    description: "UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS and UNSUBSCRIBE_TOKEN_SECRET are covered by exact-spelled keyRules entries in the single rule table; a field named either, at the root or nested two levels deep, is censored identically by both compiled forms (Pino path list and scrub() recursive walker), while a non-secret sibling field is left untouched by both (ROT-01, D-02)"
    requirement: "ROT-01"
    verification:
      - kind: unit
        ref: "packages/redaction/src/__tests__/rules-parity.test.ts#Test 13 (ROT-01, D-02): a payload carrying the unsubscribe signing-secret environment-variable field names -- at the root and nested two levels deep -- is censored identically by both compiled forms, and a non-secret sibling is untouched by both, so the new rules are targeted rather than blanket"
        status: pass
    human_judgment: false
  - id: D2
    description: "scrub()'s case-insensitive matcher contract (KEY_RULE_NAMES.has(key.toLowerCase())) holds for the two new rule keys the same as for every pre-existing rule"
    requirement: "ROT-01"
    verification:
      - kind: unit
        ref: "packages/redaction/src/__tests__/rules-parity.test.ts#Test 14 (ROT-01, D-02): a lower-cased spelling of the previous-secrets field name still redacts through scrub()"
        status: pass
    human_judgment: false
  - id: D3
    description: "No rule literal was introduced in pino-redact.ts or scrub.ts, and no existing rule/wildcard depth was narrowed or removed -- both consumer files have zero diff and the full redaction suite plus the Sentry fixture gate stay green"
    verification:
      - kind: unit
        ref: "npm run test -w packages/redaction (31/31 pass, all 5 test files)"
        status: pass
      - kind: other
        ref: "npm run check:sentry-redaction (6/6 pass)"
        status: pass
      - kind: other
        ref: "git status --porcelain packages/redaction/src/pino-redact.ts packages/redaction/src/scrub.ts (empty)"
        status: pass
    human_judgment: false

duration: ~15min
completed: 2026-08-20
status: complete
---

# Phase 19 Plan 03: Redaction coverage for unsubscribe signing-secret env vars Summary

**Added `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` and `UNSUBSCRIBE_TOKEN_SECRET` as exact env-var-spelled `keyRules` entries in the single redaction rule table, proven by a parity test to censor identically in both compiled forms at root and nested depth.**

## Performance

- **Duration:** ~15 min
- **Tasks:** 1/1 completed
- **Files modified:** 2 (both modified, no files created)

## Accomplishments
- `packages/redaction/src/rules.ts` gains two `keyRules` entries, spelled exactly as the environment-variable names (`UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS`, `UNSUBSCRIBE_TOKEN_SECRET`), correcting 19-PATTERNS.md's proposed camelCase key which would never have matched given `scrub.ts`'s exact lower-cased-equality matcher.
- A field carrying either name -- at the root, or two levels deep nested -- is censored to `[REDACTED]` identically by both `pino-redact.ts`'s compiled Pino path list and `scrub.ts`'s recursive walker, while a non-secret sibling field is left untouched by both, proving the rules are targeted rather than blanket.
- `scrub()`'s case-insensitive matcher contract is proven to hold for the new keys, same as every pre-existing rule.
- Neither `pino-redact.ts` nor `scrub.ts` was edited -- both derive unchanged from the single rule table, confirmed by an empty `git status --porcelain` on both files.
- Full redaction suite (31/31 across 5 test files) and the Sentry fixture gate (`check:sentry-redaction`, 6/6) both pass.

## Task Commits

Each step of the TDD cycle was committed atomically:

1. **Task 1 (RED): failing parity test for unsubscribe secret redaction** - `99dab56` (test)
2. **Task 1 (GREEN): cover unsubscribe signing-secret env var names in redaction rule table** - `2477dab` (feat)

_No separate plan-metadata commit -- this is a worktree-mode parallel executor; STATE.md/ROADMAP.md updates are the orchestrator's responsibility after merge._

## Files Created/Modified
- `packages/redaction/src/rules.ts` - two new `keyRules` entries (`UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS`, `UNSUBSCRIBE_TOKEN_SECRET`) added to the "other secret-shaped field names" group, each with a `protects` string naming the HMAC signing secret and its read site (`packages/delivery-core/src/unsubscribe-token.ts`), plus a comment recording the exact-spelling rationale and the `packages/delivery-core` defence-in-depth note
- `packages/redaction/src/__tests__/rules-parity.test.ts` - Test 13 (both compiled forms, root + nested + non-secret sibling) and Test 14 (scrub()-only case-insensitive spelling check)

## Decisions Made
- **Exact env-var spelling over camelCase:** read `scrub.ts`'s matcher (`KEY_RULE_NAMES.has(key.toLowerCase())`, exact equality on the lower-cased key) before writing the rule, and used the environment-variable spelling rather than 19-PATTERNS.md's suggested camelCase transformation, which would have been a silent no-op.
- **Case-insensitivity scoped to scrub() only:** empirically verified (via a throwaway `node` script, deleted before commit) that Pino's `fast-redact` path list does exact case-sensitive string matching with no case-folding -- a lower-cased field name is NOT redacted through the Pino form even though the rule key exists. This is a pre-existing structural limit of `pino-redact.ts` affecting every rule already in the table equally, not something the new rules introduce or could fix without editing `pino-redact.ts` (which the plan explicitly forbids). The plan's behavior spec's "case-insensitive contract" language is satisfied for `scrub.ts`, which is the compiled form that actually documents and implements case-insensitive matching.

## Deviations from Plan

None (Rule-classified) -- the test structure was adjusted from the plan's literal behavior description (one test asserting lower-cased-spelling redaction "in both compiled forms") to two tests, after discovering during the RED/GREEN cycle that Pino's redact path list is case-sensitive by construction and the original single-test formulation would have required either an incorrect assertion or editing `pino-redact.ts` (explicitly forbidden by the plan). This is a same-scope test-authoring correction grounded in the actual matcher behavior the plan's own `<read_first>` instructed reading, not a change to what was delivered (both new rule keys, both compiled forms, root + nested coverage, non-blanket proof) — all of which match the plan exactly.

## Issues Encountered
- Initial test formulation asserted the lower-cased spelling redacts through both `logViaPino` and `scrub()`. It failed for the Pino form after the rule table change (GREEN did not turn the assertion green for that half). Investigated with a throwaway script confirming `fast-redact` paths are exact-match, case-sensitive strings; the assertion was corrected to scope the lower-cased check to `scrub()` only, matching documented matcher behavior. Fixed within the same task, no separate task or checkpoint needed.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Both unsubscribe signing-secret environment-variable names are now defence-in-depth-protected in the shared redaction pipeline used by `apps/api` and `apps/worker`. `packages/delivery-core`'s own D-05 log call (19-01) does not route through this pipeline -- its own safeguard is the shape of the log call itself, which 19-04 asserts directly.
- No blockers for 19-04 (full rotation test coverage) or 19-05 (runbook).

---
*Phase: 19-unsubscribe-secret-graceful-rotation*
*Completed: 2026-08-20*
