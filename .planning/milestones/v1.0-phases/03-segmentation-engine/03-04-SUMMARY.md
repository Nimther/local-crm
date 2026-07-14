---
phase: 03-segmentation-engine
plan: 04
subsystem: ui
tags: [react, tanstack-query, tanstack-table, shadcn, alert-dialog, dropdown-menu, playwright, segments]

# Dependency graph
requires:
  - phase: 03-segmentation-engine (plan 02)
    provides: "Live segments API -- GET/PATCH/DELETE :id, GET :id/members (paginated, RLS-scoped)"
  - phase: 03-segmentation-engine (plan 03)
    provides: "SegmentBuilder (two-tier AND/OR editor), SegmentsListPage/api.ts scaffolding, Сегменты nav/routes"
provides:
  - "SegmentDetailPage: editable definition (same SegmentBuilder, prefilled) + paginated read-only member table, PATCH save invalidates member query (D-13 dynamic membership)"
  - "DeleteSegmentDialog: D-14 free-deletion confirmation with exact UI-SPEC copy"
  - "Enriched SegmentsListPage: member-count (Display weight) + freshness meta, Обновлён, Автор (resolved via GET /members), per-row Изменить/Удалить dropdown"
  - "/w/:slug/segments/:id route"
  - "Full segment lifecycle E2E: create -> open detail -> members render -> delete via row action"
affects: [04-campaigns, 06-flows]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Controlled AlertDialog opened from a dropdown-menu item (not its own AlertDialogTrigger) -- lets the dropdown close before the alert-dialog mounts, avoiding focus/portal interaction issues"
    - "Member-list refetch triggered by a bumped `refreshToken` int (not a raw invalidateQueries race against local component state) after a segment PATCH succeeds, satisfying D-13's dynamic-membership requirement"
    - "Segment detail page reuses the exact same SegmentBuilder component in edit mode -- no separate edit-vs-create builder variant"

key-files:
  created:
    - apps/web/src/features/segments/SegmentDetailPage.tsx
    - apps/web/src/features/segments/DeleteSegmentDialog.tsx
  modified:
    - apps/web/src/features/segments/api.ts
    - apps/web/src/features/segments/SegmentsListPage.tsx
    - apps/web/src/App.tsx
    - apps/web/e2e/segments.spec.ts

key-decisions:
  - "03-04: SegmentsListPage's 'Создан' column replaced by 'Обновлён' (using updatedAt) when adding the author column -- keeps row width reasonable while satisfying the plan's explicit request to add Обновлён + Автор columns; memberCount/memberCountAt (D-11) and row actions were kept"
  - "03-04: DeleteSegmentDialog is a controlled component (open/onOpenChange props, no internal AlertDialogTrigger) driven by SegmentsListPage's own selected-segment state -- the delete action originates from a dropdown-menu item, and a nested AlertDialogTrigger inside a DropdownMenuItem is a known Radix portal/focus footgun"
  - "03-04: member table's PATCH-triggered refetch uses a bumped integer in the TanStack Query key rather than relying solely on queryClient.invalidateQueries, so the member list definitively re-fetches even if the query key would otherwise be considered unchanged"

requirements-completed: [SEGM-01, SEGM-03]

