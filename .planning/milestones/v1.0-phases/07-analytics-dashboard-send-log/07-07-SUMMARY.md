---
phase: 07-analytics-dashboard-send-log
plan: 07
subsystem: analytics
tags: [recharts, react-query, fastify, postgres, dashboard, rollup]

requires:
  - phase: 07-analytics-dashboard-send-log
    provides: workspace_daily_rollup table + incremental/reconciliation writer (07-06)
provides:
  - "GET /api/workspaces/:slug/dashboard rollup-backed read endpoint (trend, growth, KPIs, mini-lists)"
  - "WorkspaceDashboard as the new /w/:slug index route (replaces WorkspaceHome)"
  - "First Recharts usage in the codebase (TrendChart, GrowthChart) with a validated chart palette"
affects: [dashboard, analytics, workspace-home, app-shell]

tech-stack:
  added: ["recharts@3.9.2"]
  patterns:
    - "Dashboard reads are rollup-first (workspace_daily_rollup), never a live GROUP BY over partitioned sends/send_events (D-08b)"
    - "Dense zero-filled day-window series computed in JS against a single JS-computed 'today' bound, not Postgres now()/current_date"
    - "Chart color validated via the dataviz skill's validate_palette.js rather than eyeballed"

key-files:
  created:
    - apps/api/src/modules/analytics/dashboard.repository.ts
    - apps/api/src/modules/analytics/dashboard.routes.ts
    - apps/api/src/modules/analytics/__tests__/dashboard.test.ts
    - apps/web/src/features/dashboard/api.ts
    - apps/web/src/features/dashboard/TrendChart.tsx
    - apps/web/src/features/dashboard/GrowthChart.tsx
    - apps/web/src/features/dashboard/WorkspaceDashboard.tsx
  modified:
    - apps/api/src/modules/analytics/index.ts
    - apps/web/package.json
    - apps/web/src/App.tsx

key-decisions:
  - "recharts package-legitimacy checkpoint approved by user (npmjs.com verification: canonical recharts/recharts repo, tens-of-millions weekly downloads, non-deprecated, React ^19 peer dep, pre-approved in CLAUDE.md)"
  - "recharts pinned exact (3.9.2, no caret) in apps/web/package.json, matching the @xyflow/react 06-10 precedent for new chart/canvas dependencies"
  - "Dashboard empty state ('Пока нет отправок') derived heuristically as kpis.sent === 0 && recentCampaigns.length === 0 && activeFlows.length === 0 -- no dedicated 'has ever sent' flag exists on the endpoint; mirrors OnboardingChecklist's own all-time-count heuristic"
  - "AppShell.tsx left unmodified -- the 'Журнал отправок' nav link already existed from an earlier phase-7 plan, and the UI-SPEC explicitly calls for no separate dashboard nav item (it is the index route)"

patterns-established:
  - "Chart palette computed and validated via dataviz skill's validate_palette.js before use, not eyeballed -- documented in TrendChart.tsx/GrowthChart.tsx comments"
  - "Recharts tooltip content components follow the dataviz skill's 'values lead, labels follow' + 'line keys not boxes' rules"

requirements-completed: [ANLT-04]

coverage:
  - id: D1
    description: "Dashboard endpoint returns dense rollup-backed trend series, cumulative contact-growth series, period KPIs, and recent-campaigns/active-flows mini-lists, tenant-scoped"
    requirement: "ANLT-04"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/analytics/__tests__/dashboard.test.ts (3 tests: dense trend from rollup, cumulative growth, invalid-period 400)"
        status: pass
    human_judgment: false
  - id: D2
    description: "WorkspaceDashboard replaces WorkspaceHome as the /w/:slug index route: period presets (7/30/90, default 30), TrendChart + GrowthChart (Recharts, UI-SPEC palette), KPI card row, recent-campaigns/active-flows mini-lists, preserved onboarding checklist, empty/loading/error states"
    requirement: "ANLT-04"
    verification:
      - kind: other
        ref: "npm run build -w apps/web (tsc --noEmit + vite build) -- exits 0; acceptance-criteria greps for recharts import, #2A78D6 palette slot, WorkspaceDashboard route swap, OnboardingChecklist preservation, empty-state copy all match"
        status: pass
    human_judgment: true
    rationale: "Visual chart rendering (legend order, tooltip crosshair behavior, KPI card layout, empty/loading state appearance) requires human eyes on the running app -- automated build/grep checks confirm the code compiles and contains the required literals but cannot confirm the dashboard reads correctly at a glance."

duration: ~4h42m (includes a checkpoint pause awaiting user confirmation on the recharts package-legitimacy gate)
completed: 2026-07-14
status: complete
---

# Phase 07 Plan 07: Workspace Dashboard Summary

**Rollup-backed workspace dashboard endpoint plus the first Recharts usage in the codebase (TrendChart/GrowthChart), replacing WorkspaceHome as the `/w/:slug` index route.**

## Performance

