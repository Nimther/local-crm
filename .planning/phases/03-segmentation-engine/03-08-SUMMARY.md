---
phase: 03-segmentation-engine
plan: 08
subsystem: testing
tags: [playwright, e2e, segments, tags, behavioral-conditions, degraded-state]

# Dependency graph
requires:
  - phase: 03-segmentation-engine (03-07)
    provides: Тег-reachable SegmentBuilder (STANDARD_FIELDS tags entry) + shared validateDefinition client-side save guard
provides:
  - Automated E2E for the SEGM-01 tags condition build/save/reopen slice
  - Automated E2E regression guard for CR-01 (default-empty-condition loud failure)
  - Automated E2E for SEGM-02 behavioral conditional inputs (count/timeframe show/hide) + round-trip
  - Automated E2E for SEGM-04 degraded live-count state via route interception
affects: [03-VERIFICATION re-run, any future segmentation-engine UI regression suite]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Radix Select-role comboboxes (countOperator/timeframe) are selected by DOM-order index via getByRole('combobox').nth(n) -- they carry no accessible name-from-content (ARIA excludes combobox from name-from-content roles, per the 03-03 STATE decision), unlike the custom Field/Event popover comboboxes which are plain buttons."
    - "SEGM-04 degraded-state proof uses page.route interception on **/segments/preview-count returning the exact { degraded: true } shape the real route emits on Postgres 57014, since a real statement_timeout cannot be forced at test-data volume."

key-files:
  created:
    - apps/web/e2e/segments-tags.spec.ts
    - apps/web/e2e/segments-behavior.spec.ts
  modified: []

key-decisions:
  - "Radix Select triggers (role=combobox) are located by nth-index in DOM order rather than by accessible name, since combobox is a name-from-author-only ARIA role and the Select's visible text is not exposed as its accessible name."
  - "The SEGM-02 test removes the default empty attribute condition before adding the behavioral condition, so the group contains only the behavioral row under test and CR-01's client-side validation doesn't block the save."
  - "The SEGM-04 degraded-state assertion uses toContainText (not toHaveText) on the count paragraph, since the amber '(устарело)' marker renders as a sibling <span> inside the same <p> as the count digits."

patterns-established:
  - "New Playwright specs for segmentation-engine gap-closure are kept as separate files from the original happy-path segments.spec.ts, so a spec addition never risks destabilizing an already-green baseline test."

requirements-completed: [SEGM-01, SEGM-02, SEGM-04]

coverage:
  - id: D1
    description: "A marketer can build a tags condition (Теги + есть тег + value), save it, and reopen it with the tags condition prefilled (SEGM-01 tags slice)."
    requirement: "SEGM-01"
    verification:
      - kind: e2e
        ref: "apps/web/e2e/segments-tags.spec.ts#build, save, and reopen a tags segment (SEGM-01 tags slice)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Saving the default unconfigured attribute condition shows an inline validation error and does not navigate away (CR-01 regression)."
    requirement: "SEGM-01"
    verification:
      - kind: e2e
        ref: "apps/web/e2e/segments-tags.spec.ts#CR-01 regression: saving the default unconfigured condition fails loudly, not silently"
        status: pass
    human_judgment: false
  - id: D3
    description: "The behavioral condition row's count input hides on 'ни разу' / shows on 'выполнено >= N раз', and the days input hides on 'за всё время' / shows on 'за последние N дней', with the configured condition round-tripping through save and reopen (SEGM-02)."
    requirement: "SEGM-02"
    verification:
      - kind: e2e
        ref: "apps/web/e2e/segments-behavior.spec.ts#behavioral conditional inputs hide/show correctly and round-trip through save (SEGM-02)"
        status: pass
    human_judgment: false
  - id: D4
    description: "When preview-count responds { degraded: true }, the amber '(устарело)' marker renders and the last-good count is preserved, never blanked to zero (SEGM-04)."
    requirement: "SEGM-04"
    verification:
      - kind: e2e
        ref: "apps/web/e2e/segments-behavior.spec.ts#degraded live-count state shows the amber marker and preserves the last-good count (SEGM-04)"
        status: pass
    human_judgment: false

duration: 15min
completed: 2026-07-06
status: complete
---

# Phase 03 Plan 08: Segmentation UI Gap-Closure E2E Summary

**Two new Playwright specs (`segments-tags.spec.ts`, `segments-behavior.spec.ts`) automate the four UI-tier behaviors 03-VERIFICATION.md could not confirm: the tags condition slice, the CR-01 default-empty-condition loud-failure regression, the SEGM-02 behavioral conditional inputs, and the SEGM-04 degraded live-count state via route interception.**