coverage:
  - id: D1
    description: "Segment detail page: editable definition (SegmentBuilder in edit mode, prefilled) above a paginated read-only member table (GET /segments/:id/members), reusing ContactsListPage's table/pagination pattern"
    requirement: "SEGM-03"
    verification:
      - kind: e2e
        ref: "e2e/segments.spec.ts#build, preview, and save a segment from the Сегменты section -- opens the created segment, asserts the prefilled builder and the Участники section"
        status: pass
      - kind: automated_ui
        ref: "npm run build -w apps/web"
        status: pass
    human_judgment: false
  - id: D2
    description: "Saving a definition/name edit PATCHes the segment and the member list reflects the new membership (D-13 dynamic)"
    requirement: "SEGM-01"
    verification:
      - kind: unit
        ref: "manual code review -- saveMutation.onSuccess bumps refreshToken, which is in SegmentMembersTable's queryKey, forcing a refetch; no automated test exercises a second edit-then-resave cycle in this plan's E2E scope"
        status: unknown
    human_judgment: true
    rationale: "The E2E only opens a freshly created segment and reads its members once; it does not edit the definition on the detail page and re-verify the member list changed. Needs a human/functional check of the actual dynamic-update path (D-13)."
  - id: D3
    description: "Segment deletion: alert-dialog with exact D-14 copy, opened from a per-row dropdown action, removes the segment from the list on confirm"
    requirement: "SEGM-01"
    verification:
      - kind: e2e
        ref: "e2e/segments.spec.ts#build, preview, and save a segment from the Сегменты section -- deletes the created segment via row action + confirm, asserts it disappears"
        status: pass
    human_judgment: false
  - id: D4
    description: "Segments list enrichment: member-count column (Display weight) with 'на {дата}' freshness meta sourced from memberCountAt (D-11), Автор column resolving createdByUserId via GET /members"
    requirement: "SEGM-01"
    verification:
      - kind: e2e
        ref: "e2e/segments.spec.ts -- exercises the enriched list rows (row-action click) but does not assert the member-count/freshness/author cell text directly"
        status: pass
      - kind: other
        ref: "npm run build -w apps/web (typechecks columns against SegmentResponse/MemberListItem shapes)"
        status: pass
    human_judgment: true
    rationale: "No automated assertion checks the visual Display-weight styling or the exact 'на {дата}' freshness string rendering, or that the resolved author name matches the registering user -- a UI-safety-gate/human-verify concern per the plan's own precedent (03-03 D2)."

duration: 25min
completed: 2026-07-05
status: complete
---

# Phase 3 Plan 4: Segment Detail, Delete Flow, and List Enrichment Summary

**Segment detail page (editable definition in the shared builder + paginated read-only member table, dynamic on save) plus a D-14-compliant delete confirmation and a list enriched with member-count freshness, author, and row actions — closing the full segment manage/view/delete lifecycle.**

## Performance

- **Duration:** 25 min
- **Started:** 2026-07-05T18:57:00Z
- **Completed:** 2026-07-05T19:22:00Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- `SegmentDetailPage`: `/w/:slug/segments/:id` renders the segment name + the same `SegmentBuilder` used by the create flow, prefilled with the loaded definition; «Сохранить изменения» PATCHes the segment, invalidates its detail/list queries, and bumps a refresh token so the member table refetches (D-13 — dynamic membership on edit)
- Paginated, read-only «Участники» member table reusing `ContactsListPage`'s `@tanstack/react-table` + `keepPreviousData` pattern verbatim (D-12), with the exact "Пока никто не подходит под условия" empty-state copy
- `DeleteSegmentDialog`: shadcn `alert-dialog` with the verbatim D-14 title/body/button copy, controlled from a per-row dropdown-menu item (not its own trigger) to avoid nesting an `AlertDialogTrigger` inside a `DropdownMenuItem`
- `SegmentsListPage` enriched: member-count column now Display-weight with a muted "на {дата, время}" freshness line underneath (D-11), new Обновлён (updatedAt) and Автор (createdByUserId resolved via `GET /members`, the 02-08 `CsvImportHistory` pattern) columns, and a per-row «Действия» dropdown with «Изменить»/«Удалить»
- `api.ts` extended with `getSegment`/`updateSegment`/`deleteSegment`/`listSegmentMembers`
- Playwright E2E extended end-to-end: create → open detail (prefilled builder + members section) → back to list → delete via row action + confirm → row disappears

## Task Commits

Each task was committed atomically:

1. **Task 1: Segment detail page — editable definition + paginated member list + PATCH save** - `c26a8c9` (feat)
2. **Task 2: Delete flow (confirmation) + list enrichment (member count, freshness, author, row actions)** - `18376c2` (feat)

