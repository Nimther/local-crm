---
phase: 15-observability-alerting-frontend-resilience
plan: 09
subsystem: ui
tags: [react-router, useBlocker, beforeunload, flow-canvas, autosave, unsaved-changes]

# Dependency graph
requires:
  - phase: 15-observability-alerting-frontend-resilience
    provides: "plan 15-03's data-router migration (createBrowserRouter/RouterProvider) -- the hard prerequisite useBlocker needs"
provides:
  - "deriveUnsavedChanges: pure boolean derivation of unsaved canvas work, plus useAutosaveDraft's extended unsaved/retry return fields"
  - "useUnsavedChangesGuard: data-router useBlocker + beforeunload native prompt, both driven by the same unsaved signal"
  - "UnsavedChangesDialog and SaveErrorBanner components wired into FlowCanvas"
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pure narrow-boolean derivation kept standalone from an existing tested state-machine derivation (deriveUnsavedChanges alongside deriveAutosaveState), rather than widening the tested function's contract"
    - "useBlocker predicate compares currentLocation.pathname !== nextLocation.pathname so in-place search-param/selection changes on the same route never trigger a confirmation dialog"
    - "beforeunload listener registered/removed in lockstep with the dirty boolean via a single effect, so it never outlives the dirty state"

key-files:
  created:
    - apps/web/src/features/flows/canvas/useUnsavedChangesGuard.ts
    - apps/web/src/features/flows/canvas/UnsavedChangesDialog.tsx
    - apps/web/src/features/flows/canvas/SaveErrorBanner.tsx
    - apps/web/e2e/flow-unsaved-changes.spec.ts
  modified:
    - apps/web/src/features/flows/canvas/useAutosaveDraft.ts
    - apps/web/src/features/flows/canvas/FlowCanvas.tsx
    - apps/web/src/features/flows/canvas/__tests__/useUnsavedChangesGuard.test.ts

key-decisions:
  - "deriveUnsavedChanges kept as a second, narrower pure function rather than folding into deriveAutosaveState -- that function's three-state output drives the toolbar label and its behavior is pinned by existing tests (WR-05/T-06-21-02); a second boolean answering a different question (\"is there unsaved work\" vs \"what should the label read\") is cheaper to add than to widen a tested contract."
  - "The toolbar's existing three-state indicator can read \"Сохранено\" during the ~1s debounce window before a save even fires (deriveAutosaveState's pre-existing, unchanged behavior) -- discovered while writing the e2e spec's second test, which had to gate on the actual draft PATCH response rather than the toolbar text to avoid a false negative."
  - "Manual retry re-fires the exact same debouncedJson target immediately (mirroring the existing bounded RETRY_DELAY_MS retry's own onError/baseline-reset shape) rather than introducing a second retry code path."

requirements-completed: [OPS-19]

coverage:
  - id: D1
    description: "deriveUnsavedChanges: pure derivation covering all five behavior rows (debounce-pending, in-flight, errored+dirty, paused+dirty, settled+saved)"
    requirement: "OPS-19"
    verification:
      - kind: unit
        ref: "apps/web/src/features/flows/canvas/__tests__/useUnsavedChangesGuard.test.ts (6 tests) -- npx vitest run --root apps/web"
        status: pass
      - kind: other
        ref: "deriveAutosaveState signature/return type diffed against git show HEAD -- unchanged"
        status: pass
    human_judgment: false
  - id: D2
    description: "useUnsavedChangesGuard: useBlocker blocks only on cross-pathname navigation while unsaved; beforeunload listener registered/removed with the dirty flag"
    requirement: "OPS-19"
    verification:
      - kind: e2e
        ref: "apps/web/e2e/flow-unsaved-changes.spec.ts -- 'in-app navigation...opens the dialog', 'with everything saved...no dialog', 'beforeunload fires...' -- npm run test:e2e -w apps/web -- flow-unsaved-changes.spec.ts (4/4 passing, run twice)"
        status: pass
      - kind: integration
        ref: "npm run build -w apps/web && npm run lint (scoped to touched files) -- exit 0"
        status: pass
    human_judgment: false
  - id: D3
    description: "SaveErrorBanner: persistent inline banner (not a toast, no auto-dismiss) with Retry, conditioned on saveState === 'error'"
    requirement: "OPS-19"
    verification:
      - kind: e2e
        ref: "apps/web/e2e/flow-unsaved-changes.spec.ts -- 'a failed draft save shows a persistent banner with Retry...'"
        status: pass
    human_judgment: false

