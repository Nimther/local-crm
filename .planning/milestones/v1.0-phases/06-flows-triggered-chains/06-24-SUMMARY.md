---
phase: 06-flows-triggered-chains
plan: 24
subsystem: ui
tags: [react, vitest, canvas, autosave, xyflow, tanstack-query, gap-closure]

# Dependency graph
requires:
  - phase: 06-flows-triggered-chains
    provides: "deriveAutosaveState(...) pure function + FlowCanvas honest error rendering (06-21/WR-05)"
provides:
  - "deriveAutosaveState(...) widened to {isPending, isPaused, isError, dirty} -> AutosaveState"
  - "Offline-paused autosave (TanStack Query networkMode 'online' pause) renders the honest 'error' state instead of an indefinite 'saving'"
affects: [flows-canvas, future-flow-plans-touching-autosave]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "isPaused-aware state derivation: a TanStack Query mutation paused by offline networkMode is modeled as its own input (not inferred from isPending alone), checked before the plain isPending branch"

key-files:
  created: []
  modified:
    - apps/web/src/features/flows/canvas/__tests__/autosaveState.test.ts
    - apps/web/src/features/flows/canvas/useAutosaveDraft.ts

key-decisions:
  - "Fix direction: model mutation.isPaused in the pure derivation (unit-testable, relies on TanStack's built-in resume-paused-mutations-on-reconnect) rather than networkMode: 'always' (would fire doomed fetches while offline and depend on the hook's own 4s bounded retry to own reconnection)"
  - "No FlowCanvas.tsx change needed — it already renders the 'error' state ('Не сохранено — повтор…') honestly from 06-21; only the derivation and its wiring changed"
  - "No queryClient.ts or useUpdateFlowDraft networkMode change — default 'online' networkMode is kept so TanStack's automatic resume-on-reconnect owns the auto-retry half"

patterns-established:
  - "When a TanStack Query mutation can be paused (offline), a pure state-derivation function must accept isPaused as a distinct input from isPending — inferring 'in flight' from isPending alone conflates 'actively saving' with 'queued, never dispatched'"

requirements-completed: [FLOW-01]

coverage:
  - id: D1
    description: "deriveAutosaveState pure function returns 'error' for the paused-offline shape (isPending:true, isPaused:true, isError:false), both with dirty:false and dirty:true, while all four 06-21 settled-state cases are unchanged"
    requirement: "FLOW-01"
    verification:
      - kind: unit
        ref: "apps/web/src/features/flows/canvas/__tests__/autosaveState.test.ts#06-21/WR-05 deriveAutosaveState"
        status: pass
    human_judgment: false
  - id: D2
    description: "Live browser behavior: with the canvas open, going offline in devtools and making an edit shows 'Не сохранено — повтор…' (not a stuck 'Сохранение…'); restoring connectivity re-fires the PATCH via TanStack's automatic resume and the toolbar returns to 'Сохранено' with no further user edit"
    requirement: "FLOW-01"
    verification: []
    human_judgment: true
    rationale: "The web unit-test lane is node-only (no jsdom/@testing-library) per project convention — DOM rendering, real browser online/offline events, and TanStack's live resume-on-reconnect timing require phase-level UAT re-run (Test 11), consistent with 06-21/06-22's precedent."

# Metrics
duration: 5min
completed: 2026-07-13
status: complete
---

# Phase 06 Plan 24: Offline-paused autosave honest error state (UAT Test 11 gap-closure) Summary

**Widened `deriveAutosaveState` to model `mutation.isPaused` so an autosave paused by TanStack Query's default offline `networkMode: 'online'` renders the honest «Не сохранено — повтор…» state instead of an indefinite «Сохранение…».**

## Performance

- **Duration:** ~5 min
- **Tasks:** 1
- **Files modified:** 2 (both modified, none created)

