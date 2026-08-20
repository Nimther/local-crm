---
phase: 11-delivery-correctness
plan: 01
subsystem: delivery
tags: [state-machine, typescript, satisfies, mermaid, architecture-doc, drizzle]

# Dependency graph
requires:
  - phase: 10-tenant-isolation-trust-boundaries
    provides: mega_crm_scan admin-scan role (used by the reconciler in later plans of this phase)
provides:
  - Executable send-state-machine matrix (`SEND_STATUS_TRANSITIONS`) in `@mega-crm/delivery-core`, with a compile-time exhaustiveness guard tying every `SendStatus` value to a documented set of transitions
  - `ARCHITECTURE.md` section 9 ("The send delivery state machine") — reviewed, human-approved design artifact: mermaid diagram, per-transition writer matrix, delivery-model statement (DLV-07), `unknown` horizon note
  - Human-reviewed gate (D-18) unblocking all subsequent dispatch-code plans in Phase 11
affects: [11-02, 11-03, 11-04, 11-05, 11-06, 11-07, 11-08, 11-09, 11-10, 11-11]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "satisfies Record<SendStatus, readonly SendTransition[]> exhaustiveness guard — adding a status value without a matching transitions entry is a typecheck failure, not a runtime surprise"
    - "Design-artifact-before-code gate (D-18): ARCHITECTURE.md + its executable mirror are written and human-reviewed before any dispatch code in the phase is touched"

key-files:
  created:
    - packages/delivery-core/src/send-state-machine.ts
    - packages/delivery-core/src/__tests__/send-state-machine.test.ts
  modified:
    - packages/delivery-core/src/index.ts
    - ARCHITECTURE.md

key-decisions:
  - "dispatching -> reconciling is the only transition with two writers (send worker for ambiguous/interrupted-redelivery cases, reconciler for the stale-age sweep); every other transition, and every transition leaving reconciling or unknown, has the reconciler as sole writer"
  - "No reconciling -> failed transition exists: webhook evidence is positive-only and can never prove a message was NOT accepted (D-01)"
  - "Delivery model is at-most-once at the SendGrid-acceptance boundary, not exactly-once; an unknown send may have been delivered or lost and will not be auto-resent"
  - "Accepted, non-actioned review observation: ARCHITECTURE.md's mermaid diagram includes an `unknown --> unknown: horizon passed, immutable` self-transition annotation that has no corresponding row in the writer matrix or entry in SEND_STATUS_TRANSITIONS. This is intentional — it is a visual/documentary note about the horizon becoming immutable, not a state transition requiring a writer. The human reviewer (Task 3) explicitly reviewed and approved this as-is; do not treat it as drift or attempt to reconcile it with the executable matrix in a later phase."

patterns-established:
  - "Pure, I/O-free state-machine modules in delivery-core mirror ARCHITECTURE.md sections 1:1 so doc/code drift is testable"

requirements-completed: [DLV-01, DLV-07]

coverage:
  - id: D1
    description: "Executable transition matrix (SEND_STATUS_TRANSITIONS) with isAllowedTransition/writersFor helpers, exported from the delivery-core barrel"
    requirement: "DLV-01"
    verification:
      - kind: unit
        ref: "packages/delivery-core/src/__tests__/send-state-machine.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "ARCHITECTURE.md section 9 documents the state machine, writer matrix, and delivery model in publishable language, matching the executable matrix entry-for-entry"
    requirement: "DLV-07"
    verification:
      - kind: manual_procedural
        ref: "Task 3 checkpoint:human-verify — human read ARCHITECTURE.md section 9 and send-state-machine.ts side by side and approved"
        status: pass
    human_judgment: true
    rationale: "D-18 requires this to be a human-reviewed design artifact before any dispatch code is written; completeness/wording judgment (does the delivery-model statement overclaim, does the matrix match row-for-row) is not mechanically verifiable beyond the automated exactly-once/at-most-once regex check already run in Task 2's <verify>."

# Metrics
duration: 3min
completed: 2026-08-09
status: complete
---

# Phase 11 Plan 01: Send Delivery State Machine Design Artifact Summary

**Reviewed DLV-01 state machine (mermaid diagram + writer matrix + `SEND_STATUS_TRANSITIONS` executable mirror with a `satisfies` exhaustiveness guard) and an honestly-scoped at-most-once DLV-07 delivery-model statement, approved before any dispatch code in Phase 11 is touched.**

## Performance

- **Duration:** 3 min (Task 1 + Task 2 execution; Task 3 was a review-only checkpoint with no code change)
- **Started:** 2026-08-09T09:48:00Z (approx, Task 1 commit 14:48:28+05:00)
- **Completed:** 2026-08-09T09:49:51Z (Task 2 commit 14:49:51+05:00) + this continuation's closeout
- **Tasks:** 3 (2 code/doc tasks + 1 human-verify checkpoint)
- **Files modified:** 4 (2 created, 2 modified)