# Metrics
duration: 10min
completed: 2026-08-15
status: complete
---

# Phase 15 Plan 09: Unsaved Canvas Changes Guard & Save-Error Banner Summary

**Data-router `useBlocker` + native `beforeunload` guard the flow canvas against losing unsaved work, and a persistent inline banner with Retry makes a failed autosave impossible to miss.**

## Performance

- **Duration:** 10 min
- **Started:** 2026-08-15T16:57:00Z
- **Completed:** 2026-08-15T17:08:20Z
- **Tasks:** 3
- **Files modified:** 7 (4 created, 3 modified)

## Accomplishments

- `useAutosaveDraft.ts` gained `deriveUnsavedChanges` -- a pure, standalone boolean derivation (`debouncePending || isPending || isPaused || (isError && dirty)`) answering "is there unsaved work", kept deliberately separate from the existing tested `deriveAutosaveState` three-state toolbar derivation. The hook's return now also includes a `retry` callback that re-fires the exact failed target immediately, without waiting for another edit or the existing bounded `RETRY_DELAY_MS` retry.
- `useUnsavedChangesGuard.ts` (new): wraps React Router's data-router `useBlocker` (the hard prerequisite plan 15-03's `App.tsx` migration unlocked) with a predicate that blocks only when there are unsaved changes AND the target pathname differs from the current one -- in-place search-param/node-selection changes on the same route never trigger the dialog. A `beforeunload` listener is registered and torn down inside a single effect keyed on the unsaved flag, so it never outlives the dirty state.
- `UnsavedChangesDialog.tsx` (new): stay/discard confirmation on the existing `alert-dialog` primitive. Stay resets the blocker and leaves the canvas untouched; discard proceeds with the original navigation and attempts no further save.
- `SaveErrorBanner.tsx` (new): persistent inline banner (never a toast, never auto-dismissing) with a Retry control wired to the Task 1 `retry` callback -- reads as a sibling of the existing `QueryErrorState` inline-error idiom.
- `FlowCanvas.tsx`: wires all three into `FlowCanvasInner` alongside the untouched toolbar indicator, node/edge state, serialization, and debounce.
- `apps/web/e2e/flow-unsaved-changes.spec.ts` (new): four Playwright tests covering (1) in-app nav with unsaved changes -> dialog -> stay cancels / discard proceeds, (2) everything saved -> no dialog, (3) a route-intercepted failed draft PATCH -> persistent banner + Retry + toolbar never reads saved, and (4) native `beforeunload` fires while dirty and not when clean (asserted on the dialog event, never its message). Run twice locally against a real provisioned e2e database: 4/4 passing both times, exit 0.

## Task Commits

Each task was committed atomically:

1. **Task 1: Expose an explicit dirty signal from the existing autosave hook** - `d187325` (feat)
2. **Task 2: Guard in-app navigation and tab close, and make the save failure persistent** - `e366a68` (feat)
3. **Task 3: End-to-end proof of both guards** - `8ee3409` (test)

_No TDD RED/GREEN split -- Task 1 was authored test-alongside per the plan's `tdd="true"` marker (pure-function unit tests added in the same commit as the derivation, following the existing `autosaveState.test.ts` no-jsdom idiom). No separate plan-metadata commit (per worktree instructions, STATE.md/ROADMAP.md are not touched by this agent)._

## Files Created/Modified

