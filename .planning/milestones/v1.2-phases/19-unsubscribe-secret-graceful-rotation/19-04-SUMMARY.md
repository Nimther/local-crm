---
phase: 19-unsubscribe-secret-graceful-rotation
plan: 04
subsystem: testing
tags: [hmac, unsubscribe, secret-rotation, vitest, vi-mock, timing-safe-compare, delivery-core]

# Dependency graph
requires:
  - phase: 19-unsubscribe-secret-graceful-rotation (plan 01)
    provides: "The exhaustive [primary, ...previous] candidate loop inside verifyUnsubscribeToken, the D-05 log line, and the route-level tracer test (unsubscribe-rotation.test.ts) this plan extends"
provides:
  - "Unit-level executable gates for the loop's two invisible invariants: exhaustive (no-early-break) evaluation, proven via an HMAC-invocation counting spy on node:crypto's createHmac, and the D-05 log line's exact shape (position-only, no secret material)"
  - "Route-level closure of SC2 (both redemption paths: GET confirm page + confirm-form POST, alongside the existing RFC 8058 one-click POST) and SC3 (byte-identical POST responses across primary-valid/previous-valid/unretained/expired/forged)"
affects: [19-05-runbook]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "vi.mock(\"node:crypto\", importOriginal) wrapping createHmac in a counting spy while re-exporting every other real primitive (including timingSafeEqual) unchanged -- proves an invocation-count invariant without making the assertions vacuous"
    - "vi.mock on a package-local logger module (silent under NODE_ENV=test) to assert structured-log call shape directly, since output capture is not viable"
    - "Deliberate-regression proof for a TDD gate that already passes on first run: temporarily reintroduce the bug locally (early break on match), capture the resulting test failure for the record, revert, and re-verify a clean diff before committing -- used when the underlying implementation predates the test file"

key-files:
  created:
    - packages/delivery-core/src/__tests__/unsubscribe-token-rotation.test.ts
  modified:
    - apps/api/src/modules/delivery/__tests__/unsubscribe-rotation.test.ts

key-decisions:
  - "Task 2's route-level tests passed on first run without a manufactured RED, because unsubscribe.routes.ts is under an explicit plan prohibition against being edited by this phase -- there is no code path left to temporarily break without violating that prohibition. Documented as the intentional 'already-satisfied' case rather than a false red, per the plan's own guidance for Task 1."
  - "Task 1's exhaustive-evaluation assertion WAS proven to have teeth: added a temporary `break` on match inside verifyUnsubscribeToken's loop, ran the suite (HMAC invocation count assertion failed 1 vs 3), then reverted and re-ran to confirm both a clean `git diff` on unsubscribe-token.ts and a green suite."
  - "Task 2's four-way SC3 byte-identical comparison uses real contacts for the primary-valid and previous-valid tokens (not just random contactIds) so the test also proves the stronger property: the two requests that DO mutate their contact still produce a response indistinguishable from the two that don't."

requirements-completed: [ROT-02]