## Accomplishments

- `packages/delivery-core/src/send-state-machine.ts`: `SEND_STATUSES` (6-value tuple), `SendStatus`, `SendStatusWriter`, `SendTransition`, `SEND_STATUS_TRANSITIONS` (`satisfies Record<SendStatus, readonly SendTransition[]>`), `isAllowedTransition()`, `writersFor()` — all exported from the package barrel, covered by 16 unit tests.
- `ARCHITECTURE.md` section 9 ("The send delivery state machine"): mermaid `stateDiagram-v2`, per-transition writer matrix, "why the reconciler never writes `failed`" rationale, an at-most-once delivery-model statement (no `exactly-once` language), the `unknown` horizon note, and the `excluded`/rollup closing note — inserted before "Forward-looking — not yet true".
- Human review gate (Task 3, D-18) completed: reviewer read section 9 and `send-state-machine.ts` side by side, ran the vitest suite, and responded `approved` with no requested changes — unblocking all 10 remaining plans in Phase 11 that write `sends.status` transitions.

## Task Commits

Each code/doc task was committed atomically:

1. **Task 1: Executable send-state-machine matrix in delivery-core** - `5cbbc1d` (feat)
2. **Task 2: ARCHITECTURE.md send-delivery state machine and delivery model (D-18)** - `902c190` (docs)
3. **Task 3: Review gate — the state machine before any dispatch code (D-18)** - checkpoint only, no commit (human responded `approved`)

**Plan metadata:** (this commit) — docs: complete plan

## Files Created/Modified

- `packages/delivery-core/src/send-state-machine.ts` - Pure, I/O-free transition matrix module; the executable mirror of ARCHITECTURE.md section 9
- `packages/delivery-core/src/__tests__/send-state-machine.test.ts` - 16 unit tests covering every `<behavior>` item (no DB, no `ensureTestDbMigrated`)
- `packages/delivery-core/src/index.ts` - New export block re-exporting the state-machine module's public symbols
- `ARCHITECTURE.md` - New section 9 documenting the state diagram, writer matrix, "why no `reconciling -> failed`" rationale, delivery model, and `unknown` horizon

## Decisions Made

- `dispatching -> reconciling` is the sole two-writer transition (send worker + reconciler); every other transition, and every transition leaving `reconciling`/`unknown`, has the reconciler as sole writer — encoded both in the writer matrix and as an invariant test (`writersFor("dispatching","reconciling").length === 2`, all others `<= 1`).
- No `reconciling -> failed` transition exists anywhere in the matrix: SendGrid webhooks are positive-only evidence and can never prove non-acceptance (D-01).
- Delivery model published as at-most-once at the SendGrid-acceptance boundary, not exactly-once; `unknown` sends are explicitly documented as possibly-delivered-possibly-lost with no automatic re-send.
- **Accepted review observation, not acted on:** the mermaid diagram in ARCHITECTURE.md carries an `unknown --> unknown: horizon passed, immutable` self-transition annotation that does not appear as a row in the writer matrix or as an entry in `SEND_STATUS_TRANSITIONS`. This was raised during the Task 3 review and the human explicitly chose to leave it as-is — it documents the horizon-expiry moment visually without implying a writer-owned state transition. Recorded here so a later phase does not mistake it for doc/code drift and "fix" it.

## Deviations from Plan

None - plan executed exactly as written. Task 3's checkpoint produced one review observation (the mermaid self-loop annotation above) which the human explicitly declined to act on; this is documented as an accepted note, not a deviation requiring a fix.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- The reviewed, executable state machine (`SEND_STATUS_TRANSITIONS`) and the D-18 gate are now closed. All 10 remaining Phase 11 plans (11-02 through 11-11) may proceed to write `sends.status` transitions against this matrix.
- 11-02 must make its Drizzle `sendStatusEnum` equal `SEND_STATUSES` and add the drift test called out in this plan's `key_links`.
- No `send-dispatch.ts` change has been made in this plan, satisfying the plan's success criterion that this is the gate preceding dispatch-code changes.

---
*Phase: 11-delivery-correctness*
*Completed: 2026-08-09*

## Self-Check: PASSED

- FOUND: packages/delivery-core/src/send-state-machine.ts
- FOUND: packages/delivery-core/src/__tests__/send-state-machine.test.ts
- FOUND: barrel export (grep 'send-state-machine' in packages/delivery-core/src/index.ts)
- FOUND: ARCHITECTURE.md heading `## 9. The send delivery state machine`
- FOUND: commit 5cbbc1d in git log
- FOUND: commit 902c190 in git log
- FOUND: this SUMMARY.md on disk
