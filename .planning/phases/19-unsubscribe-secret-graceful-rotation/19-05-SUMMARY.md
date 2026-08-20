---
phase: 19-unsubscribe-secret-graceful-rotation
plan: 05
subsystem: docs
tags: [runbook, env-template, docker-compose, deployment, unsubscribe, secret-rotation, spec-env-coverage]

# Dependency graph
requires:
  - phase: 19-unsubscribe-secret-graceful-rotation
    provides: "Plan 19-01's candidate loop + D-05 log line (secretPosition field), and plan 19-02's three-site env-validation contract (>=32 chars, no comma/whitespace, max 5 entries, no duplicates) -- this plan's runbook Prerequisites and Evidence sections restate both verbatim rather than re-deriving them"
provides:
  - "The retention decision (D-06: 5 years after last use as primary; D-07: recording/enforcement split) filed in SPECIFICATION.md next to the unsubscribe token format/TTL description"
  - "UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS entered into docker/prod.env.example (uncommented, empty value) and README.md's env-var table"
  - "docs/runbooks/unsubscribe-secret-rotation.md -- the two-step (verify-everywhere-then-promote) rotation procedure ending in a both-eras canary smoke (D-09)"
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Env-template entry left uncommented with an empty value specifically to put its name under check:spec-env-coverage's required-coverage sweep, per docker/prod.env.example's own documented convention distinguishing active (uncommented) from inactive (commented) placeholder lines"

key-files:
  created:
    - docs/runbooks/unsubscribe-secret-rotation.md
  modified:
    - docker/prod.env.example
    - README.md
    - SPECIFICATION.md

key-decisions:
  - "SPECIFICATION.md's retention paragraph was placed directly after the existing unsubscribe-token-format sentence in §3.7 (not in a new subsection), per the plan's own instruction to file the decision next to the TTL it is derived from -- the paragraph names D-06 and D-07 explicitly and cross-references the runbook by path"
  - "The runbook's Step 3 canary smoke references the standing canary workspace id (fe8fbbc6-6b25-490b-b3f5-7c739e325c9a) already named in docs/runbooks/uat-live-sendgrid.md, rather than inventing a second canary reference -- keeps the two runbooks pointing at the same real asset"
  - "verify:prod-compose initially failed in this fresh worktree with a stop-grace-period-drift violation because apps/worker/dist did not exist yet (unrelated to this plan's changes -- print-stop-grace-period.mjs imports the built worker). Ran `npm run build -w apps/worker` (via a temporary node_modules symlink to the main checkout, removed before commit) to produce a real build, then re-ran the gate clean. Not a plan deviation -- environmental prerequisite for a gate this plan's acceptance criteria require to exit 0."

patterns-established: []

requirements-completed: [ROT-01, ROT-02]