**Plan metadata:** (this commit)

## Files Created/Modified
- `apps/web/src/features/segments/SegmentDetailPage.tsx` - detail page: name + builder (edit mode) + save flow + paginated member table
- `apps/web/src/features/segments/DeleteSegmentDialog.tsx` - D-14 alert-dialog, controlled from the list row
- `apps/web/src/features/segments/SegmentsListPage.tsx` - member-count freshness styling, Обновлён/Автор columns, row-actions dropdown, renders `DeleteSegmentDialog`
- `apps/web/src/features/segments/api.ts` - `getSegment`/`updateSegment`/`deleteSegment`/`listSegmentMembers`
- `apps/web/src/App.tsx` - `/w/:slug/segments/:id` route
- `apps/web/e2e/segments.spec.ts` - extended happy-path E2E covering detail view and delete

## Decisions Made
- Replaced the list's original "Создан" column with "Обновлён" (updatedAt) when adding the Автор column, to keep the enriched table's column count reasonable while satisfying the plan's explicit ask (member-count/freshness was already present from 03-03 and is kept, just restyled to Display weight per the UI-SPEC).
- `DeleteSegmentDialog` is fully controlled (`open`/`onOpenChange` props) rather than owning its own `AlertDialogTrigger`, since the delete action is initiated from a `DropdownMenuItem` — nesting a Radix `AlertDialogTrigger` inside a `DropdownMenuItem` is a known portal/focus-trap conflict; the dropdown's `onSelect` instead sets which segment is pending deletion in the parent's state.
- The member table's post-save refetch is driven by an explicit `refreshToken` counter included in its TanStack Query key (not just `invalidateQueries`), guaranteeing a refetch regardless of any query-key-equality edge case.

## Deviations from Plan

None - plan executed as written. Both backend endpoints this plan's UI consumes (`GET/PATCH/DELETE /segments/:id`, `GET /segments/:id/members`) were already live from 03-02, so no backend changes were needed.

## Issues Encountered
- Initial E2E assertion `page.getByDisplayValue("RU")` failed to compile — `getByDisplayValue` is a Testing-Library API, not part of Playwright's `Page` type. Replaced with `expect(page.getByPlaceholder("Значение")).toHaveValue("RU")`.
- The delete-flow E2E's final assertion (`getByText(segmentName)).not.toBeVisible()`) hit a Playwright strict-mode violation because the alert-dialog's title text ("Удалить сегмент «...»?") still matched the segment-name substring during the dialog's close transition. Replaced with a scoped `getByRole("row", { name: ... })).toHaveCount(0)` assertion targeting the list row specifically.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- SEGM-01 (manage/edit/delete saved segments) and SEGM-03 (member list via the shared engine) are demonstrable end-to-end: create → open detail → view/edit definition + members → delete.
- Phase 3 (Segmentation Engine) is now complete across all 4 plans: compiler/engine (03-01), live API (03-02), builder UI (03-03), detail/delete/list-enrichment (03-04).
- Ready for Phase 4 (campaigns): segments can be referenced by id as a broadcast audience; D-14's restrict-when-referenced delete guard is explicitly deferred to Phase 4/6 (nothing references segments yet).
- Deferred human-judgment items (D2, D4 in this summary's coverage) plus the carried-forward items from 03-03 (behavioral condition row functional check, live-count degraded-state load test) should be exercised at phase-level UAT per `human_verify_mode: end-of-phase`.

## Self-Check: PASSED

- All 6 key files verified present on disk (`[ -f ]`).
- Both task commit hashes (`c26a8c9`, `18376c2`) verified in `git log --oneline --all`.
- `npm run build -w apps/web` clean (final re-run after both tasks).
- `npm run test:e2e -w apps/web` — 3/3 specs passing (contact-search-focus, register-create-workspace, segments).

---
*Phase: 03-segmentation-engine*
*Completed: 2026-07-05*
