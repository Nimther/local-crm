---
phase: 03-segmentation-engine
plan: 03
subsystem: ui
tags: [react, tanstack-query, shadcn, popover, command, cmdk, playwright, segments]

# Dependency graph
requires:
  - phase: 03-segmentation-engine (plan 01)
    provides: "@mega-crm/segments-core compiler + SegmentDefinition Zod contract"
  - phase: 03-segmentation-engine (plan 02)
    provides: "Live segments API -- CRUD, preview-count, event-names, :id/members"
provides:
  - "Сегменты nav section + /w/:slug/segments, /w/:slug/segments/new routes"
  - "SegmentBuilder: two-tier AND/OR condition-tree editor (attribute + behavioral rows, typed operators, comboboxes, recap)"
  - "Debounced, stale-safe live-count panel (SEGM-04) with degraded-state handling"
  - "Segment create + save flow with client-side validation"
  - "Minimal segments list (D-10/D-11) with empty state"
  - "Playwright happy-path E2E (create -> live count -> save -> appears in list)"
affects: [03-04-segment-detail, 04-campaigns, 06-flows]

# Tech tracking
tech-stack:
  added: ["@radix-ui/react-popover", "cmdk (via shadcn command)"]
  patterns:
    - "Live-count TanStack Query encodes the full debounced SegmentDefinition JSON as its queryKey (Pitfall 6 stale-response guard) -- no manual AbortController"
    - "Local per-feature useDebouncedValue hook (duplicated, not shared -- Phase 2 convention)"
    - "shadcn popover+command combobox with free-text fallback for both field-picker and event-name picker"

key-files:
  created:
    - apps/web/src/features/segments/api.ts
    - apps/web/src/features/segments/SegmentsListPage.tsx
    - apps/web/src/features/segments/SegmentCreatePage.tsx
    - apps/web/src/features/segments/SegmentBuilder.tsx
    - apps/web/src/features/segments/useDebouncedValue.ts
    - apps/web/src/components/ui/popover.tsx
    - apps/web/src/components/ui/command.tsx
    - apps/web/e2e/segments.spec.ts
  modified:
    - apps/web/src/features/app-shell/AppShell.tsx
    - apps/web/src/App.tsx
    - apps/web/package.json

key-decisions:
  - "03-03: role=\"combobox\" on the shadcn Popover trigger button strips the accessible name-from-content (ARIA naming rules exclude combobox from name-from-content roles) -- dropped the role override on both FieldCombobox/EventCombobox triggers, keeping default button semantics and aria-expanded only"
  - "03-03: builder's standard-field list matches UI-SPEC's exact 6 fields (Страна/Город/Имя/Фамилия/Телефон/Статус подписки) -- no tags condition row this plan, even though segments-core's STANDARD_FIELD_COLUMNS allow-list already supports tags (D-03/D-04 UI scope, not an engine limitation)"
  - "03-03: number-kind operators shown in the builder are exactly gt/gte/lt/lte (no eq/neq) per the plan's own acceptance criteria, even though CONTEXT.md's D-03 prose also mentions ="

requirements-completed: [SEGM-01, SEGM-02, SEGM-04]

