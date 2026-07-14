---
phase: 06-flows-triggered-chains
plan: 11
subsystem: web
tags: [react, tanstack-query, flows, shadcn, timezone, quiet-hours, publish-dialog, eject]

# Dependency graph
requires:
  - phase: 06-flows-triggered-chains (06-04)
    provides: flow lifecycle API (CRUD, publish 422 {fields}, pause/resume/duplicate), toFlowResponse shape
  - phase: 06-flows-triggered-chains (06-07)
    provides: workspace default timezone + quiet-hours send-settings API, contact timezone write-validation (invalid_timezone 400)
  - phase: 06-flows-triggered-chains (06-08)
    provides: GET /flows/:id/enroll-preview + publish enrollExisting flag (D-04)
  - phase: 06-flows-triggered-chains (06-09)
    provides: GET /flows/:id/runs (counts + list), POST runs/eject, DELETE /flows/:id (D-21/D-22)
  - phase: 06-flows-triggered-chains (06-10)
    provides: FlowCanvas + flows/api.ts client base, shadcn switch primitive
provides:
  - "FlowsListPage: status badges (Черновик/Live/Приостановлена), create dialog, row Открыть/Дублировать/Удалить gated by isDeletableFlowStatus (D-22)"
  - "FlowDetailPage: canvas embed (Холст/Настройки/Контакты tabs), lifecycle buttons with Member disabled+tooltip, run-counter caption «{N} контактов в цепочке ({M} на старых версиях)»"
  - "PublishEnrollDialog: D-04 three-choice segment variant (~N count) + simple event confirm + server-authoritative 422 blocker list with select-offending-node"
  - "FlowLifecycleSettings (re-entry radio-group + exit-conditions builder) + QuietHoursCard (per-flow override, workspace-default preview)"
  - "FlowRunsTable: per-row + bulk eject with D-21 confirms, on-old-version flag"
  - "TimezoneCombobox (Intl.supportedValuesOf, never free text) wired into ContactForm, CSV mapping, and SendSettingsPage (default timezone + quiet hours)"
  - "«Цепочки» sidebar nav + /w/:slug/flows and /w/:slug/flows/:id routes"
affects: [phase-07-analytics]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Server-authoritative publish blockers: PublishEnrollDialog parses the 422 {fields} shape shapeFlowValidationFields produces and renders each entry as a button calling onSelectNode -- the client's own validateFlowDefinition output is UI feedback only, never the publish authority (Pitfall 3)"
    - "focusNodeId prop threading: FlowDetailPage owns tab + focus state; FlowCanvas accepts an optional focusNodeId that selects + fitView-pans the node (no-op for the flow-scoped 'trigger' key which has no node id)"
    - "Counts-only run query: FlowDetailPage's header fetches useFlowRuns with pageSize 1 purely for the counts aggregate; FlowRunsTable independently paginates the real list"

key-files:
  created:
    - apps/web/src/features/flows/FlowStatusBadge.tsx
    - apps/web/src/features/flows/list/FlowsListPage.tsx
    - apps/web/src/features/flows/detail/FlowDetailPage.tsx
    - apps/web/src/features/flows/detail/PublishEnrollDialog.tsx
    - apps/web/src/features/flows/detail/FlowLifecycleSettings.tsx
    - apps/web/src/features/flows/detail/FlowRunsTable.tsx
    - apps/web/src/features/flows/detail/QuietHoursCard.tsx
    - apps/web/src/features/contacts/TimezoneCombobox.tsx
  modified:
    - apps/web/src/features/flows/api.ts
    - apps/web/src/features/flows/canvas/FlowCanvas.tsx
    - apps/web/src/features/contacts/ContactForm.tsx
    - apps/web/src/features/contacts/CsvImportWizard.tsx
    - apps/web/src/features/campaigns/SendSettingsPage.tsx
    - apps/web/src/App.tsx
    - apps/web/src/features/app-shell/AppShell.tsx

