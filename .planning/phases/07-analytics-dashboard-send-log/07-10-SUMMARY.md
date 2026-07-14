---
phase: 07-analytics-dashboard-send-log
plan: 10
subsystem: ui
tags: [react, tanstack-query, send-log, combobox, gap-closure]

requires:
  - phase: 07-analytics-dashboard-send-log
    provides: send-log page with URL-param-driven filters (07-05), campaign/flow apiParams contract unchanged

provides:
  - Pure send-log-filters.ts helpers (applySendTargetToParams, resolveSendTargetLabel) with node-vitest coverage
  - CampaignFlowFilter.tsx: persistent searchable Popover+Command combobox listing workspace campaigns and flows
  - SendLogPage.tsx wiring: selector rendered unconditionally in the toolbar, writes ?campaign=/?flow= mutually exclusively, survives «Сбросить фильтры»

affects: [send-log, campaigns, flows]

tech-stack:
  added: []
  patterns:
    - "Pure filter-mutation helper module + node-vitest test precedent (campaign-metrics.ts style) reused for send-log's target filter logic"
    - "TimezoneCombobox Popover+Command searchable combobox structure reused for a second exhaustive-lookup selector (campaigns+flows) in the same interaction shape as segment/template pickers"

key-files:
  created:
    - apps/web/src/features/send-log/send-log-filters.ts
    - apps/web/src/features/send-log/__tests__/send-log-filters.test.ts
    - apps/web/src/features/send-log/CampaignFlowFilter.tsx
  modified:
    - apps/web/src/features/send-log/SendLogPage.tsx

key-decisions:
  - "applySendTargetToParams always resets page on any target change (campaign, flow, or null), matching every other filter mutator on the page (toggleStatus/setPeriod/clearParam)"
  - "resolveSendTargetLabel falls back to the raw id as the label when a deep-linked id is not found in the workspace's campaign/flow list, so a stale filter still renders something instead of silently disappearing"
  - "CampaignFlowFilter is purely additive: existing deep-link chips (lines 257-280), resetFilters, and CampaignMetricsSummary's deep link are untouched -- zero backend/apiParams changes, matching the plan's zero-backend-change scope"

patterns-established:
  - "Second exhaustive-lookup TanStack Query pair (listCampaigns + listFlows with EXHAUSTIVE_LOOKUP_PAGE_SIZE) co-located inside a single combobox component, following the SegmentDetailPage/FlowsListPage precedent but combining two entity types into one selector"

requirements-completed: [ANLT-05]

coverage:
  - id: D1
    description: "Pure applySendTargetToParams/resolveSendTargetLabel helpers enforce campaign⊕flow mutual exclusion, page reset, immutability, and campaign-priority label resolution with raw-id fallback"
    requirement: "ANLT-05"
    verification:
      - kind: unit
        ref: "apps/web/src/features/send-log/__tests__/send-log-filters.test.ts (9 tests)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Persistent «Кампания / цепочка» selector renders in the send-log toolbar at all times, lists workspace campaigns and flows, and writes ?campaign=/?flow= via the URL"
    requirement: "ANLT-05"
    verification:
      - kind: other
        ref: "cd apps/web && npm run build (tsc --noEmit + vite build) — passed"
    human_judgment: true
    rationale: "Visual/interactive combobox behavior (search filtering, selecting a campaign vs flow, active-target Check icon, Очистить action) and the end-to-end UAT re-test (open campaign detail -> journal link -> Сбросить фильтры -> re-select same campaign via the new selector -> log re-filters) require human verification in the browser; the build passing only proves it typechecks and bundles, not that the interaction works as intended."

duration: 8min
completed: 2026-07-14
status: complete
---

# Phase 07 Plan 10: Persistent send-log campaign/flow filter selector Summary

**Persistent «Кампания / цепочка» Popover+Command combobox added to the send-log toolbar, closing UAT Test 1 by letting a marketer re-apply a campaign or flow filter after «Сбросить фильтры» without navigating back to campaign/flow detail.**

## Performance

- **Duration:** 8 min
- **Started:** 2026-07-14T17:39:00Z
- **Completed:** 2026-07-14T17:41:34Z
- **Tasks:** 2 completed
- **Files modified:** 4 (3 created, 1 modified)

## Accomplishments

- Extracted pure `applySendTargetToParams`/`resolveSendTargetLabel` helpers governing the campaign⊕flow mutual-exclusion rule, covered by 9 node-vitest unit tests
- Added `CampaignFlowFilter.tsx`, a searchable combobox (TimezoneCombobox pattern) listing the workspace's campaigns and flows via existing `listCampaigns`/`listFlows` exhaustive lookups
- Wired the selector into `SendLogPage.tsx`'s toolbar, unconditionally rendered so it survives `resetFilters()` -- directly closing UAT Test 1
- Zero backend/API changes: the selector writes the exact `campaign`/`flow` URL params the backend already consumes as `campaignOrFlowId`

## Task Commits

Each task was committed atomically:

1. **Task 1: Pure send-log target-filter helper + node-vitest tests** - `b715c49` (test, RED) → `994564d` (feat, GREEN)
2. **Task 2: Persistent «Кампания / цепочка» selector wired into the send-log toolbar** - `d59905d` (feat)

**Plan metadata:** committed separately after this SUMMARY (docs: complete plan)

## Files Created/Modified

- `apps/web/src/features/send-log/send-log-filters.ts` - Pure `SendTarget` type + `applySendTargetToParams` + `resolveSendTargetLabel` helpers
- `apps/web/src/features/send-log/__tests__/send-log-filters.test.ts` - 9 unit tests covering mutual exclusion, page reset, immutability, label resolution, campaign-priority, and stale-id fallback
- `apps/web/src/features/send-log/CampaignFlowFilter.tsx` - Searchable Popover+Command combobox (new file), lists workspace campaigns and flows, calls `onSelect(SendTarget | null)`
- `apps/web/src/features/send-log/SendLogPage.tsx` - Added `setSendTarget` handler + rendered `<CampaignFlowFilter>` in the toolbar after existing chips, before the status Popover; updated the page's doc comment to reflect campaign/flow now being in-page editable

## Decisions Made

- `applySendTargetToParams` resets `page` unconditionally on every target change (campaign, flow, or clear-to-null), matching the existing `toggleStatus`/`setPeriod`/`clearParam` convention on this page.
- `resolveSendTargetLabel` falls back to the raw id string as the label when the id isn't found in the workspace's campaign/flow list -- a stale deep-link filter still renders something instead of crashing or showing nothing.
- The selector is additive only: existing deep-link chips (contact/campaign/flow Badges), `resetFilters()`, and `CampaignMetricsSummary`'s «Смотреть в журнале отправок» link are byte-identical to before this plan.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- UAT Test 1 (major severity) is closed: the send-log filter toolbar now exposes an always-available campaign/flow selector, independent of URL-param deep-links, satisfying the plan's `must_haves.truths`.
- Manual re-verification recommended per the plan's `<verification>` section: open a sent/canceled campaign → «Смотреть в журнале отправок» → «Сбросить фильтры» → re-select the same campaign via the new selector → confirm the log re-filters; then try a flow selection and «Очистить».
- No blockers for remaining phase-07 gap-closure or UAT re-test work.

---
*Phase: 07-analytics-dashboard-send-log*
*Completed: 2026-07-14*

## Self-Check: PASSED

All created files found on disk; all task/plan commits (b715c49, 994564d, d59905d, fffd7e4) found in git log.