- **Duration:** ~4h42m (includes checkpoint pause for user confirmation on the recharts package-legitimacy gate)
- **Started:** 2026-07-14T03:33:14+05:00 (Task 1 RED commit)
- **Completed:** 2026-07-14T08:15:18+05:00 (Task 3 commit)
- **Tasks:** 3 (1 TDD auto, 1 blocking-human checkpoint, 1 auto)
- **Files modified:** 10

## Accomplishments
- `getWorkspaceDashboard(period)` repository + `GET /api/workspaces/:slug/dashboard` route: dense zero-filled trend series from `workspace_daily_rollup` (never a live scan of `sends`/`send_events`, D-08b), cumulative contact-growth series from `contacts.created_at`, period KPIs (sent/deliveredRate/openedRate/newContacts/unsubscribes), recent-campaigns and active-flows mini-lists.
- recharts 3.9.2 installed into `apps/web` after an explicit blocking-human package-legitimacy checkpoint (approved on npmjs.com evidence).
- `TrendChart.tsx` (3-series AreaChart, fixed sent→delivered→opened order, UI-SPEC hex palette validated via the dataviz skill) and `GrowthChart.tsx` (single-series cumulative area, no legend box) — the first Recharts usage in the codebase.
- `WorkspaceDashboard.tsx`: period presets (7/30/90 days, default 30), preserved `OnboardingChecklist` on top (D-08a), KPI card row, both charts, recent-campaigns/active-flows mini-lists, and empty/loading/error states.
- `App.tsx`'s `/w/:slug` index route swapped from `WorkspaceHome` to `WorkspaceDashboard` (old file left in place, unreferenced, per the plan's explicit instruction).

## Task Commits

Each task was committed atomically:

1. **Task 1: Dashboard read repository + route** - `49f6498` (test, RED) → `e5daba3` (feat, GREEN)
2. **Task 2: [SUS] package-legitimacy checkpoint — recharts** - no commit (checkpoint task); user approved
3. **Task 3: Recharts install + WorkspaceDashboard + home-route swap** - `aa1c09f` (feat)

**Plan metadata:** _(final docs commit follows this summary)_

_Note: Task 1 is a TDD task (RED → GREEN commits)._

## Files Created/Modified
- `apps/api/src/modules/analytics/dashboard.repository.ts` - `getWorkspaceDashboard(period)`: rollup-backed trend, growth, KPIs, mini-lists
- `apps/api/src/modules/analytics/dashboard.routes.ts` - `GET /api/workspaces/:slug/dashboard`, period validated to closed set 7|30|90
- `apps/api/src/modules/analytics/index.ts` - registered `registerDashboardRoutes` under `registerAnalyticsRoutes`
- `apps/api/src/modules/analytics/__tests__/dashboard.test.ts` - dense trend/growth/KPI/invalid-period coverage
- `apps/web/package.json` - added `recharts@3.9.2` (exact pin)
- `apps/web/src/features/dashboard/api.ts` - typed `getWorkspaceDashboard(slug, period)` fetcher
- `apps/web/src/features/dashboard/TrendChart.tsx` - 3-series trend AreaChart
- `apps/web/src/features/dashboard/GrowthChart.tsx` - single-series growth AreaChart
- `apps/web/src/features/dashboard/WorkspaceDashboard.tsx` - the new workspace index page
- `apps/web/src/App.tsx` - index route swapped to `WorkspaceDashboard`

## Decisions Made
- recharts package-legitimacy checkpoint approved by the user (npmjs.com verification: canonical `recharts/recharts` repo, tens-of-millions weekly downloads, non-deprecated, latest `3.9.x`, React `^19` peer dep, pre-approved in `CLAUDE.md`).
- recharts pinned exact (`3.9.2`, no caret), matching the `@xyflow/react` 06-10 precedent for new chart/canvas dependencies in this codebase.
- Dashboard empty state (`«Пока нет отправок»`) derived as `kpis.sent === 0 && recentCampaigns.length === 0 && activeFlows.length === 0` — no dedicated "has ever sent" flag exists on the endpoint; this mirrors `OnboardingChecklist`'s own all-time-count heuristic and is a reasonable proxy given the plan's literal requirement ("a zero-sends workspace shows the empty state").
- `AppShell.tsx` left unmodified — the `«Журнал отправок»` nav link already existed from an earlier phase-7 plan (07-05), and the UI-SPEC explicitly states the dashboard needs no separate nav item since it is the index route.

## Deviations from Plan

None - plan executed exactly as written. `AppShell.tsx` was listed in `files_modified` but required no changes since its nav links already satisfied the plan's requirements (documented as a decision above, not a deviation).

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- ANLT-04 (workspace summary dashboard) is complete; this closes out Phase 07's plan set (7/7).
- `apps/web/src/features/workspace-home/WorkspaceHome.tsx` remains in the tree, unreferenced — safe to delete in a future cleanup pass if desired, not done here per the plan's explicit "leave in place" instruction.
- No blockers for phase-level UAT.

---
*Phase: 07-analytics-dashboard-send-log*
*Completed: 2026-07-14*

## Self-Check: PASSED

All 7 created/modified source files and 4 commit hashes (49f6498, e5daba3, aa1c09f, 6ae6740) verified present.