key-decisions:
  - "isDeletableFlowStatus offers delete for never-published drafts OR any paused flow -- the paused-with-zero-active half of D-22 is re-verified server-side (deleteFlow 409), and the delete confirm surfaces the server's message verbatim rather than pre-computing run counts client-side"
  - "FlowDetailPage uses three tabs (Холст/Настройки/Контакты в цепочке) under one lifecycle header instead of CampaignDetailPage's status-branched views -- a flow's draft stays editable in every status (D-20), so the canvas must remain reachable for live/paused flows too"
  - "FlowCanvas's outer wrapper switched h-screen -> h-full so it fits the detail page's tab layout; gained optional focusNodeId prop (select + fitView) for the blocker-list node jump"
  - "Sidebar nav item + AppShell live in features/app-shell/AppShell.tsx -- no separate app-shell/Sidebar.tsx exists (plan path corrected, mirrors 06-04's server.ts-not-app.ts precedent)"
  - "ContactForm sends timezone as explicit null in edit mode when cleared (CR-04 convention), omits it in create mode when unset"

patterns-established:
  - "TimezoneCombobox is the single timezone input primitive (contact form, send settings) -- options always from Intl.supportedValuesOf('timeZone') with an empty-list fallback, never a hardcoded zone list, never free text"

requirements-completed: [FLOW-01, FLOW-04, FLOW-05, FLOW-06]

coverage:
  - id: D1
    description: "Flows list: status badge, create, open canvas, duplicate, delete only when deletable (D-22)"
    requirement: "FLOW-01"
    verification:
      - kind: build
        ref: "npm run build -w apps/web clean; FlowsListPage wired at /w/:slug/flows with isDeletableFlowStatus gating the delete row action"
        status: pass
      - kind: human
        ref: "Checkpoint Task 4 approved: list navigable, badges correct, lifecycle verified in the running app"
        status: pass
    human_judgment: true
  - id: D2
    description: "Detail page: canvas + lifecycle (Опубликовать/Приостановить/Возобновить) + re-entry/quiet-hours/exit-conditions + run counter with per-row eject"
    requirement: "FLOW-04"
    verification:
      - kind: build
        ref: "grep 'на старых версиях' FlowDetailPage.tsx passes; FlowRunsTable renders eject confirms with D-21 copy"
        status: pass
      - kind: human
        ref: "Checkpoint Task 4 approved: pause stops mid-flight runs, resume runs overdue steps, eject removes the contact"
        status: pass
    human_judgment: true
  - id: D3
    description: "Publish shows the D-04 enroll dialog (segment) or simple confirm (event); server 422 blocker list renders and selects the offending node"
    requirement: "FLOW-06"
    verification:
      - kind: build
        ref: "grep 'Зачислить и опубликовать' PublishEnrollDialog.tsx passes; parseBlockerFields consumes the exact shapeFlowValidationFields 422 shape"
        status: pass
      - kind: human
        ref: "Checkpoint Task 4 approved: event confirm + segment three-choice with ~N count both verified live"
        status: pass
    human_judgment: true
  - id: D4
    description: "Workspace send settings expose default timezone + quiet hours; contact form + CSV mapping expose a constrained IANA timezone combobox"
    requirement: "FLOW-05"
    verification:
      - kind: build
        ref: "grep 'supportedValuesOf' TimezoneCombobox.tsx passes; SendSettingsPage persists defaultTimezone/quietHours* via the 06-07 PUT route"
        status: pass
      - kind: human
        ref: "Checkpoint Task 4 approved: quiet-hours deferral observed live (send deferred inside window, delivered after)"
        status: pass
    human_judgment: true

duration: 20min
completed: 2026-07-10
status: complete
---

# Phase 6 Plan 11: Flow Feature UI (list, detail, dialogs, timezone/quiet-hours settings) Summary

