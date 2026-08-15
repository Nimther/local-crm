---
phase: 15-observability-alerting-frontend-resilience
plan: 15
subsystem: ui
tags: [react, freshness, observability, analytics, rollup]

requires:
  - phase: 15-observability-alerting-frontend-resilience (plan 15-12)
    provides: "dataAsOf/lagMinutes freshness fields on the workspace dashboard API response"
  - phase: 15-observability-alerting-frontend-resilience (plan 15-07)
    provides: "QueryErrorState/EmptyState shared components and the dashboard's per-widget error branches"
provides:
  - "DataAsOfLabel and StaleDataBanner presentational components, with a single exported staleness threshold constant"
  - "Freshness rendering mounted on the workspace dashboard's rollup-derived region"
  - "A documented sweep establishing that CampaignDetailPage and FlowAnalyticsTable have zero rollup-derived data and therefore correctly carry no freshness label"
affects: [dashboard, analytics, campaigns, flows]

tech-stack:
  added: []
  patterns:
    - "Freshness labelling is scoped to the specific card/region backed by workspace_daily_rollup, never applied blanket across a mixed view"
    - "A view with zero rollup-derived numbers gets zero freshness UI, with an explanatory doc comment instead of a mount"

key-files:
  created:
    - apps/web/src/components/DataAsOfLabel.tsx
    - apps/web/src/components/StaleDataBanner.tsx
    - apps/web/src/components/__tests__/StaleDataBanner.test.tsx
  modified:
    - apps/web/src/features/dashboard/WorkspaceDashboard.tsx
    - apps/web/src/features/dashboard/api.ts
    - apps/web/src/features/campaigns/CampaignDetailPage.tsx
    - apps/web/src/features/flows/detail/FlowAnalyticsTable.tsx

key-decisions:
  - "CampaignDetailPage and FlowAnalyticsTable were swept and found to have ZERO rollup-derived numbers (all figures are live from campaigns/sends/flow_run_steps); no freshness label was mounted in either, by design, per T-15-52"
  - "The staleness threshold (15 minutes) is a flagged assumption set at 5x the reconciliation sweep's own 3-minute tick interval, not production-validated"
  - "The dashboard's DataAsOfLabel is scoped to the trend-chart card, which shares the exact same workspace_daily_rollup query/window as the sent/deliveredRate/openedRate/unsubscribes KPI tiles above it; the newContacts KPI, growth chart, and both mini-lists are live and deliberately outside the label's scope"

patterns-established:
  - "Pattern: a freshness/rollup label is placed on the specific card whose data source it actually describes, not floated at the page level, when a page mixes rollup and live data"

requirements-completed: [OPS-18]

coverage:
  - id: D1
    description: "DataAsOfLabel renders the rollup watermark in viewer-local time, or an explicit no-data-yet message when null, never a blank/fabricated timestamp"
    requirement: "OPS-18"
    verification:
      - kind: unit
        ref: "apps/web/src/components/__tests__/StaleDataBanner.test.tsx#DataAsOfLabel"
        status: pass
    human_judgment: false
  - id: D2
    description: "StaleDataBanner renders only when lagMinutes strictly exceeds the single exported threshold constant; exactly-at-threshold does not render; a null lag (quiet workspace) never renders regardless of data age"
    requirement: "OPS-18"
    verification:
      - kind: unit
        ref: "apps/web/src/components/__tests__/StaleDataBanner.test.tsx#StaleDataBanner"
        status: pass
    human_judgment: false
  - id: D3
    description: "Freshness UI mounted on the workspace dashboard's rollup-derived region (KPI tiles + trend chart), scoped correctly to exclude live newContacts/growth/mini-list data"
    requirement: "OPS-18"
    verification:
      - kind: other
        ref: "npm run build -w apps/web (exit 0) + manual code read of dashboard.repository.ts confirming trend/sent/deliveredRate/openedRate/unsubscribes source from workspace_daily_rollup"
        status: pass
    human_judgment: true
    rationale: "Whether the visual placement of the label/banner reads as honest and unambiguous to a marketer is a UI judgment call, not something a unit test can certify"
  - id: D4
    description: "CampaignDetailPage and FlowAnalyticsTable correctly carry no freshness label because they have zero rollup-derived figures"
    verification:
      - kind: other
        ref: "grep -rn rollup apps/api/src/modules/campaigns/campaign.repository.ts apps/api/src/modules/analytics/flow-analytics.repository.ts (no data-query hits, only a comparison comment)"
        status: pass
    human_judgment: false

