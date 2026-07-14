---
status: testing
phase: 07-analytics-dashboard-send-log
source: [07-VERIFICATION.md]
started: 2026-07-14T07:11:30Z
updated: 2026-07-14T07:11:30Z
---

## Current Test

number: 1
name: Terminal-campaign metrics visual confirmation
expected: |
  Open a sent/canceled campaign's detail page: rate percentages render next to each counter
  (delivered/open/click/bounce), «Пропущено: N» breakdown shows sub-lines when applicable
  (subscription/suppression vs frequency-cap), and the «Смотреть в журнале отправок» link
  opens the send log pre-filtered by this campaign.
awaiting: user response

## Tests

### 1. Terminal-campaign metrics visual confirmation
expected: Open a `sent`/`canceled` campaign's detail page and visually confirm the delivered/open/click/bounce rate percentages, the «Пропущено» breakdown, and the send-log link render correctly and legibly. Percentages next to each counter, «Пропущено: N» with sub-lines when applicable, and a working «Смотреть в журнале отправок» link.
result: [pending]

### 2. Visual/layout checks across analytics surfaces
expected: Carried from 07-02/07-03/07-04/07-07 SUMMARYs — rate rendering on campaign list/detail, flow-canvas node badge placement and tooltip legibility at various zoom levels, dashboard chart legend/palette rendering, KPI card layout. Optional sanity check: a live look at the dashboard's «Открыто» KPI (the dual-writer invariant is already proven by a real-Postgres regression test and does not block).
result: [pending]

## Summary

total: 2
passed: 0
issues: 0
pending: 2
skipped: 0
blocked: 0

## Gaps