coverage:
  - id: D1
    description: "docker/prod.env.example gains an uncommented UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS= slot beneath the primary secret, documenting the verification-only/comma-separated/max-5/32-char-min contract and pointing at the rotation runbook; README.md gains a matching table row"
    requirement: "ROT-01"
    verification:
      - kind: other
        ref: "grep -c '^UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS=' docker/prod.env.example (returns 1); grep -c UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS README.md (returns 1)"
        status: pass
      - kind: other
        ref: "npm run check:spec-env-coverage (55 names checked, all present -- one higher than 19-02's recorded baseline of 54)"
        status: pass
      - kind: other
        ref: "npm run verify:prod-compose (61 invariants OK, after building apps/worker)"
        status: pass
    human_judgment: false
  - id: D2
    description: "SPECIFICATION.md §3.7 states the D-06 retention window (5 years after last use as primary, tied to the token TTL) and the D-07 recording/enforcement split (dates live in docs; code enforces only the max-list-length bound) without softening either, next to the existing token-format/TTL paragraph"
    requirement: "ROT-01"
    verification:
      - kind: other
        ref: "Read SPECIFICATION.md:462-464 -- the new paragraph names D-06/D-07, states '5 years after its last use as primary', and states code enforces only MAX_UNSUBSCRIBE_PREVIOUS_SECRETS = 5"
        status: pass
    human_judgment: false
  - id: D3
    description: "docs/runbooks/unsubscribe-secret-rotation.md documents the two-step rotation (verify-everywhere-then-promote) with an explicit warning against promoting before Step 1 is applied and restarted everywhere, the D-09 both-eras canary smoke instructing pre-Step-2 link capture, the D-05 evidence log query (secretPosition, byte-identical to the implementation), the rotation-log table, rollback, and an explicit statement that check:runbook-coverage does not cover this file"
    requirement: "ROT-02"
    verification:
      - kind: other
        ref: "npm run check:runbook-coverage (4 alerts checked, unchanged -- proves this addition did not break the existing alert-name gate); npm run check:root-hygiene (27/28 entries, none blacklisted)"
        status: pass
      - kind: manual_procedural
        ref: "Human-check walkthrough performed by the executor per the plan's own <human-check> instructions: Step 1-before-Step-2 ordering is stated explicitly with a warning; Step 3's pre-rotation-link capture is instructed before Step 2 begins; Prerequisites rules (>=32 chars, no comma/whitespace, max 5, no duplicates) verified byte-consistent against apps/api/src/env.ts, apps/worker/src/server.ts's assertUnsubscribeTokenSecrets, and scripts/check-env.mjs; the quoted log field name (secretPosition) matches packages/delivery-core/src/unsubscribe-token.ts:124 and the test assertion in unsubscribe-token-rotation.test.ts:226/239; no secret value appears anywhere in the file (grep confirmed only the placeholder 'secret-A' example)"
        status: pass
    human_judgment: false

duration: ~30min
completed: 2026-08-21
status: complete
---

# Phase 19 Plan 05: Retention decision, deployment template, and rotation runbook Summary

**Closed SC4 by filing the D-06/D-07 retention decision into SPECIFICATION.md next to the token TTL, wiring `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` into `docker/prod.env.example`/README.md, and writing `docs/runbooks/unsubscribe-secret-rotation.md` -- a two-step (verify-everywhere-then-promote) rotation procedure ending in D-09's both-eras canary smoke against the standing canary workspace.**

## Performance

- **Duration:** ~30 min
- **Tasks:** 2/2 completed
- **Files modified:** 4 (1 created, 3 modified)

