---
phase: 06-flows-triggered-chains
plan: 21
subsystem: ui
tags: [react, vitest, canvas, autosave, xyflow]

# Dependency graph
requires:
  - phase: 06-flows-triggered-chains
    provides: useAutosaveDraft/FlowCanvas debounced draft autosave (06-10), pure-function web-unit-test lane precedent (04-18/segmentSaveGate)
provides:
  - "deriveAutosaveState(...): a pure, exported function mapping {isPending, isError, dirty} -> AutosaveState"
  - "AutosaveState extended with an honest 'error' state"
  - "Automatic bounded retry of a failed autosave, no further edit required"
  - "FlowCanvas toolbar renders 'Не сохранено — повтор…' instead of falsely claiming «Сохранено» after a failed save"
affects: [flows-canvas, future-flow-plans-touching-autosave]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pure-function extraction for state derivation, unit-tested in the node-only vitest lane (mirrors segmentSaveGate.test.ts) — no jsdom/@testing-library install"
    - "Bounded single setTimeout retry inside a useEffect keyed on the failure/target, cleared on unmount/dep-change, to avoid a hot loop while still self-healing without a user edit"

key-files:
  created:
    - apps/web/src/features/flows/canvas/__tests__/autosaveState.test.ts
  modified:
    - apps/web/src/features/flows/canvas/useAutosaveDraft.ts
    - apps/web/src/features/flows/canvas/FlowCanvas.tsx

key-decisions:
  - "dirty is computed as lastSavedRef.current !== json (the immediate serialization), not debouncedJson, per plan's literal spec"
  - "Auto-retry delay fixed at 4000ms, a single scheduled retry per failure/target combination — cleared whenever isError, dirty, or the target changes"
  - "Toolbar error copy: «Не сохранено — повтор…» rendered with text-destructive tone, kept inline (no toast) per 06-UI-SPEC"

patterns-established:
  - "Autosave error/retry pattern: derive state as a pure function of {isPending, isError, dirty}; schedule the retry effect separately from the primary debounce-save effect so a stale error state cannot silently claim success"

requirements-completed: [FLOW-01]

coverage:
  - id: D1
    description: "deriveAutosaveState pure function returns saving/error/idle correctly, including the WR-05 bug case (isPending:false, isError:true, dirty:true -> error, not idle)"
    requirement: "FLOW-01"
    verification:
      - kind: unit
        ref: "apps/web/src/features/flows/canvas/__tests__/autosaveState.test.ts#06-21/WR-05 deriveAutosaveState"
        status: pass
    human_judgment: false
  - id: D2
    description: "FlowCanvas toolbar renders the honest error/retrying state (not «Сохранено») and the automatic retry actually re-fires the PATCH against a running app"
    requirement: "FLOW-01"
    verification: []
    human_judgment: true
    rationale: "The web unit-test lane is node-only (no jsdom/@testing-library) per project convention — DOM rendering and live retry timing against the running app require phase-level UAT, consistent with segmentSaveGate.test.ts's precedent."

# Metrics
duration: 2min
completed: 2026-07-10
status: complete
---

# Phase 06 Plan 21: Honest autosave error state + automatic retry (WR-05) Summary

**Extracted a pure, unit-tested `deriveAutosaveState` in `useAutosaveDraft.ts` that adds an honest "error" state and a bounded automatic retry, so the canvas toolbar never claims «Сохранено» after a failed autosave PATCH.**

## Performance

- **Duration:** 2 min
- **Started:** 2026-07-10T14:46:38Z
- **Completed:** 2026-07-10T14:48:24Z
- **Tasks:** 2
- **Files modified:** 3 (1 created, 2 modified)

## Accomplishments
- Pure-function regression test (`autosaveState.test.ts`) pins the WR-05 bug case in the node-only vitest lane — RED confirmed against the prior isPending-only derivation, GREEN after the fix
- `deriveAutosaveState({ isPending, isError, dirty })` extracted and exported from `useAutosaveDraft.ts`; `AutosaveState` extended to `"idle" | "saving" | "error"`
- A single bounded (4s) automatic retry effect re-fires the failed save without requiring a further user edit, closing the silent-draft-loss gap (T-06-21-01), while remaining hot-loop-safe (T-06-21-02)
- `FlowCanvas.tsx` toolbar renders «Не сохранено — повтор…» (destructive tone) for the error state instead of falsely showing «Сохранено»

## Task Commits

Each task was committed atomically:

1. **Task 1: Add a failing pure-function regression test for the derived save state (RED)** - `5112696` (test)
2. **Task 2: Honest error state + automatic retry for autosave (GREEN)** - `9a0e0ff` (feat)

**Plan metadata:** pending (this commit)

## TDD Gate Compliance

- RED gate: `5112696` (`test(06-21): ...`) — confirmed failing (`deriveAutosaveState is not a function`) before any implementation.
- GREEN gate: `9a0e0ff` (`feat(06-21): ...`) — all 4 test cases pass, `tsc --noEmit` clean.
- REFACTOR gate: not needed — implementation was minimal and clean on first pass.

## Files Created/Modified
- `apps/web/src/features/flows/canvas/__tests__/autosaveState.test.ts` - new pure-function regression suite for `deriveAutosaveState`
- `apps/web/src/features/flows/canvas/useAutosaveDraft.ts` - exported `deriveAutosaveState`, extended `AutosaveState` with `"error"`, computed `dirty`, added bounded auto-retry effect
- `apps/web/src/features/flows/canvas/FlowCanvas.tsx` - toolbar renders the honest error/retrying copy instead of the prior two-branch `saving`/`Сохранено` ternary

## Decisions Made
- `dirty` derived as `lastSavedRef.current !== json` (immediate serialization), matching the plan's literal spec, rather than comparing against `debouncedJson`.
- Retry delay fixed at 4000ms as a single scheduled timeout per failure/target, cleared on `isError`/`dirty`/target change or unmount — bounded per T-06-21-02, never a hot loop.
- Kept the indicator inline (no toast) per 06-UI-SPEC's canvas-chrome convention for routine autosave state.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
WR-05 closed: the autosave indicator is now derived from a pure, unit-tested function and never claims «Сохранено» after a failed save with unsaved changes pending; a failed save self-heals via a bounded automatic retry. Live retry-timing/toolbar-rendering behavior remains flagged for phase-level UAT (D2 above), consistent with this codebase's existing node-only web test lane convention.

---
*Phase: 06-flows-triggered-chains*
*Completed: 2026-07-10*

## Self-Check: PASSED

- FOUND: apps/web/src/features/flows/canvas/__tests__/autosaveState.test.ts
- FOUND: export function deriveAutosaveState in useAutosaveDraft.ts
- FOUND: commit 5112696 (test)
- FOUND: commit 9a0e0ff (feat)
