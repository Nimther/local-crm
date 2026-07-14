---
phase: 07-analytics-dashboard-send-log
plan: 08
subsystem: ui
tags: [react, vitest, tanstack-query, campaigns]

# Dependency graph
requires:
  - phase: 07-analytics-dashboard-send-log
    provides: "07-03's CampaignProgress D-01 rate percentages / D-07 excluded breakdown / D-04 send-log link, and the getCampaignProgress fetcher"
provides:
  - "bucketExcludedCounts extracted into apps/web/src/features/campaigns/campaign-metrics.ts, unit-tested"
  - "Shared CampaignMetricsSummary presentational component"
  - "Terminal (sent/canceled) campaign SummaryView enriched with D-01 rates, D-07 breakdown, D-04 send-log link"
affects: [analytics-dashboard-send-log verification, future campaign/flow metrics UI]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Shared presentational metrics component (CampaignMetricsSummary) consumed by both a polling live view and a static terminal view, fed from the same getCampaignProgress query shape"

key-files:
  created:
    - apps/web/src/features/campaigns/campaign-metrics.ts
    - apps/web/src/features/campaigns/CampaignMetricsSummary.tsx
    - apps/web/src/features/campaigns/__tests__/campaign-metrics.test.ts
  modified:
    - apps/web/src/features/campaigns/CampaignDetailPage.tsx
    - apps/web/src/features/campaigns/CampaignProgress.tsx

key-decisions:
  - "bucketExcludedCounts moved verbatim (byte-identical bucketing rule) into campaign-metrics.ts so both views can import it without duplicating the D-07 rule"
  - "SummaryView's progress query uses staleTime: Infinity (terminal campaign counts never change) and falls back to the campaign row's own counters while loading, rather than blocking on a Skeleton"
  - "CampaignMetricsSummary owns only the counter dl grid, excluded breakdown, and send-log link -- Progress bar/отправлено caption/ошибок line stay with each parent view"

patterns-established:
  - "Pattern 1: extract a shared presentational component when two views (live + terminal) need identical metric rendering fed by the same API shape, rather than duplicating JSX/logic"

requirements-completed: [ANLT-01]

coverage:
  - id: D1
    description: "bucketExcludedCounts extracted to campaign-metrics.ts and unit-tested (4 cases: empty, frequency_cap-only, all-fold-to-subscription, mixed)"
    requirement: ANLT-01
    verification:
      - kind: unit
        ref: "apps/web/src/features/campaigns/__tests__/campaign-metrics.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Terminal SummaryView renders CampaignMetricsSummary with D-01 rate percentages, D-07 Пропущено breakdown, and D-04 send-log link"
    requirement: ANLT-01
    verification:
      - kind: unit
        ref: "npm run build -w apps/web (tsc --noEmit + vite build), grep proofs per task acceptance criteria"
        status: pass
    human_judgment: true
    rationale: "Visual rendering of percentages/breakdown on a real sent/canceled campaign detail page requires a human to open the page and confirm layout/values, per 07-VERIFICATION.md human_verification[0] -- not automatable in the node-only web test lane"
  - id: D3
    description: "CampaignProgress (sending view) delegates its metrics block to the same CampaignMetricsSummary with zero duplicated bucketExcludedCounts/rate logic; sending-view output unchanged"
    requirement: ANLT-01
    verification:
      - kind: unit
        ref: "npm run test -w apps/web -- campaign-metrics rates; npm run build -w apps/web"
        status: pass
    human_judgment: false

duration: 20min
completed: 2026-07-14
status: complete
---

# Phase 07 Plan 08: Terminal campaign summary enrichment Summary

**Extracted a shared `CampaignMetricsSummary` component (+ unit-tested `bucketExcludedCounts` util) so a finished campaign's detail page now shows D-01 delivery/open/click/bounce rate percentages, the D-07 «Пропущено» excluded-reason breakdown, and the D-04 send-log deep link — closing the last verification gap in Phase 07.**

## Performance

- **Duration:** 20 min
- **Started:** 2026-07-14T11:32:00Z
- **Completed:** 2026-07-14T11:52:00Z
- **Tasks:** 3
- **Files modified:** 5 (3 created, 2 modified)

## Accomplishments
- `bucketExcludedCounts` moved out of `CampaignProgress.tsx` into a new, unit-tested `campaign-metrics.ts` module (RED→GREEN via vitest)
- New `CampaignMetricsSummary` component renders the 5-counter rate grid, excluded breakdown, and send-log link — reused verbatim by both the sending view and the terminal view
- `CampaignDetailPage`'s `SummaryView` (rendered for `sent`/`canceled` campaigns) now feeds `CampaignMetricsSummary` from a `staleTime: Infinity` `getCampaignProgress` query, with the `campaign` row's own counters as a non-blocking loading fallback
- `CampaignProgress.tsx` refactored to delegate to the same shared component — zero duplicated rate/excluded logic across the two views, sending-view output unchanged

## Task Commits

Each task was committed atomically:

1. **Task 1: Extract bucketExcludedCounts into a shared, unit-tested util (RED→GREEN)** - `2c767b5` (test, RED) → `1483d22` (feat, GREEN)
2. **Task 2: Shared CampaignMetricsSummary component, wired into the terminal SummaryView** - `90cc11d` (feat)
3. **Task 3: Refactor CampaignProgress to consume the shared component (DRY cleanup, no behavior change)** - `d9fe614` (refactor)

_TDD task (Task 1) has two commits: test → feat, per the RED/GREEN protocol._

## Files Created/Modified
- `apps/web/src/features/campaigns/campaign-metrics.ts` - New module exporting `bucketExcludedCounts`, moved verbatim from `CampaignProgress.tsx`
- `apps/web/src/features/campaigns/__tests__/campaign-metrics.test.ts` - Unit tests for the 4 bucketing behaviors (empty, frequency_cap-only, fold-to-subscription, mixed)
- `apps/web/src/features/campaigns/CampaignMetricsSummary.tsx` - Shared presentational component: rate-percentage `dl` grid, «Пропущено» breakdown, send-log `Link`
- `apps/web/src/features/campaigns/CampaignDetailPage.tsx` - `SummaryView` gained a `slug` prop and a terminal-status `getCampaignProgress` query; now renders `CampaignMetricsSummary` instead of the raw-count `dl` grid
- `apps/web/src/features/campaigns/CampaignProgress.tsx` - Replaced its inline `dl` grid, breakdown block, and `Link` with `<CampaignMetricsSummary />`; removed the local `bucketExcludedCounts`/`rateLabel`/`computeRate` derivations

## Decisions Made
- `bucketExcludedCounts` preserved byte-for-byte (same bucketing rule: `frequency_cap` its own bucket, everything else folds into subscription/suppression) to guarantee no behavior drift between the two views
- SummaryView's progress query uses `staleTime: Infinity` since a terminal campaign's counts never change — no polling needed, matching the plan's explicit instruction
- While the progress query is loading, `SummaryView` shows the `campaign` row's own counters as a fallback rather than a `Skeleton`, so the page never blanks out a previously-visible number

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- This closes the last outstanding verification gap (ANLT-01, SC1) documented in `07-VERIFICATION.md`; the human_verification[0] item (visually confirming percentages on a real sent/canceled campaign) remains carried to phase-level UAT per `human_verify_mode: end-of-phase`.
- No blockers for `07-09` (rollup dual-writer fix) or phase transition.

---
*Phase: 07-analytics-dashboard-send-log*
*Completed: 2026-07-14*

## Self-Check: PASSED

All created files and task commit hashes verified present on disk / in git log.