**The complete user-facing flow surface: list + detail pages embedding the 06-10 canvas with lifecycle actions and the «{N} контактов в цепочке ({M} на старых версиях)» run counter, the D-04 publish/enroll dialogs with server-authoritative 422 blocker rendering, re-entry/quiet-hours/exit-condition settings cards, per-row/bulk eject, and the constrained IANA timezone combobox wired into contact form, CSV mapping, and workspace send settings — closing FLOW-01/04/05/06's UI and verified end-to-end by the human checkpoint.**

## Performance

- **Duration:** ~20 min implementation (plus the blocking human-verify checkpoint)
- **Started:** 2026-07-10T06:40:00Z (approx)
- **Completed:** 2026-07-10T07:05:00Z (checkpoint approved)
- **Tasks:** 3 auto + 1 human-verify checkpoint (approved)
- **Files modified:** 15 (8 created, 7 modified)

## Accomplishments

- **flows/api.ts extended:** `useFlowRuns` (keepPreviousData, counts + paginated list), `useEjectRuns` (invalidates all run pages), `useEnrollPreview` (caller-gated `enabled`), `useDeleteFlow`; `publishFlow`/`usePublishFlow` widened to carry the D-04 `enrollExisting` flag; hand-mirrored `FlowRunSummaryResponse`/`FlowRunListResponse` from `toFlowRunSummaryResponse`.
- **FlowsListPage:** CampaignsListPage-mirrored table (status badge via new `FlowStatusBadge`, trigger summary with segment-name lookup, «Обновлена»), «Создать цепочку» name-first create dialog (createFlowSchema requires a name) navigating straight to the new canvas, row dropdown Открыть/Дублировать/Удалить with `isDeletableFlowStatus` (D-22) gating, UI-SPEC empty state and delete-confirm copy, toasts «Цепочка создана/продублирована/удалена».
- **FlowDetailPage:** one lifecycle header (name + badge + run-counter caption, parenthetical only when M>0) over three tabs — Холст (embedded FlowCanvas), Настройки (`FlowLifecycleSettings` + `QuietHoursCard`), Контакты в цепочке (`FlowRunsTable`). Lifecycle buttons switch by status (Опубликовать/Приостановить/Возобновить) and render disabled + «Только Owner или Admin может публиковать цепочки.» tooltip for Member (T-06-11-01 client half; server routes re-check). Non-destructive pause confirm and destructive delete confirm per UI-SPEC.
- **PublishEnrollDialog:** segment-triggered variant fetches the enroll-preview «~{N} контактов» count and offers «Зачислить и опубликовать» (primary) / «Опубликовать только для новых» (secondary) / «Отмена» mapping to `enrollExisting: true/false` (D-04); event-triggered variant is the simple confirm. A 422 publish rejection renders the SERVER's `{fields}` blocker list (exact `shapeFlowValidationFields` shape) as clickable items that close the dialog, switch to the canvas tab, and select + pan/zoom the offending node via FlowCanvas's new `focusNodeId` prop — client validity is never sent as authority (Pitfall 3, T-06-11-02).
- **FlowLifecycleSettings + QuietHoursCard:** re-entry radio-group («Только один раз» / «Не чаще, чем раз в N дней» with inline N input / «Каждый раз») and the exit-conditions list («Добавить условие выхода», segment in/not_in or event kinds) both persisting via `useUpdateFlowDraft`; quiet-hours card with «Использовать своё окно для этой цепочки» switch (off = muted workspace-default preview from the send-settings API), custom from/to time inputs, and the «Отключить тихие часы для этой цепочки» explicit-disable switch (D-09 three modes).
- **FlowRunsTable:** paginated runs with contact display name, status labels, «на старой версии» badge (FLOW-07 visibility), per-row «Удалить из цепочки» + checkbox bulk eject (active runs only), single/bulk AlertDialog confirms with the exact D-21 UI-SPEC copy, and the runs empty state.
- **Timezone surface (Task 3):** `TimezoneCombobox` — searchable command+popover populated from `Intl.supportedValuesOf('timeZone')` with a Очистить action, never free text (T-06-11-03). Wired as «Часовой пояс» in ContactForm (null-clears in edit mode per CR-04), added to CSV mapping's standard-field options (+ timezone/time_zone/tz header guesses), and into SendSettingsPage alongside the new «Тихие часы» enable toggle + from/to time inputs — all saved by the existing «Сохранить настройки» button against the 06-07 PUT route, with the UI-SPEC invalid-timezone inline error surfaced on `code: invalid_timezone` (defense-in-depth).
- **Nav/routes:** «Цепочки» NavLink in the sidebar (active-accent) + `/w/:slug/flows` and `/w/:slug/flows/:id` routes in App.tsx.
- **Human checkpoint (Task 4) approved:** the user verified the full lifecycle in the running app — canvas build with autosave, event-trigger publish (badge → Live), segment-trigger D-04 dialog with ~N count, live event → email delivery with run counter, quiet-hours deferral then post-window delivery, pause/resume semantics, eject, and Member role gating.

