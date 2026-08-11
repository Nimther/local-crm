---
phase: 03-segmentation-engine
plan: 07
subsystem: ui
tags: [react, zod, segments, forms, pagination, tanstack-query]

# Dependency graph
requires:
  - phase: 03-segmentation-engine
    provides: STANDARD_FIELD_KEYS allow-list (including "tags") from 03-05's shared-schemas segment.ts; the has_tag/not_has_tag operators the segments-core compiler already supports from 03-01
provides:
  - Shared validateDefinition.ts (validator + GENERIC_ERROR) imported by both create and detail pages
  - Tags condition reachable in the segment builder UI (STANDARD_FIELDS + OPERATORS_BY_KIND)
  - Inline validation error on saving an unconfigured/empty condition (CR-01)
  - Visible server error on a failed create (onError + serverError render, CR-01 part 3 / WR-07)
  - Paginated segments list with Назад/Вперёд controls (WR-05)
  - Not-found card on a bad/deleted segment id instead of an infinite skeleton (WR-06)
affects: [03-08 (behavior E2E covering tags + CR-01 regressions), phase-04-campaigns (segment picker relies on the same list/detail pages)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Shared save-time validator module (validateDefinition.ts) imported by sibling pages instead of duplicated per-page copies (IN-04)"
    - "isError checked before the isLoading/!data skeleton branch on detail pages so a 404/error surfaces a not-found card instead of hanging"

key-files:
  created:
    - apps/web/src/features/segments/validateDefinition.ts
  modified:
    - apps/web/src/features/segments/SegmentBuilder.tsx
    - apps/web/src/features/segments/SegmentCreatePage.tsx
    - apps/web/src/features/segments/SegmentDetailPage.tsx
    - apps/web/src/features/segments/SegmentsListPage.tsx

key-decisions:
  - "validateDefinition.ts hardcodes its own HIDDEN_VALUE_OPERATORS set (is_empty/is_not_empty/is_true/is_false) mirroring SegmentBuilder's rather than importing it, since SegmentBuilder does not export it and the 4-operator list is stable/small"
  - "SegmentDetailPage's header now reads local `name` state instead of `segmentQuery.data.name` -- avoids a TS possibly-undefined narrowing gap once isError is checked via a combined OR condition, and `name` is already populated from the same query's onSuccess-equivalent effect by the time this render path is reached"
  - "git add -p grouped all three SegmentDetailPage.tsx hunks (import removal + WR-06 reorder) into the Task 1 commit rather than splitting cleanly across Task 1/Task 2 boundaries -- a commit-granularity artifact, not a functional deviation (see Deviations)"

patterns-established:
  - "Save-time validators live in a page-agnostic module, not duplicated inline per page"

requirements-completed: [SEGM-01]

coverage:
  - id: D1
    description: "Tags condition reachable in the builder — «Теги» field, «есть тег»/«нет тега» operators, tag-name text input"
    requirement: SEGM-01
    verification:
      - kind: other
        ref: "npm run build -w apps/web (tsc --noEmit + vite build) — clean"
        status: pass
    human_judgment: true
    rationale: "End-to-end proof (selecting the field, saving, and the compiled query matching has_tag/not_has_tag) is covered by 03-08's E2E; this plan only proves the UI compiles and the operator/label wiring is present, not a live browser interaction."
  - id: D2
    description: "Saving the untouched default empty condition shows an inline validation error instead of silently doing nothing"
    requirement: SEGM-01
    verification:
      - kind: other
        ref: "npm run build -w apps/web — clean; validateDefinition.ts reviewed against acceptance criteria (non-null message for field:\"\" and for a value-requiring operator with an empty value)"
        status: pass
    human_judgment: true
    rationale: "03-08's CR-01 regression E2E is the authoritative behavioral proof; this plan's own verification is build-clean + code review, not an executed browser test."
  - id: D3
    description: "A failed create mutation surfaces a visible GENERIC_ERROR message via onError, matching SegmentDetailPage's serverError pattern"
    requirement: SEGM-01
    verification:
      - kind: other
        ref: "npm run build -w apps/web — clean; code review confirms onError/serverError symmetry with SegmentDetailPage"
        status: pass
    human_judgment: true
    rationale: "No unit/integration test exercises the mutation's onError branch directly; 03-08 covers this end-to-end."
  - id: D4
    description: "Segments list has working Назад/Вперёд pagination so the 21st+ segment is reachable"
    requirement: SEGM-01
    verification:
      - kind: other
        ref: "npm run build -w apps/web — clean; code review confirms page state threads into query params + queryKey and totalPages is derived from response total"
        status: pass
    human_judgment: true
    rationale: "Requires seeding >20 segments and clicking through pages to prove live; no automated test seeds that volume in this plan."
  - id: D5
    description: "Opening a deleted/bad segment id shows a «Сегмент не найден» card instead of an infinite skeleton"
    requirement: SEGM-01
    verification:
      - kind: other
        ref: "npm run build -w apps/web — clean; code review confirms isError is checked before the isLoading/!definition skeleton branch"
        status: pass
    human_judgment: true
    rationale: "Requires a live 404 response from the API against a real bad id; 03-08's E2E is the authoritative proof."

duration: 15min
completed: 2026-07-06
status: complete
---

# Phase 03 Plan 07: Tags-Reachable Builder + CR-01 Fail-Loud Create + List Pagination + Detail Not-Found Summary

**Extracted a shared save-time validator (validateDefinition.ts) used by both segment pages, made the engine-supported tags condition user-reachable in the builder, wired a visible error into the create flow's mutation, added Назад/Вперёд pagination to the segments list, and reordered SegmentDetailPage's early returns so an errored query shows a not-found card instead of an infinite skeleton.**

## Performance

- **Duration:** 15 min
- **Started:** 2026-07-06T04:47:00Z
- **Completed:** 2026-07-06T04:51:52Z
- **Tasks:** 2
- **Files modified:** 5 (1 created, 4 modified)

## Accomplishments
- Tags condition is now selectable in the builder («Теги» field → «есть тег»/«нет тега» operators → tag-name text input), closing the D-03/D-04 gap where the engine and Zod schema already supported it but the UI's STANDARD_FIELDS omitted it.
- validateDefinition is now a single shared module (validateDefinition.ts) imported by both SegmentCreatePage and SegmentDetailPage, extended to catch an unselected attribute field and a missing value on a value-requiring operator (CR-01) -- the two local copies that could previously drift are gone.
- SegmentCreatePage's create mutation now has an onError handler rendering the same GENERIC_ERROR copy SegmentDetailPage already used, so a failed create is no longer silent.
- SegmentsListPage now tracks page state threaded into both the query params and queryKey, with Назад/Вперёд controls and a «Стр. {page} из {totalPages}» label, reusing the exact pattern already established in SegmentDetailPage's SegmentMembersTable.
- SegmentDetailPage checks `segmentQuery.isError` before its loading/skeleton branch, so a deleted or bad segment id now renders the «Сегмент не найден» card instead of hanging on skeletons forever.

## Task Commits

Each task was committed atomically:

1. **Task 1: Tags condition reachable in the builder + CR-01 client validation & error feedback** - `ab52738` (feat)
2. **Task 2: List pagination controls (WR-05) + detail not-found on error (WR-06)** - `06ca2d6` (feat)

**Plan metadata:** (pending — this commit)

_Note: SegmentDetailPage.tsx's WR-06 reorder hunk landed inside the Task 1 commit rather than Task 2's — see Deviations._

## Files Created/Modified
- `apps/web/src/features/segments/validateDefinition.ts` - New shared save-time validator (`validateDefinition` + `GENERIC_ERROR`), extended with attribute-field-emptiness and missing-value checks (CR-01)
- `apps/web/src/features/segments/SegmentBuilder.tsx` - `FieldKind` gains `"tags"`; `STANDARD_FIELDS` gains a `tags` entry («Теги»); `OPERATORS_BY_KIND` gains a `tags` group (`has_tag`→«есть тег», `not_has_tag`→«нет тега»)
- `apps/web/src/features/segments/SegmentCreatePage.tsx` - Imports the shared validator; drops its local copy; adds `serverError` state + `onError` on the create mutation, rendered near the save button
- `apps/web/src/features/segments/SegmentDetailPage.tsx` - Imports the shared validator + `GENERIC_ERROR`; drops its local copies; reorders early returns so `segmentQuery.isError` short-circuits to the not-found card before the skeleton branch; header now reads local `name` state instead of `segmentQuery.data.name`
- `apps/web/src/features/segments/SegmentsListPage.tsx` - Adds `page` state used in the query params and queryKey; adds a Назад/Вперёд pagination footer with a page-count label derived from `total`

## Decisions Made
- validateDefinition.ts defines its own small HIDDEN_VALUE_OPERATORS set rather than importing SegmentBuilder's (not exported); both lists are the same 4 operators and unlikely to diverge given they mirror the fixed 16-operator ConditionOperator enum in shared-schemas.
- SegmentDetailPage's header text now reads from the `name` state (already populated from the query data) instead of `segmentQuery.data.name` directly, resolving a TypeScript possibly-undefined narrowing gap introduced by combining `isError` into a single early-return condition.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] TS narrowing gap after combining isError into the not-found branch**
- **Found during:** Task 2 (`npm run build -w apps/web` verification step)
- **Issue:** `if (segmentQuery.isError || (!segmentQuery.isLoading && !segmentQuery.data))` doesn't let TypeScript narrow `segmentQuery.data` to defined in the subsequent render path (TanStack Query's `isError`/`data` fields aren't mutually discriminated at the type level), so `segmentQuery.data.name` in the header failed `tsc --noEmit` with TS18048.
- **Fix:** Read the header title from the existing local `name` state (already synced from `segmentQuery.data` via the page's `useEffect`) instead of `segmentQuery.data.name`.
- **Files modified:** apps/web/src/features/segments/SegmentDetailPage.tsx
- **Verification:** `npm run build -w apps/web` (tsc --noEmit + vite build) passes clean.
- **Committed in:** ab52738 (part of the Task 1 commit, since `git add -p` grouped this hunk with the shared-validator import removal — see note below)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Necessary to keep the build clean after the WR-06 reorder; no scope creep, no behavior change beyond what the fix required.

**Commit-granularity note (not a deviation rule, documented for traceability):** The plan's Task 2 file list includes `SegmentDetailPage.tsx` for the WR-06 fix. When staging via `git add -p`, git grouped the shared-validator-import-removal hunk and the WR-06 reorder + name-state hunks into a single contiguous diff region in the same file, and the interactive hunk splitter placed all of it in the Task 1 commit (`ab52738`) rather than splitting across Task 1/Task 2 commits as the plan's per-task file lists implied. Both tasks' actual code changes are present and correct on disk and in git history — this only affects which commit hash a given hunk lives under, not correctness or completeness.

## Issues Encountered
None beyond the TS narrowing fix documented above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- The web half of the failed truth "a user can build and save a segment from profile attributes (country, tags, custom properties)" is closed: combined with 03-05 (schema) and 03-06 (route/compiler timeout handling), every field the contract supports is now buildable in the UI, and the create/detail flows fail loudly instead of silently.
- 03-08 (gap-closure E2E) is the next plan; it proves this plan's UI changes end-to-end (tags round-trip, CR-01 regression, pagination, not-found) against a live server, which this plan's own verification (build-clean only) does not exercise.
- No blockers for 03-08.

---
*Phase: 03-segmentation-engine*
*Completed: 2026-07-06*

## Self-Check: PASSED

All 5 modified/created files and both task commits (ab52738, 06ca2d6) verified present.