- `apps/web/src/features/flows/canvas/useAutosaveDraft.ts` - Added `deriveUnsavedChanges` pure derivation + extended `useAutosaveDraft` return (`unsaved`, `retry`)
- `apps/web/src/features/flows/canvas/__tests__/useUnsavedChangesGuard.test.ts` (new) - Unit tests for all five `deriveUnsavedChanges` behavior rows + the settled-error case
- `apps/web/src/features/flows/canvas/useUnsavedChangesGuard.ts` (new) - `useBlocker` + `beforeunload` guard hook
- `apps/web/src/features/flows/canvas/UnsavedChangesDialog.tsx` (new) - Stay/discard confirmation dialog
- `apps/web/src/features/flows/canvas/SaveErrorBanner.tsx` (new) - Persistent inline save-error banner with Retry
- `apps/web/src/features/flows/canvas/FlowCanvas.tsx` - Wires the guard, dialog, and banner into the canvas
- `apps/web/e2e/flow-unsaved-changes.spec.ts` (new) - End-to-end proof of both guards and the banner

## Decisions Made

- `deriveUnsavedChanges` is a second, narrower pure function rather than a widened `deriveAutosaveState` -- see key-decisions above.
- The existing toolbar indicator can read "Сохранено" during the ~1s debounce window before a save has actually fired (a pre-existing, unchanged Phase 6 characteristic of `deriveAutosaveState`, which only distinguishes idle/saving/error and does not itself track debounce-pending). Discovered while writing the e2e spec's "everything saved" test, which initially gated on the toolbar text alone and got a false negative (the blocker legitimately fired because the debounce genuinely hadn't settled yet, even though the toolbar already said "Сохранено"). Fixed by gating that test on the real draft PATCH response (`page.waitForResponse`) instead of the toolbar text -- no application code changed, since the toolbar's existing behavior is correct and untouched by this plan (it drives WR-05's error labeling, not an "unsaved" flag).
- Manual retry re-fires the exact same `debouncedJson` target immediately, mirroring the existing bounded delayed retry's own `onError`/baseline-reset shape, rather than introducing a second retry code path.

## Deviations from Plan

None - plan executed exactly as written. The toolbar-timing discovery above was a test-authoring correction (fixing the e2e spec's own gating condition), not a deviation from the plan's specified behavior or an application-code change.

## Issues Encountered

- This worktree had no `node_modules` installed (as in plan 15-03's precedent). `package-lock.json` was confirmed byte-identical to the main checkout, so `node_modules` was symlinked in from the main checkout (root + every `apps/*` + every `packages/*` workspace) purely to run `vitest`, `tsc`, `eslint`, the Vite build, and the real Playwright e2e run against a provisioned ephemeral database. All symlinks were removed before this commit; `git status` was confirmed clean before writing this summary. No symlink or `node_modules` content was ever staged or committed.
- The e2e run required an env file with `TEST_DATABASE_URL`/`REDIS_URL` (found at the machine's existing `MEGA_CRM_ENV_FILE` default location, `~/.config/mega-crm/.env`, per the operational prerequisite already recorded in STATE.md) -- not itself a deviation, just the standard e2e prerequisite already documented for this repo.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- OPS-19 is closed: unsaved canvas changes produce a warning in both navigation directions, and a save failure is visible and retryable, all proven end-to-end against a real browser and a real provisioned database (4/4 e2e tests, run twice, deterministic).
- No known stubs. No skipped tests. All three `<verify>` blocks from the plan were actually run (not just written): `npx vitest run --root apps/web` (70/70 passing), `npm run build -w apps/web` (exit 0), scoped `eslint` on every touched file (clean), and `npm run test:e2e -w apps/web -- flow-unsaved-changes.spec.ts` (4/4 passing, twice).
- The three `prohibitions` from the plan's frontmatter (no new autosave/draft model; banner must never be a toast; toolbar must never read saved while errored+dirty; retry must never become a hot loop) all hold by construction: `useUpdateFlowDraft`/the debounce/the existing bounded retry are byte-unchanged; `SaveErrorBanner` contains no toast call and is gated on `saveState === "error"`; `deriveAutosaveState`'s signature and body are identical to `git show HEAD`; the manual retry is user-click-triggered only, with no timer or loop.

## Self-Check: PASSED

All 5 created/modified files confirmed present on disk; all 3 task commit hashes (`d187325`, `e366a68`, `8ee3409`) confirmed present in `git log --oneline --all`.

---
*Phase: 15-observability-alerting-frontend-resilience*
*Completed: 2026-08-15*