## Task Commits

Each task was committed atomically:

1. **Task 1: Flows list page + run-eject/delete/enroll-preview API hooks** - `6066aec` (feat)
2. **Task 2: Publish/enroll dialog + re-entry/quiet-hours settings + nav/routes** - `b613996` (feat)
3. **Task 3: Timezone combobox + workspace/contact timezone + quiet hours UI** - `0d9d29d` (feat)
4. **Task 4: Human verification checkpoint** - approved by user, no commit (verification only)

## Files Created/Modified

- `apps/web/src/features/flows/FlowStatusBadge.tsx` - Черновик/Live/Приостановлена badge per UI-SPEC colors
- `apps/web/src/features/flows/list/FlowsListPage.tsx` - list, create dialog, row actions, isDeletableFlowStatus, delete confirm
- `apps/web/src/features/flows/detail/FlowDetailPage.tsx` - header (badge + run counter) + lifecycle buttons + tabs + pause/delete confirms
- `apps/web/src/features/flows/detail/PublishEnrollDialog.tsx` - D-04 three-choice + simple confirm + server 422 blocker list
- `apps/web/src/features/flows/detail/FlowLifecycleSettings.tsx` - re-entry radio-group + exit-conditions builder
- `apps/web/src/features/flows/detail/FlowRunsTable.tsx` - runs list, on-old-version flag, single/bulk eject
- `apps/web/src/features/flows/detail/QuietHoursCard.tsx` - per-flow quiet-hours override (D-09)
- `apps/web/src/features/contacts/TimezoneCombobox.tsx` - Intl.supportedValuesOf combobox
- `apps/web/src/features/flows/api.ts` - useFlowRuns/useEjectRuns/useEnrollPreview/useDeleteFlow + publish enrollExisting
- `apps/web/src/features/flows/canvas/FlowCanvas.tsx` - focusNodeId prop, h-screen → h-full
- `apps/web/src/features/contacts/ContactForm.tsx` - «Часовой пояс» field + invalid_timezone error copy
- `apps/web/src/features/contacts/CsvImportWizard.tsx` - timezone standard-field option + header guesses
- `apps/web/src/features/campaigns/SendSettingsPage.tsx` - default timezone + quiet-hours fields on the existing form
- `apps/web/src/App.tsx` - flows routes
- `apps/web/src/features/app-shell/AppShell.tsx` - «Цепочки» nav item

## Decisions Made