coverage:
  - id: D1
    description: "A previous-secret-signed link verifies identically on both redemption paths named in SC2: the RFC 8058 one-click POST (proven in 19-01) and the confirm-page form POST (urlencoded, empty body)"
    requirement: "ROT-02"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/delivery/__tests__/unsubscribe-rotation.test.ts#Test 4 (ROT-02/SC2): the confirm-page form POST (urlencoded, empty body) redeems a previous-secret-signed token"
        status: pass
    human_judgment: false
  - id: D2
    description: "The GET confirm page for a previous-secret-signed token returns 200/text-html and does not mutate the contact, and renders identically (after token-placeholder substitution) across a previous-secret token, a primary token, and a forged token"
    requirement: "ROT-02"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/delivery/__tests__/unsubscribe-rotation.test.ts#Test 5 (ROT-02/SC2): the GET confirm page for a previous-secret-signed token returns 200 text/html and does not mutate"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/delivery/__tests__/unsubscribe-rotation.test.ts#Test 6 (ROT-02/SC2): the GET confirm page is identical, after token substitution, across a previous-secret token, a primary token, and a forged token"
        status: pass
    human_judgment: false
  - id: D3
    description: "Four POST response shapes (primary-valid, previous-valid, unretained-secret, forged) are byte-identical across status, body, and an explicit compared-header list, while only the two valid signatures actually unsubscribe their contact; an expired previous-secret-signed token matches the valid response shape and leaves its contact subscribed"
    requirement: "ROT-02"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/delivery/__tests__/unsubscribe-rotation.test.ts#Test 7 (ROT-02/SC3): four POST response shapes -- primary-valid, previous-valid, unretained-secret, forged -- are byte-identical, though only the two valid signatures unsubscribe their contact"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/delivery/__tests__/unsubscribe-rotation.test.ts#Test 8 (ROT-02/SC3): an expired previous-secret-signed token produces the same response as a valid one and does not mutate its contact"
        status: pass
    human_judgment: false
  - id: D4
    description: "verifyUnsubscribeToken's candidate loop is exhaustive: HMAC invocation count is identical (equal to candidate count) for a primary match, a last-previous-list match, and no match -- proven via a real-HMAC counting spy, and proven to have teeth via a deliberate temporary regression"
    requirement: "ROT-02"
    verification:
      - kind: unit
        ref: "packages/delivery-core/src/__tests__/unsubscribe-token-rotation.test.ts#invokes the HMAC primitive once per candidate, and the count is identical for a primary match, a last-previous match, and no match"
        status: pass
    human_judgment: false
  - id: D5
    description: "Verification via a previous secret at list position N emits exactly one structured log line carrying N and no secret material (nor any substring of the token signature); a primary match emits none"
    requirement: "ROT-02"
    verification:
      - kind: unit
        ref: "packages/delivery-core/src/__tests__/unsubscribe-token-rotation.test.ts#verifyUnsubscribeToken D-05 log shape (5 tests: zero-calls-on-primary, position-1, position-2, zero-calls-on-no-match, no-secret-material)"
        status: pass
    human_judgment: false
  - id: D6
    description: "With the previous-secrets variable absent or an empty string, verification behaviour is identical to pre-rotation single-secret behaviour (round-trip, tampered payload, altered signature); list order is genuinely traversed (a match at previous-list position 2 still verifies); an unretained secret is rejected"
    requirement: "ROT-02"
    verification:
      - kind: unit
        ref: "packages/delivery-core/src/__tests__/unsubscribe-token-rotation.test.ts#verifyUnsubscribeToken rotation semantics (ROT-02, D-01, D-02) (5 tests)"
        status: pass
    human_judgment: false
  - id: D7
    description: "packages/delivery-core/src/__tests__/unsubscribe-token.test.ts has zero diff, and unsubscribe.routes.ts has zero diff -- this plan is coverage-only, adding no new behavior"
    verification:
      - kind: other
        ref: "git status --porcelain packages/delivery-core/src/__tests__/unsubscribe-token.test.ts apps/api/src/modules/delivery/unsubscribe.routes.ts (both empty)"
        status: pass
      - kind: other
        ref: "npm run build -w packages/delivery-core (tsc exits 0); npx tsc -p apps/api/tsconfig.json --noEmit (exits 0)"
        status: pass
    human_judgment: false

duration: ~30min
completed: 2026-08-20
status: complete
---

# Phase 19 Plan 04: Rotation test coverage closure Summary

**Closed ROT-02: a new unit suite gates the candidate loop's two invisible invariants (exhaustive evaluation, D-05 log shape) with an HMAC-invocation counting spy and a mocked logger, while the route-level rotation suite grows from 3 to 8 tests covering both redemption paths and the full byte-identical-response matrix (valid/previous/unretained/expired/forged).**

## Performance

- **Duration:** ~30 min
- **Tasks:** 2/2 completed
- **Files modified:** 2 (1 created, 1 modified)

## Accomplishments
- New `packages/delivery-core/src/__tests__/unsubscribe-token-rotation.test.ts`: 11 tests across rotation semantics (5), exhaustive evaluation (1), and D-05 log shape (5) -- all passing, package suite at 176/176.
- `node:crypto`'s `createHmac` mocked with `importOriginal` so the real HMAC and the real `timingSafeEqual` still run underneath; only the invocation *count* is observed. Primary-match, last-previous-match, and no-match all invoke it exactly 3 times (== candidate count) -- proven independent of matched position or whether anything matched.
- Proved the exhaustive-evaluation gate has teeth: temporarily added `break` on match inside the loop, re-ran the suite (assertion failed: 1 vs 3 invocations), reverted, and re-verified a clean `git diff` plus a green suite before committing.
- D-05 tests assert the mocked package-local logger's `info` call: zero calls on a primary match, exactly one call carrying `secretPosition: 1`/`2` on a previous-secret match at that list position, zero calls on no match, and that the serialised log argument + message string contain none of the four secret literals in play nor any substring of the token's own signature.
- `apps/api/src/modules/delivery/__tests__/unsubscribe-rotation.test.ts` grew from 3 to 8 tests, reusing its existing harness (owner/createContact/getContact/postOneClick, env capture/restore): the confirm-form POST shape (Test 4), the GET confirm page's non-mutation and cross-era identity (Tests 5-6), the four-way byte-identical POST comparison over an explicit `content-type`/`content-length` header list (Test 7), and the expired-previous-secret parity case (Test 8). All 5 unsubscribe suites (25 tests) pass; `unsubscribe.routes.ts` has zero diff.