## Accomplishments
- Root cause (from `.planning/debug/autosave-error-state-stuck.md`): TanStack Query v5's default `networkMode: 'online'` pauses the draft-autosave mutation while offline — `mutate()` dispatches `status:'pending'` with `isPaused:true`, the PATCH `mutationFn` is never invoked, and `isError` never becomes true. `deriveAutosaveState` only modeled `isPending`/`isError`/`dirty`, so `isPending:true` won and the toolbar showed «Сохранение…» forever.
- Added two regression cases to `autosaveState.test.ts` pinning the paused-offline shape (`isPending:true, isPaused:true, isError:false`, both `dirty:false` and `dirty:true`) → `'error'`. Confirmed RED (2 failing, 4 passing) against the pre-fix derivation before implementing.
- Widened `deriveAutosaveState`'s signature with `isPaused: boolean` and added `if (isPending && isPaused) return "error";` before the existing `if (isPending) return "saving";` guard. Updated the doc comment to explain the offline-pause semantics and that TanStack's automatic resume-on-reconnect owns the auto-retry half.
- Wired `mutation.isPaused` into the hook's `saveState` derivation call site alongside the existing `isPending`/`isError`/`dirty` inputs.
- Confirmed GREEN: all 6 `autosaveState` tests pass (4 preserved 06-21 settled-state cases + 2 new paused-offline cases); `npm run build -w apps/web` (tsc --noEmit + vite build) passes clean.

## Task Commits

Each task was committed atomically (TDD RED→GREEN):

1. **Task 1a — RED: failing paused-offline regression tests** - `c4fc048` (test)
2. **Task 1b — GREEN: model isPaused in deriveAutosaveState, wire mutation.isPaused** - `3445ae8` (feat)

**Plan metadata:** pending (this commit)

## TDD Gate Compliance

- RED gate: `c4fc048` (`test(06-24): add failing paused-offline autosave regression cases`) — confirmed failing (2/6 tests failed: expected 'error', received 'saving') before any implementation change.
- GREEN gate: `3445ae8` (`feat(06-24): model isPaused in deriveAutosaveState for offline autosave`) — all 6 tests pass, `npm run build -w apps/web` clean.
- REFACTOR gate: not needed — implementation was minimal (one guard clause + one call-site widening) and clean on first pass.

## Files Created/Modified
- `apps/web/src/features/flows/canvas/__tests__/autosaveState.test.ts` - added `isPaused: false` to the four existing 06-21 cases (signature widened, outcomes unchanged) and two new paused-offline regression cases (06-24 / UAT Test 11)
- `apps/web/src/features/flows/canvas/useAutosaveDraft.ts` - `deriveAutosaveState` gained an `isPaused` input and an `isPending && isPaused` guard mapped to `'error'`, checked before the plain `isPending` → `'saving'` branch; `saveState` derivation call site now passes `mutation.isPaused`

## Decisions Made
- Modeled `isPaused` in the pure derivation rather than switching `useUpdateFlowDraft` to `networkMode: 'always'` — the isPaused approach is directly unit-testable in the node-only web lane and leans on TanStack's built-in resume-paused-mutations-on-reconnect for the auto-retry half, whereas `networkMode: 'always'` would fire doomed fetches while offline.
- No change to `FlowCanvas.tsx` — it already renders the `'error'` state («Не сохранено — повтор…») honestly from 06-21; only the derivation and its wiring needed to change.
- The existing 4s bounded retry effect (keyed on `mutation.isError`) is unaffected: a paused mutation has `isError:false`, so it never fires that retry; reconnection is owned entirely by TanStack's resume.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
UAT Test 11 gap closed at the unit level: an offline-paused autosave now derives the honest not-saved/retrying state instead of an indefinite «Сохранение…», and the existing 06-21 settled-state behaviors (in-flight saving, settled success, settled error with unsaved changes, stale error with nothing unsaved) are all preserved. Live browser re-verification (devtools offline toggle → edit → «Не сохранено — повтор…» → restore connectivity → automatic PATCH resume → «Сохранено») remains flagged for phase-level UAT re-run (D2 above), consistent with this codebase's node-only web test lane convention.

---
*Phase: 06-flows-triggered-chains*
*Completed: 2026-07-13*

## Self-Check: PASSED

- FOUND: apps/web/src/features/flows/canvas/__tests__/autosaveState.test.ts (isPaused cases present)
- FOUND: `if (isPending && isPaused) return "error";` in useAutosaveDraft.ts
- FOUND: commit c4fc048 (test)
- FOUND: commit 3445ae8 (feat)