- `isDeletableFlowStatus` treats any paused flow as delete-offerable and lets the server's `deleteFlow` 409 (surfaced verbatim in a toast) enforce the zero-active-runs half of D-22 — pre-fetching run counts for every list row was rejected as wasteful.
- FlowDetailPage is tab-organized (Холст/Настройки/Контакты) rather than status-branched like CampaignDetailPage — flows keep an editable draft in every status (D-20), so the canvas must stay reachable for live/paused flows.
- FlowCanvas modified (in plan's files list): optional `focusNodeId` prop (select + `fitView` pan/zoom, safely no-ops for the flow-scoped "trigger" blocker key) and `h-screen` → `h-full` so it fits the tabbed layout.
- Plan's `apps/web/src/app-shell/Sidebar.tsx` path corrected to the real `apps/web/src/features/app-shell/AppShell.tsx` (no Sidebar.tsx exists) — same class of correction as 06-04's server.ts/app.ts.
- ContactForm's timezone follows the CR-04 clear convention: explicit `null` in edit mode when cleared, omitted in create mode when unset.
- Exit-condition rows use plain shadcn Selects (not the command+popover combobox) — a bounded two-kind picker inside an inline add-row; the searchable combobox is reserved for the large-option-set pickers (segments in the canvas panel, timezones).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Path correction] Plan's `apps/web/src/app-shell/Sidebar.tsx` does not exist**
- **Found during:** Task 1 (context gathering)
- **Issue:** The plan's files_modified and key_links referenced `apps/web/src/app-shell/Sidebar.tsx`; the sidebar actually lives inline in `apps/web/src/features/app-shell/AppShell.tsx`.
- **Fix:** «Цепочки» NavLink added to AppShell.tsx following the existing nav-item convention.
- **Files modified:** `apps/web/src/features/app-shell/AppShell.tsx`
- **Verification:** build clean; nav item renders with the active-accent pattern.
- **Committed in:** `b613996` (Task 2 commit)

**2. [Rule 2 - Missing critical] FlowCanvas needed a focusNodeId seam for the blocker-list node jump**
- **Found during:** Task 2
- **Issue:** The plan requires each 422 blocker item to "select the offending node", but FlowCanvas (06-10, not in this plan's files_modified) exposed no way for an external component to select/focus a node.
- **Fix:** Added an optional `focusNodeId` prop threaded to FlowCanvasInner — selects the node and `fitView`-pans it into view; also switched the outer wrapper `h-screen` → `h-full` so the canvas fits FlowDetailPage's tab layout instead of overflowing the viewport.
- **Files modified:** `apps/web/src/features/flows/canvas/FlowCanvas.tsx`
- **Verification:** build clean; checkpoint verification covered the canvas embed.
- **Committed in:** `b613996` (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (1 path correction, 1 missing-critical seam). No scope creep — both trace directly to the plan's own action text.

## Issues Encountered

None blocking. Build (`tsc --noEmit` + vite), the existing web test suite (18/18), and all three automated grep checks passed on the first full run after each task.

## User Setup Required

None — no external service configuration required beyond what previous plans already established (SendGrid key, Redis, Postgres all running).

## Next Phase Readiness

- The flow feature is user-complete: FLOW-01/02/03/04/05/06/07's full surface (backend 06-01…06-09, canvas 06-10, UI 06-11) is live and human-verified end to end.
- Phase 7 (analytics) can consume the same `useFlowRuns` counts shape and the flows routes for per-step metrics; `FlowStatusBadge` and the flows query-key factory are reusable.
- The 06-10 known stub «delay-node timezone caption is static copy» remains static — the workspace default zone is now settable via SendSettingsPage, so interpolating it into the canvas caption is a trivial polish item if Phase 7's UI pass wants it (non-blocking; the caption's wording is accurate either way).

---
*Phase: 06-flows-triggered-chains*
*Completed: 2026-07-10*

## Self-Check: PASSED

All 8 created files verified present on disk (FlowStatusBadge.tsx, FlowsListPage.tsx, FlowDetailPage.tsx, PublishEnrollDialog.tsx, FlowLifecycleSettings.tsx, FlowRunsTable.tsx, QuietHoursCard.tsx, TimezoneCombobox.tsx); all 3 task commit hashes (6066aec, b613996, 0d9d29d) verified present in git log.