## Task Commits

Each task was committed atomically:

1. **Task 1: Unit gates for the loop's two invisible invariants** - `f2d273f` (test)
2. **Task 2: Route-level ROT-02 closure** - `a7a7d9a` (test)

_No separate plan-metadata commit — this is a worktree-mode parallel executor; STATE.md/ROADMAP.md updates are the orchestrator's responsibility after merge._

## Files Created/Modified
- `packages/delivery-core/src/__tests__/unsubscribe-token-rotation.test.ts` - new: rotation semantics, exhaustive-evaluation HMAC-count gate, D-05 log-shape gate
- `apps/api/src/modules/delivery/__tests__/unsubscribe-rotation.test.ts` - extended (19-01's 3 tests + 5 new): form-POST redemption, GET non-mutation/identity, four-way byte-identical POST matrix, expired-previous-secret parity

## Decisions Made
- **Task 2's RED evidence:** the plan's acceptance criteria for a TDD-tagged task nominally expects a RED-then-GREEN record, but `unsubscribe.routes.ts` — the only code path these route tests exercise beyond `verifyUnsubscribeToken` itself — is under this phase's own explicit prohibition against being edited. There is no legitimate way to manufacture a red run without violating that prohibition, so all 5 new route tests are documented as passing on first run because the underlying (19-01) implementation already satisfies the SC2/SC3 contract — the same "record it passed on first run" allowance the plan itself grants Task 1 for already-satisfied assertions.
- **Task 1's RED evidence:** unlike Task 2, `verifyUnsubscribeToken`'s loop IS this plan's file to (temporarily) mutate for a gate-teeth proof, since the assertion under test lives in `packages/delivery-core`, not the prohibited route file. Did so: `break` added after `matchedIndex = i`, suite run (1 of 19 tests failed: `expected 1 to be 3`), reverted, suite re-run clean (19/19), `git diff` on `unsubscribe-token.ts` confirmed empty before the Task 1 commit.
- Reused real contacts (not just random `contactId`s) for the primary-valid and previous-valid legs of the four-way SC3 comparison, so the test proves both halves of the no-oracle property in one place: the two requests that succeed are indistinguishable in their HTTP response from the two that don't, and the two that succeed did in fact mutate their contact.

## Deviations from Plan

None — plan executed exactly as written. The RED-evidence handling described above is a documented resolution of an inherent tension in the plan (TDD tag + acceptance-criteria RED expectation vs. a hard prohibition on editing the only file that could produce that red for Task 2), not a deviation from the plan's intent.

## Issues Encountered
None.

## User Setup Required
None — no external service configuration required.

## Next Phase Readiness
- ROT-02 is closed: SC2 (both redemption paths verify a previous-secret link) and SC3 (no response shape distinguishes valid/previous-valid/unretained/expired/forged, and the loop's work is position-independent) both have executable gates now, at both the unit and route level.
- D-05's log line is proven, at the unit level, to carry a position and no secret material — the evidence the phase's remaining runbook plan (19-05) can point operators to for the retirement decision.
- `packages/delivery-core/src/__tests__/unsubscribe-token.test.ts` and `apps/api/src/modules/delivery/unsubscribe.routes.ts` both have zero diff from this plan — confirms the coverage-only scope held.
- No blockers for 19-05.

## Self-Check: PASSED
- FOUND: packages/delivery-core/src/__tests__/unsubscribe-token-rotation.test.ts
- FOUND: apps/api/src/modules/delivery/__tests__/unsubscribe-rotation.test.ts (modified)
- FOUND commit f2d273f
- FOUND commit a7a7d9a

---
*Phase: 19-unsubscribe-secret-graceful-rotation*
*Completed: 2026-08-20*