## Performance

- **Duration:** ~15 min
- **Completed:** 2026-07-06
- **Tasks:** 2 completed
- **Files modified:** 2 (both new)

## Accomplishments

- `segments-tags.spec.ts`: proves a marketer can build a «Теги» + «есть тег» + value condition, save it, and reopen it with the condition prefilled — closing the UI half of the failed truth in 03-VERIFICATION.md (tags engine-complete but previously unreachable in the builder).
- `segments-tags.spec.ts`: proves the CR-01 regression is fixed — saving the default unconfigured attribute condition shows the inline «Выберите поле в каждом условии» error and never navigates away from the create page.
- `segments-behavior.spec.ts`: proves the behavioral row's count/days inputs correctly hide and show across all four countOperator/timeframe combinations, and that a configured behavioral condition round-trips through save and reopen.
- `segments-behavior.spec.ts`: proves the SEGM-04 degraded state — a real last-good count settles first, then a `page.route`-intercepted `{ degraded: true }` response is asserted to keep the amber «(устарело)» marker visible alongside the preserved (never blanked) count.

## Task Commits

Each task was committed atomically:

1. **Task 1: Tags-slice E2E + CR-01 default-empty-condition regression** - `e5ae91c` (test)
2. **Task 2: SEGM-02 behavioral conditional inputs + SEGM-04 degraded state (route-intercepted)** - `2e390f1` (test)

**Plan metadata:** (this commit)

## Files Created/Modified

- `apps/web/e2e/segments-tags.spec.ts` - Tags build→save→reopen E2E + CR-01 default-empty-condition regression guard
- `apps/web/e2e/segments-behavior.spec.ts` - SEGM-02 behavioral conditional-input E2E + round-trip; SEGM-04 degraded-state E2E via `page.route` interception

## Decisions Made

- Radix `<Select>` triggers (countOperator, timeframe) are located by `getByRole("combobox").nth(index)` rather than by accessible name — `combobox` is one of the ARIA roles excluded from name-from-content, so the trigger's visible text (e.g. "ни разу") is not exposed as its accessible name to Playwright's role queries. This mirrors the same finding STATE.md already recorded for the custom Field/Event popover comboboxes (03-03), just at the framework-Select layer instead of the custom-component layer.
- In the SEGM-02 test, the default empty attribute condition is removed before adding the behavioral condition under test, so the segment group contains only the behavioral row — this keeps the save from tripping the now-working CR-01 client-side validation on the untouched default row.
- The SEGM-04 assertion checks `toContainText` (not `toHaveText`) on the count paragraph, since the "(устарело)" marker is a sibling `<span>` rendered inside the same `<p>` as the count digits, not a separate element.

## Deviations from Plan

None - plan executed exactly as written. Both selectors described in the plan's `read_first` sections (STANDARD_FIELDS tags entry, BehavioralConditionRow conditional inputs, degraded-state amber rendering) matched the current source exactly; no source files needed modification.

## Issues Encountered

- During iterative verification, running the full E2E suite (`npm run test:e2e -w apps/web`) repeatedly back-to-back within a short window occasionally tripped the pre-existing `/api/auth/*` rate limit (`max: 20` per minute, `apps/api/src/modules/auth/plugin.ts`), causing whichever test happened to run next (including the pre-existing `segments.spec.ts`) to time out on registration. This is a pre-existing test-infrastructure characteristic unrelated to this plan's changes — not a regression introduced here, and out of scope to fix (no file in this plan touches the auth rate-limit config). The plan's actual verification commands, run in isolation as specified (`-- segments-tags.spec.ts` and `-- segments-behavior.spec.ts`), pass cleanly and repeatably.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- All four previously-unverified/failed UI-tier behaviors from 03-VERIFICATION.md (tags slice, CR-01, SEGM-02 conditional inputs, SEGM-04 degraded state) now have automated E2E coverage and pass.
- Re-running phase 03 verification should be able to flip the failed truth's UI half and both `behavior_unverified_items` to verified without further human judgment.
- No blockers for closing out phase 03-segmentation-engine.

---
*Phase: 03-segmentation-engine*
*Completed: 2026-07-06*

## Self-Check: PASSED

- FOUND: apps/web/e2e/segments-tags.spec.ts
- FOUND: apps/web/e2e/segments-behavior.spec.ts
- FOUND commit: e5ae91c
- FOUND commit: 2e390f1