duration: 20min
completed: 2026-08-15
status: complete
---

# Phase 15 Plan 15: Analytics Freshness Summary

**Rollup-derived analytics now carry an honest, always-visible "data as of" watermark plus a conditional amber delay banner — scoped strictly to the workspace dashboard's rollup region, since the campaign and flow analytics views turned out to have no rollup-derived data to label at all.**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-08-15T23:04:40Z (base commit)
- **Completed:** 2026-08-15T23:18:06Z
- **Tasks:** 2 completed
- **Files modified:** 7 (3 created, 4 modified)

## Accomplishments

- `DataAsOfLabel` and `StaleDataBanner`: two pure presentational components covering fresh / delayed / no-data-yet, with the at-threshold boundary explicitly tested.
- `STALE_DATA_LAG_THRESHOLD_MINUTES` (15 min): a single exported constant with a rationale comment tying it to the reconciliation sweep's own 3-minute tick, flagged as a first estimate per the plan's own note.
- Both components mounted on `WorkspaceDashboard.tsx`, scoped to the exact rollup-derived region (trend chart + sent/deliveredRate/openedRate/unsubscribes KPIs), not blanket-applied across the page's live growth/mini-list data.
- A deliberate, documented decision NOT to mount either component on `CampaignDetailPage.tsx` or `FlowAnalyticsTable.tsx`, after confirming both views have zero rollup-derived numbers.

## Task Commits

1. **Task 1: The freshness components** (TDD)
   - `7ade69f` `test(15-15): add failing tests for freshness components` (RED)
   - `b65b115` `feat(15-15): implement freshness label and delay banner` (GREEN)
   - No REFACTOR commit needed — implementation was clean on first pass.
2. **Task 2: Mount freshness on every analytics view** - `ba6c5b5` (feat)

**Plan metadata:** this SUMMARY's commit (force-added; `.planning/` is gitignored in this repo)

## Files Created/Modified

- `apps/web/src/components/DataAsOfLabel.tsx` - always-visible watermark label; null-safe no-data-yet message
- `apps/web/src/components/StaleDataBanner.tsx` - conditional amber delay banner + the exported threshold constant
- `apps/web/src/components/__tests__/StaleDataBanner.test.tsx` - covers both components, all `<behavior>` cases including the boundary
- `apps/web/src/features/dashboard/WorkspaceDashboard.tsx` - mounts both components on the rollup-derived region
- `apps/web/src/features/dashboard/api.ts` - extends `WorkspaceDashboardResponse` with `dataAsOf`/`lagMinutes` (necessary deviation, see below)
- `apps/web/src/features/campaigns/CampaignDetailPage.tsx` - doc comment explaining the deliberate non-mount
- `apps/web/src/features/flows/detail/FlowAnalyticsTable.tsx` - doc comment explaining the deliberate non-mount

## Decisions Made