## Accomplishments
- `docker/prod.env.example` gained an uncommented `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS=` slot directly beneath the primary secret -- documenting the verification-only, comma-separated, max-5-entry, 32-char-minimum contract inline, and putting the name under `check:spec-env-coverage`'s required-coverage sweep (55 names checked, all present, up from 19-02's recorded 54).
- `README.md`'s environment-variable table gained a matching optional row pointing at the runbook.
- `SPECIFICATION.md` §3.7 now states D-06 (a previous secret is retained until 5 years after its last use as primary, tied to the real token TTL) and D-07 (the rule and each secret's retirement date live in documentation; code enforces only the max-list-length bound) as a named, unsoftened operator commitment, immediately after the existing unsubscribe-token-format/TTL paragraph.
- `docs/runbooks/unsubscribe-secret-rotation.md` is a new operator runbook: Step 1 (add the new secret to `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` on every service, restart) must complete everywhere before Step 2 (promote, restart again) -- with an explicit warning naming the window skipping this ordering creates. Step 3 is D-09's both-eras canary smoke: capture a pre-rotation link *before* Step 2, then after Step 2 redeem both a freshly-signed post-rotation link and the retained pre-rotation link against the standing canary workspace. The Evidence section quotes the exact D-05 log shape (`secretPosition`, no secret material) and gives a log query; the Rotation log table records slot/dates/prune-eligibility with no secret value ever written; Rollback covers both a failed-boot-validation case and an already-promoted-must-be-undone case; the closing section states plainly that `check:runbook-coverage` does not and cannot cover this file.
- `npm run verify:prod-compose` required building `apps/worker` first in this fresh worktree (`print-stop-grace-period.mjs` imports the built worker's `dist/shutdown-budget.js`) -- an environmental prerequisite, not a plan change; the build artifact is gitignored and does not appear in git status.

## Task Commits

Each task was committed atomically:

1. **Task 1: File the retention decision and put the variable into the deployment template and README** - `119f150` (docs)
2. **Task 2: Write the two-step rotation runbook ending in a both-eras canary smoke** - `d319e42` (docs)

_No separate plan-metadata commit -- this is a worktree-mode parallel executor; STATE.md/ROADMAP.md updates are the orchestrator's responsibility after merge._

## Files Created/Modified
- `docker/prod.env.example` - new uncommented `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS=` line beneath `UNSUBSCRIBE_TOKEN_SECRET`, with an inline comment stating the full validation contract and pointing at the runbook
- `README.md` - new table row for `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS`, marked optional
- `SPECIFICATION.md` - new paragraph in §3.7 immediately after the unsubscribe-token-format sentence, stating D-06 and D-07 by name
- `docs/runbooks/unsubscribe-secret-rotation.md` - new runbook: scope statement, "why rotation is safe here", Prerequisites, Step 1/Step 2/Step 3 (D-09 canary smoke), Evidence and the retirement decision (D-05/D-06/D-07), Rotation log, Rollback, and a closing note on this file's relationship to `check:runbook-coverage`

## Decisions Made
- Retention paragraph placed inline in §3.7 next to the existing token-format/TTL sentence rather than as a new subsection, matching the plan's instruction that "the retention decision belongs next to the TTL it is derived from."
- The runbook's canary smoke references the same standing canary workspace id (`fe8fbbc6-6b25-490b-b3f5-7c739e325c9a`) already named in `docs/runbooks/uat-live-sendgrid.md`, rather than describing a separate canary setup -- one real asset, referenced consistently across runbooks.
- Built `apps/worker` (via a temporary `node_modules` symlink to the main checkout, removed before the final commit) to unblock `verify:prod-compose`'s stop-grace-period check in this fresh worktree; confirmed the resulting `dist/` output is gitignored and left no untracked files behind.

## Deviations from Plan

None - plan executed exactly as written. The `apps/worker` build-before-verify step above was an environmental prerequisite for running an unmodified acceptance-criteria gate (`verify:prod-compose`) in a worktree with no prior build artifacts, not a change to the plan's scope, files, or content.

## Issues Encountered
- `npm run verify:prod-compose` failed on first run in this worktree with `stop-grace-period-drift`/`stop-grace-period-undeterminable` because `apps/worker/dist/shutdown-budget.js` did not exist (no prior build in this fresh worktree checkout). Resolved by running `npm run build -w apps/worker` (via a temporary node_modules symlink, removed afterward) and re-running the gate, which then passed clean (61/61 invariants OK). Unrelated to this plan's docker/prod.env.example edit -- the same failure would occur on any unbuilt worktree running this gate.

## User Setup Required
None - no external service configuration required. This plan documents a procedure; it does not change any runtime behavior. `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` remains optional and unset in every existing deploy.

## Next Phase Readiness
- SC4 is closed: the retention window is an explicit, documented decision (D-06/D-07) tied to the five-year token TTL, and every name in the deployment template is documented in SPECIFICATION.md, enforced by `check:spec-env-coverage`.
- All four phase-19 plans (01: candidate loop, 02: env validation, 04: test coverage closure, 05: this plan) are now complete. No further plans are pending in this phase per the artifacts table referenced from `19-01-PLAN.md`.
- No blockers.

## Self-Check: PASSED
- FOUND: docker/prod.env.example (modified, UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS= present)
- FOUND: README.md (modified, UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS row present)
- FOUND: SPECIFICATION.md (modified, D-06/D-07 paragraph present)
- FOUND: docs/runbooks/unsubscribe-secret-rotation.md
- FOUND commit 119f150
- FOUND commit d319e42

---
*Phase: 19-unsubscribe-secret-graceful-rotation*
*Completed: 2026-08-21*
