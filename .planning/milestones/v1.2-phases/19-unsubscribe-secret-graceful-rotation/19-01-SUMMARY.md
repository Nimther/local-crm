---
phase: 19-unsubscribe-secret-graceful-rotation
plan: 01
subsystem: delivery
tags: [hmac, unsubscribe, secret-rotation, pino, timing-safe-compare, delivery-core]

# Dependency graph
requires:
  - phase: 04-broadcast-campaigns-sendgrid
    provides: signUnsubscribeToken/verifyUnsubscribeToken, the RFC 8058 one-click POST route, and the never-throws null-or-payload contract this plan extends
provides:
  - Ordered [primary, ...previous] candidate loop inside verifyUnsubscribeToken, exhaustively evaluated with a per-candidate timing-safe compare
  - packages/delivery-core/src/logger.ts — package-local pino logger (mirrors packages/contacts-core/src/logger.ts)
  - Proof (route-level, both link eras) that the rotation architecture works end-to-end before env-validation/redaction/docs layers are built on it
affects: [19-02-env-validation, 19-03-redaction, 19-04-full-rotation-test-coverage, 19-05-runbook]

# Tech tracking
tech-stack:
  added: ["pino 10.3.1 (packages/delivery-core runtime dependency)"]
  patterns:
    - "Package-local minimal pino logger for a shared package imported by both apps/api and apps/worker (no back-dependency on either app's own logger)"
    - "Exhaustive (no-early-break) candidate loop for timing-safe multi-secret verification"

key-files:
  created:
    - packages/delivery-core/src/logger.ts
    - apps/api/src/modules/delivery/__tests__/unsubscribe-rotation.test.ts
  modified:
    - packages/delivery-core/src/unsubscribe-token.ts
    - packages/delivery-core/package.json
    - package-lock.json
    - SPECIFICATION.md

key-decisions:
  - "Regenerated package-lock.json under npm 10 via npx (per the documented docker-npm-ci-lockfile-desync remediation) after a plain npm11 `npm install` produced a 703-line rewrite unrelated to the new pino edge; the npm10 regen was purely additive (2 lines) and check:lockfile-npm10 passed"

patterns-established:
  - "Pattern 1: exhaustive multi-secret verification loop — matchedIndex starts at -1, is only assigned once, and the loop never breaks early, so total loop duration is a pure function of candidate count (D-04/SC3, T-19-02)"

requirements-completed: [ROT-01, ROT-02]

coverage:
  - id: D1
    description: "A link signed BEFORE a simulated two-step rotation (secret A) still unsubscribes its contact through the real RFC 8058 one-click POST route after the primary rotates to a new secret B (ROT-01, SC1)"
    requirement: "ROT-01"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/delivery/__tests__/unsubscribe-rotation.test.ts#Test 1 (ROT-01/SC1): a link signed BEFORE rotation (secret A) still unsubscribes after the primary rotates to B"
        status: pass
    human_judgment: false
  - id: D2
    description: "A link signed AFTER the same rotation (new primary B) also unsubscribes — proves the new primary both signs and verifies (ROT-01, SC1)"
    requirement: "ROT-01"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/delivery/__tests__/unsubscribe-rotation.test.ts#Test 2 (ROT-01/SC1): a link signed AFTER rotation (new primary B) also unsubscribes"
        status: pass
    human_judgment: false
  - id: D3
    description: "A token signed by a secret that is neither the primary nor in the previous list leaves its contact subscribed, with a response byte-identical to a structurally forged token's (ROT-02, SC3, no-oracle invariant)"
    requirement: "ROT-02"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/delivery/__tests__/unsubscribe-rotation.test.ts#Test 3 (negative control): a token signed by a secret that is neither primary nor previous does not unsubscribe, and its response is byte-identical to a structurally forged token's"
        status: pass
    human_judgment: false
  - id: D4
    description: "verifyUnsubscribeToken's candidate loop is exhaustive (no early break) and every candidate goes through the timing-safe primitive; the pre-rotation single-secret test suite (round-trip, tampered payload, altered signature, malformed token, buildListUnsubscribeUrl) still passes byte-compatibly, and unsubscribe.routes.ts/send-dispatch.ts/flow-send.ts have zero diff"
    requirement: "ROT-01"
    verification:
      - kind: unit
        ref: "npm run test -w packages/delivery-core -- unsubscribe-token (8/8 pass)"
        status: pass
      - kind: integration
        ref: "npm run test -w apps/api -- unsubscribe (20/20 pass across unsubscribe/unsubscribe-content-type/unsubscribe-xss/unsubscribe-test-send/unsubscribe-rotation)"
        status: pass
      - kind: other
        ref: "npm run build -w packages/delivery-core (tsc exits 0, public symbol surface unchanged)"
        status: pass
      - kind: other
        ref: "git status --porcelain apps/api/src/modules/delivery/unsubscribe.routes.ts apps/worker/src/queues/send-dispatch.ts apps/worker/src/queues/flows/flow-send.ts (empty)"
        status: pass
    human_judgment: false
  - id: D5
    description: "New pino dependency and UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS env var filed into SPECIFICATION.md in the same change"
    verification:
      - kind: other
        ref: "npm run check:spec-env-coverage (54 names checked, all present)"
        status: pass
    human_judgment: false

duration: ~35min
completed: 2026-08-20
status: complete
---

# Phase 19 Plan 01: Multi-secret unsubscribe verification loop Summary