coverage:
  - id: D1
    description: "Сегменты nav link + /segments, /segments/new routes + minimal segments list with D-10/D-11 empty state"
    requirement: "SEGM-01"
    verification:
      - kind: e2e
        ref: "e2e/segments.spec.ts#build, preview, and save a segment from the Сегменты section"
        status: pass
      - kind: automated_ui
        ref: "npm run build -w apps/web"
        status: pass
    human_judgment: false
  - id: D2
    description: "SegmentBuilder: two-tier AND/OR condition tree, typed attribute conditions (D-03 operator sets by field kind), field combobox with property-registry + free-text fallback"
    requirement: "SEGM-01"
    verification:
      - kind: e2e
        ref: "e2e/segments.spec.ts#build, preview, and save a segment from the Сегменты section"
        status: pass
    human_judgment: true
    rationale: "Visual layout/spacing conformance to 03-UI-SPEC.md (pill styling, group-card recap placement, combobox styling) is a UI-safety-gate/human-verify concern -- the E2E only proves the interaction path (select field, set value), not visual fidelity."
  - id: D3
    description: "Behavioral condition row (event combobox, count/timeframe with conditional inputs, negation via countOperator=none)"
    requirement: "SEGM-02"
    verification:
      - kind: unit
        ref: "manual code review -- valueInputKind/OPERATORS_BY_KIND exhaustive switch, no automated unit test added this plan (component-level, covered indirectly by build + E2E on the attribute-condition path)"
        status: unknown
    human_judgment: true
    rationale: "No E2E path exercises the behavioral condition row specifically (E2E only builds an attribute condition per the plan's happy-path scope) -- needs a human/functional check that count/timeframe conditional inputs behave correctly (hide count when 'ни разу', hide days when 'за всё время')."
  - id: D4
    description: "Debounced, stale-safe live-count panel: definition-JSON queryKey, dim+spinner while fetching, amber degraded state keeping last exact count"
    requirement: "SEGM-04"
    verification:
      - kind: e2e
        ref: "e2e/segments.spec.ts#build, preview, and save a segment from the Сегменты section"
        status: pass
      - kind: other
        ref: "grep -rn definition apps/web/src/features/segments/SegmentBuilder.tsx | grep -i queryKey"
        status: pass
    human_judgment: true
    rationale: "E2E only proves the count label appears; the degraded/amber timeout path (server statement_timeout -> { degraded: true }) has no automated trigger in this plan's test data volume -- needs a human/load-test check per D-08."
  - id: D5
    description: "Save flow with client-side validation (name, empty group, behavioral count/days) and disabled+loading save button"
    requirement: "SEGM-01"
    verification:
      - kind: e2e
        ref: "e2e/segments.spec.ts#build, preview, and save a segment from the Сегменты section"
        status: pass
    human_judgment: false

duration: 14min
completed: 2026-07-06
status: complete
---

# Phase 3 Plan 3: Segment Builder UI Summary

**Two-tier AND/OR segment builder (attribute + behavioral conditions, typed operators, popover+command comboboxes) with a debounced stale-safe live-count panel and a save flow, reachable from a new Сегменты nav section — E2E-proven end to end.**

## Performance

- **Duration:** 14 min
- **Started:** 2026-07-05T23:54:34+05:00
- **Completed:** 2026-07-06T00:08:48+05:00
- **Tasks:** 3
- **Files modified:** 11

## Accomplishments
- "Сегменты" nav link + `/w/:slug/segments` (list, empty state, CTA) and `/w/:slug/segments/new` (builder) routes
- `SegmentBuilder`: group cards (И between groups, ИЛИ between conditions), typed attribute condition rows (field combobox with standard fields + property-registry custom fields + free-text fallback, D-03 operator sets by field kind, type-appropriate value inputs), behavioral condition rows (event combobox + count/timeframe with conditional inputs, D-06), plain-language group recap
- Debounced (300ms) live-count panel keyed on the full `SegmentDefinition` JSON (Pitfall 6 stale-response guard), dimmed+spinner while fetching, amber "(устарело)" degraded state that never blanks the last exact count
- `SegmentCreatePage`: name field + wired builder + client-side validation (name/group/behavioral count/days) + "Сохранить сегмент" save flow with disabled+loading state, navigates to the list on success
- Playwright happy-path E2E green: register → workspace → Сегменты → build (Страна = RU) → live count → name → save → appears in list

## Task Commits

Each task was committed atomically:

1. **Task 1: Navigation skeleton + failing E2E** - `3efb727` (feat)
2. **Task 2: SegmentBuilder two-tier AND/OR condition tree** - `d73a4d7` (feat)
3. **Task 3: Live-count panel + save flow (E2E green)** - `b0bb590` (feat)

**Plan metadata:** (this commit)

