---
status: diagnosed
phase: 07-analytics-dashboard-send-log
source: [07-VERIFICATION.md]
started: 2026-07-14T07:11:30Z
updated: 2026-07-14T07:45:00Z
---

## Current Test

[testing complete]

## Tests

### 1. Terminal-campaign metrics visual confirmation
expected: Open a `sent`/`canceled` campaign's detail page and visually confirm the delivered/open/click/bounce rate percentages, the «Пропущено» breakdown, and the send-log link render correctly and legibly. Percentages next to each counter, «Пропущено: N» with sub-lines when applicable, and a working «Смотреть в журнале отправок» link.
result: issue
reported: "Всё работает, но после сброса фильтров в журнале отправок я не могу снова отфильтровать результаты отправок по кампании — только по событиям"
severity: major

### 2. Visual/layout checks across analytics surfaces
expected: Carried from 07-02/07-03/07-04/07-07 SUMMARYs — rate rendering on campaign list/detail, flow-canvas node badge placement and tooltip legibility at various zoom levels, dashboard chart legend/palette rendering, KPI card layout. Optional sanity check: a live look at the dashboard's «Открыто» KPI (the dual-writer invariant is already proven by a real-Postgres regression test and does not block).
result: pass

## Summary

total: 2
passed: 1
issues: 1
pending: 0
skipped: 0
blocked: 0

## Gaps

- truth: "After resetting filters in the send log, the user can re-apply a campaign filter to filter sends by campaign"
  status: failed
  reason: "User reported: Всё работает, но после сброса фильтров в журнале отправок я не могу снова отфильтровать результаты отправок по кампании — только по событиям"
  severity: major
  test: 1
  root_cause: "Send-log page has no user-facing campaign selector — the campaign filter exists only as a URL-param-driven deep-link chip set by CampaignMetricsSummary's «Смотреть в журнале отправок» link. resetFilters() wipes all search params (including campaign), and the page's only interactive filter controls are the status multi-select and period presets, so the campaign filter cannot be re-applied in-page. Spec/design gap (07-05 decision / 07-UI-SPEC chose deep-link chips over comboboxes), not a regression. Backend already supports the filter via campaignOrFlowId — frontend-only gap."
  artifacts:
    - path: "apps/web/src/features/send-log/SendLogPage.tsx"
      issue: "campaign filter is a read-only chip; no selector control; resetFilters() irreversibly clears the campaign param from within the page"
    - path: "apps/web/src/features/campaigns/CampaignMetricsSummary.tsx"
      issue: "line 102 is the only UI path that sets ?campaign= (context, not itself wrong)"
    - path: "apps/api/src/modules/send-log/send-log.routes.ts"
      issue: "already accepts campaignOrFlowId — no backend change needed"
  missing:
    - "Add a user-facing campaign (and flow, for symmetry) selector to the send-log filter toolbar — Popover+Command combobox listing workspace campaigns, mirroring the existing status multi-select pattern, writing the campaign URL search param"
    - "Keep existing chip display and deep-link behavior as-is; zero backend changes (campaignOrFlowId already supported)"
  debug_session: ".planning/debug/send-log-campaign-filter-after-reset.md"