**Extended `verifyUnsubscribeToken` from a single-secret HMAC compare into an ordered, exhaustively-evaluated `[primary, ...previous]` candidate loop, proven end-to-end through the real RFC 8058 one-click POST route across a simulated two-step secret rotation.**

## Performance

- **Duration:** ~35 min
- **Tasks:** 2/2 completed
- **Files modified:** 6 (2 created, 4 modified)

## Accomplishments
- `verifyUnsubscribeToken` now tries the primary secret first, then each secret in `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` (comma-separated, lazily read) in list order — exhaustively, with a timing-safe compare per candidate, never breaking early (D-04/SC3, T-19-02).
- A link signed before a simulated rotation and a link signed after it both unsubscribe their contact through the real route; a token signed by an unlisted secret does not, and its response is byte-identical to a structurally forged token's.
- On a successful verification via a non-primary secret, one structured log line (`secretPosition` only, no secret material) is emitted through a new package-local pino logger (`packages/delivery-core/src/logger.ts`, mirrors `packages/contacts-core/src/logger.ts`).
- `apps/api/src/modules/delivery/unsubscribe.routes.ts` and both signing call sites (`send-dispatch.ts`, `flow-send.ts`) have zero diff — the route/signing layers needed no changes, confirming the null-or-payload contract held.
- `SPECIFICATION.md` records the new `pino` runtime dependency and the new `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` env var in the same change (validation honestly noted as "not yet implemented — lands in 19-02").

## Task Commits

Each task was committed atomically:

1. **Task 1: End-to-end "a pre-rotation link still unsubscribes"** - `23b1d0e` (feat, includes the new RED-then-GREEN test file, the new logger, the `pino` dependency edge, and the candidate-loop rewrite)
2. **Task 2: File the new dependency and env var into SPECIFICATION.md** - `85a73e9` (docs)

_No separate plan-metadata commit — this is a worktree-mode parallel executor; STATE.md/ROADMAP.md updates are the orchestrator's responsibility after merge._

## Files Created/Modified
- `packages/delivery-core/src/unsubscribe-token.ts` - `getSecret()` renamed to `getPrimarySecret()`; added `getPreviousSecrets()` and `signWith(secret, encodedPayload)`; `verifyUnsubscribeToken`'s single compare replaced with the exhaustive `[primary, ...previous]` loop plus the D-05 log line
- `packages/delivery-core/src/logger.ts` - new package-local pino logger (level `silent` in test, `info` otherwise)
- `packages/delivery-core/package.json` - added `"pino": "10.3.1"` to `dependencies`
- `package-lock.json` - regenerated under npm 10 (see Decisions below); adds only the `pino` edge under `packages/delivery-core`
- `apps/api/src/modules/delivery/__tests__/unsubscribe-rotation.test.ts` - new end-to-end route test (3 tests: pre-rotation redemption, post-rotation redemption, negative-control byte-identical response)
- `SPECIFICATION.md` - §2.5 `packages/delivery-core` row gains the `pino` dependency entry; §3.2 gains the `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` row

## Decisions Made
- **Lockfile regeneration path:** running plain `npm install` under this environment's npm 11 (Node 26) rewrote 703 lines of `package-lock.json` unrelated to the new `pino` edge — the same npm-major skew that produced the documented `docker-npm-ci-lockfile-desync` incident (`.planning/debug/resolved/docker-npm-ci-lockfile-desync.md`). Per that incident's verified remediation, the npm11-generated lockfile was reverted and regenerated with `npx --yes npm@10 install --package-lock-only --ignore-scripts` instead — a purely additive 2-line diff (`pino` was already resolved elsewhere in the tree). `npm run check:lockfile-npm10` then passed against `docker/Dockerfile.{api,worker,web}`'s `node:22-slim` pin.
- Loop mechanics, log field naming, and test-env wiring followed 19-PATTERNS.md's reconciled RESEARCH.md Pattern 1 template verbatim, per the plan's own instruction to reproduce it rather than re-derive it.

## Deviations from Plan

None - plan executed exactly as written. The lockfile-regeneration detour above was explicitly anticipated by the plan's own acceptance criterion ("this environment runs a Node major above the repo's engines floor... If the gate fails, stop and report rather than committing a rewritten lockfile") and resolved using the project's own documented, previously-verified remediation rather than an ad hoc fix — not a deviation from the plan's intent.

## Issues Encountered
- `npm install` under npm 11 produced an unwanted 703-line lockfile rewrite (see Decisions above) — resolved by reverting and regenerating under npm 10 via `npx`, confirmed purely additive and gate-passing.

## User Setup Required
None - no external service configuration required. `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` remains optional and unset in every existing deploy; its absence is the normal pre-rotation state (D-01).

## Next Phase Readiness
- The rotation architecture's core bet — that a running process's lazy `process.env` reads let it verify a token signed by a secret it no longer signs with, with zero route-layer changes — is proven end-to-end. 19-02 (env validation triple), 19-03 (redaction), 19-04 (full test-suite extension incl. GET path and call-count/timing assertions), and 19-05 (runbook + retention docs) can build directly on this commit.
- `packages/delivery-core/src/__tests__/unsubscribe-token-rotation.test.ts` (unit-level rotation coverage for the loop itself, distinct from this plan's route-level test) is explicitly deferred to 19-04 per the phase's Artifacts table — not a gap in this plan's scope.
- No blockers.

---
*Phase: 19-unsubscribe-secret-graceful-rotation*
*Completed: 2026-08-20*