## Files Created/Modified
- `apps/web/src/features/segments/api.ts` - `listSegments`/`fetchEventNames`/`fetchPreviewCount`/`createSegment` typed helpers
- `apps/web/src/features/segments/SegmentsListPage.tsx` - D-10/D-11 list (name/member-count/created), empty state + CTA
- `apps/web/src/features/segments/SegmentCreatePage.tsx` - name field + builder + save flow + validation
- `apps/web/src/features/segments/SegmentBuilder.tsx` - two-tier condition tree + live-count panel (main deliverable)
- `apps/web/src/features/segments/useDebouncedValue.ts` - local 300ms debounce hook
- `apps/web/src/components/ui/popover.tsx` - shadcn official (new this phase)
- `apps/web/src/components/ui/command.tsx` - shadcn official (new this phase)
- `apps/web/e2e/segments.spec.ts` - happy-path E2E
- `apps/web/src/features/app-shell/AppShell.tsx` - "Сегменты" nav link
- `apps/web/src/App.tsx` - `segments`/`segments/new` routes
- `apps/web/package.json` - `@radix-ui/react-popover` + `cmdk` (shadcn-installed deps)

## Decisions Made
- `role="combobox"` on the Popover trigger button strips the button's accessible name-from-content (ARIA naming computation excludes `combobox` from name-from-content roles, so the visible label text is not exposed as the accessible name) — dropped the role override on both `FieldCombobox`/`EventCombobox` triggers, keeping default button semantics + `aria-expanded` only. Discovered while running the E2E: `getByRole("combobox", { name: ... })` matched zero elements even though the button was visibly correct.
- Standard-field list in the builder matches the UI-SPEC's exact 6 fields (Страна/Город/Имя/Фамилия/Телефон/Статус подписки) — no tags condition row this plan, even though `segments-core`'s `STANDARD_FIELD_COLUMNS` allow-list already supports `tags` (a UI scope choice per the UI-SPEC's copywriting contract, not an engine limitation).
- Number-kind field operators shown are exactly gt/gte/lt/lte (no eq/neq), matching the plan's own Task 2 acceptance criteria wording.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `role="combobox"` broke accessible-name computation on combobox trigger buttons**
- **Found during:** Task 3 (running the Playwright E2E against the built UI)
- **Issue:** `FieldCombobox`/`EventCombobox` trigger buttons had `role="combobox"` per the common shadcn combobox recipe. Per ARIA naming rules, `combobox` is not a name-from-content role, so the button's visible text ("Выберите поле") was never exposed as its accessible name — `getByRole` queries (and any AT/screen-reader) would see an unnamed control despite correct visible text.
- **Fix:** Removed the `role="combobox"` override on both trigger buttons, keeping the native `<button>` role (name-from-content) plus `aria-expanded` for open/closed state.
- **Files modified:** `apps/web/src/features/segments/SegmentBuilder.tsx`
- **Verification:** `npm run test:e2e -w apps/web -- segments.spec.ts` passes; full E2E suite (3 specs) green.
- **Committed in:** `b0bb590` (Task 3 commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Necessary correctness/accessibility fix discovered via the plan's own E2E verification step. No scope creep — same trigger-button component, same interaction, just correct accessible-name semantics.

## Issues Encountered
- Two Playwright debug scripts were used transiently to diagnose the `role="combobox"` accessible-name issue (evaluating `outerHTML` and `ariaSnapshot()` of the failing element) — deleted after diagnosis, not part of the shipped code.
- None otherwise — plan tasks executed in order, each turning the E2E from RED (Task 1) toward GREEN (Task 3).

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- SEGM-01/02/04 are demonstrable end-to-end in the UI (build → live count → save → list).
- Ready for 03-04 (segment detail page: editable definition + paginated member list, reusing this same `SegmentBuilder` component and the Phase 2 contacts-table pattern per D-12).
- No blockers. The segment detail route (`/w/:slug/segments/:id`) is already linked from `SegmentsListPage`'s rows but not yet implemented — expected, out of this plan's scope (03-04).

## Self-Check: PASSED

- All 8 key files verified present on disk (`[ -f ]`).
- All 3 task commit hashes (`3efb727`, `d73a4d7`, `b0bb590`) verified in `git log --oneline --all`.
- `npm run build -w apps/web` clean (re-run after final edits).
- `npm run test:e2e -w apps/web` — 3/3 specs passing (contact-search-focus, register-create-workspace, segments).
- `grep -rn "definition" apps/web/src/features/segments/SegmentBuilder.tsx | grep -i "queryKey"` — non-empty match confirmed.

---
*Phase: 03-segmentation-engine*
*Completed: 2026-07-06*