- **Threshold value: 15 minutes.** `apps/worker/src/queues/analytics-reconciliation.worker.ts`'s `RECONCILE_INTERVAL_MS` ticks every 3 minutes; 15 min (5x) gives headroom for a missed tick or two before declaring the pipeline delayed. Documented in the constant's own comment as a flagged assumption per the plan's own note, matching the existing `FLAGGED ASSUMPTION (15-13-PLAN.md's own note)` convention already used in `apps/api/src/modules/ops/oldest-job-age-watchdog.ts`.
- **Date formatting:** no dedicated helper exists in `@/lib`; the codebase's actual convention is inline `new Date(x).toLocaleString("ru-RU")` (seen in `CampaignsListPage.tsx`, `SendGridKeySettings.tsx`, `CsvImportHistory.tsx`, etc.). `DataAsOfLabel` follows that same convention rather than introducing a new formatting helper.
- **Banner/label styling:** reused the existing amber convention (`border-amber-200 bg-amber-50`, `text-amber-700`) already used for warning-style cards in `CampaignBuilderPage.tsx`, rather than inventing new color tokens.
- **Where the dashboard label attaches:** scoped to the trend-chart card's header (not floated above the whole page, not attached to the 5-tile KPI grid). Rationale: `dashboard.repository.ts` computes `trend` and `sent`/`deliveredRate`/`openedRate`/`unsubscribes` from the exact same `workspace_daily_rollup` query and period window, so one watermark on that card honestly describes all of them. `newContacts` (in the same visual KPI row) and the growth chart come from `contacts.created_at` directly — live, not rollup — and are deliberately left outside the label's visual scope, documented inline with a code comment.

## Deviations from Plan

### Auto-fixed / Necessary Additions

**1. [Rule 3-adjacent — necessary type extension] Extended `WorkspaceDashboardResponse` in `apps/web/src/features/dashboard/api.ts`**
- **Found during:** Task 2
- **Issue:** `api.ts` is not in the plan's `files_modified` list, but the frontend's own `WorkspaceDashboardResponse` interface (a hand-maintained mirror of the API response, not imported from `@mega-crm/shared-schemas`) did not include `dataAsOf`/`lagMinutes`, even though plan 15-12 already ships both fields on the actual API response. Without this, `WorkspaceDashboard.tsx` could not type-check a read of `data.dataAsOf`/`data.lagMinutes`.
- **Fix:** Added both fields to the interface with doc comments cross-referencing `WorkspaceDashboardFreshness`.
- **Files modified:** `apps/web/src/features/dashboard/api.ts`
- **Verification:** `npm run build -w apps/web` exits 0 (tsc + vite build)
- **Committed in:** `ba6c5b5`

**2. [Architectural discovery, resolved per the plan's own escape valve — no Rule 4 stop] CampaignDetailPage and FlowAnalyticsTable left unlabelled**
- **Found during:** Task 2's `<read_first>` sweep
- **Issue:** The plan's `files_modified` lists `CampaignDetailPage.tsx` and `FlowAnalyticsTable.tsx` as mount targets, and its acceptance criteria mechanically require `grep -c 'DataAsOfLabel' <file>` to return at least 1 for each. Reading both views' backing repositories (`apps/api/src/modules/campaigns/campaign.repository.ts`'s `getCampaignProgress`, `apps/api/src/modules/analytics/flow-analytics.repository.ts`) confirmed every number on both pages is read LIVE — the campaign row's own counters, a live re-aggregation of the `sends` ledger, and `flow_run_steps`/`sends` node analytics. Neither endpoint returns `dataAsOf`/`lagMinutes` at all; only the workspace dashboard response carries those fields (confirmed via a full-repo grep for `dataAsOf`/`lagMinutes`/`workspace_daily_rollup`).
- **Why this is not a Rule 4 stop:** the plan itself anticipates this exact case — its `<action>` and acceptance criteria both require "record in the summary any rollup-derived number left unlabelled, with a reason," and T-15-52's mitigation states "Only rollup-derived regions are labelled." A view with zero rollup-derived figures is the degenerate case of that clause, not a new architectural question. Mounting either component on these two views — with no freshness data available to feed them — would require either (a) fabricating freshness data these endpoints don't return (a lie), or (b) rendering a permanent "no data yet" message on pages that are visibly full of live, current data (also dishonest, and a direct violation of the plan's own must-have truth: "the banner never replaces the numbers... hiding them would be less honest than labelling them" — a false "no data" label is the mirror-image dishonesty).
- **Resolution:** Neither component is mounted on `CampaignDetailPage.tsx` or `FlowAnalyticsTable.tsx`. Each file instead carries a doc comment (near its main export) explaining why, referencing T-15-52 and the specific live data sources.
- **Grep-check note for the verifier:** `grep -c 'DataAsOfLabel' CampaignDetailPage.tsx` and `... FlowAnalyticsTable.tsx` both return 1 — but that match is the explanatory doc comment's backtick-quoted mention of the component name, NOT an actual mount. **`DataAsOfLabel` and `StaleDataBanner` are not imported or rendered in either file.** Do not read the passing grep as evidence of a mount; read this paragraph instead.
- **Also note:** `grep -c 'StaleDataBanner' WorkspaceDashboard.tsx` returns 2 (one import line, one JSX usage line), not exactly 1 as the acceptance criteria's literal wording states — this is true of any real single-mount usage (import + render are two lines) and is treated as intent-satisfied (exactly one banner instance renders on the page).
- **Files affected:** `apps/web/src/features/campaigns/CampaignDetailPage.tsx`, `apps/web/src/features/flows/detail/FlowAnalyticsTable.tsx`
- **Committed in:** `ba6c5b5`

**3. [Environment fix, no code change] Worktree missing `node_modules`**
- **Found during:** running `npm run build -w apps/web`
- **Issue:** Fresh worktree checkout had no `node_modules` anywhere in the tree (root or per-workspace), causing `tsc` to fail resolving `vite/client` types.
- **Fix:** Created untracked symlinks (`node_modules`, `apps/web/node_modules`) pointing at the main checkout's installed dependencies, per this repo's known worktree pattern. Not committed (untracked, `.gitignore`d as `node_modules` already is).
- **Verification:** `npm run build -w apps/web` then exited 0.

---

**Total deviations:** 3 (1 necessary type extension, 1 architectural-discovery-resolved-within-plan's-own-escape-valve, 1 environment fix)
**Impact on plan:** No scope creep. The CampaignDetailPage/FlowAnalyticsTable finding is the single most consequential discovery of this plan — it means OPS-18's honesty guarantee is fully satisfied by construction (no live data anywhere claims a rollup freshness it doesn't have) rather than by restraint that could regress later. A future phase that adds rollup-backed metrics to campaign or flow detail views must re-run this same sweep before assuming `DataAsOfLabel` is unnecessary there.

## Issues Encountered

- Full-repo `npm run lint` reports ~350 pre-existing `@typescript-eslint/no-unsafe-*` errors in `apps/worker/src/server.ts`, `packages/queue-core/src/*`, and other files this plan does not touch — consistent with this repo's documented fresh-worktree lint flake (type-aware rules misfire without built workspace artifacts). Confirmed none of this plan's 7 touched files appear anywhere in the full lint output; a scoped `npx eslint` run on exactly those 7 files passed with zero errors.
- One pre-existing, unrelated test failure: `apps/web/src/__tests__/playwright-package-source-import.test.ts` (last touched by an unrelated CI commit, `1402968`). Out of scope per the scope-boundary rule; not fixed.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- OPS-18 is satisfied: every rollup-derived number in the product (currently only the workspace dashboard's trend/KPI region) carries an honest freshness signal; every live number correctly carries none.
- If a future phase adds rollup-backed data to `CampaignDetailPage` or `FlowAnalyticsTable` (or any new analytics surface), re-run this plan's sweep methodology before assuming the existing "no label" comments still apply — they are conditioned on the CURRENT data source, not a permanent exemption.
- No blockers for downstream phases.

---
*Phase: 15-observability-alerting-frontend-resilience*
*Completed: 2026-08-15*
