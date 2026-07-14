---
status: complete
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
  root_cause: ""
  artifacts: []
  missing: []
  debug_session: ""
