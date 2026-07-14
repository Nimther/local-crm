---
phase: 07-analytics-dashboard-send-log
plan: 03
subsystem: analytics
tags: [react, tanstack-query, postgres, campaigns, rates]

requires:
  - phase: 04-campaigns-send-pipeline
    provides: campaigns row counters (sent/delivered/opened/clicked/bounced/unsubscribed), sends ledger with exclusion_reason
  - phase: 05-webhook-delivery-tracking
    provides: delivered/opened/clicked/bounced/unsubscribed counters kept fresh on the campaigns row
provides:
  - "computeRate(numerator, denominator): number | null shared rate helper (D-01, null on zero denominator)"
  - "getCampaignProgress excludedBreakdown grouped by exclusion_reason (D-07)"
  - "CampaignProgress summary enriched with D-01 rate percentages, «Пропущено» breakdown, and a send-log deep link (D-04)"
  - "CampaignsListPage per-row sent/delivered%/opened%/clicked% comparison columns (D-06)"
affects: [flow-analytics, dashboard-kpis, send-log]

tech-stack:
  added: []
  patterns:
    - "computeRate(numerator, denominator) is the single shared source for every rate percentage across campaign/flow/dashboard surfaces -- returns null (never NaN/Infinity) on a zero denominator, rendered as «—» by every call site"
    - "Excluded-reason breakdown buckets any exclusion_reason value into two UI buckets: frequency_cap is its own bucket, everything else (suppressed/unsubscribed/no_email/null) folds into the subscription/suppression bucket"

key-files:
  created:
    - apps/web/src/lib/rates.ts
    - apps/web/src/lib/__tests__/rates.test.ts
    - apps/api/src/modules/campaigns/__tests__/campaign-excluded-breakdown.test.ts
  modified:
    - apps/api/src/modules/campaigns/campaign.repository.ts
    - apps/web/src/features/campaigns/api.ts
    - apps/web/src/features/campaigns/CampaignProgress.tsx
    - apps/web/src/features/campaigns/CampaignsListPage.tsx

key-decisions:
  - "getCampaignProgress's excluded-reason breakdown query is parameterized and scoped by workspace_id, reusing the same tenant-scoped path as the existing ledger re-aggregation (T-07-03-01)"
  - "computeRate lives in apps/web/src/lib/rates.ts (not shared-schemas) since it is pure UI-formatting logic with no server-side caller yet"
  - "Excluded-reason values (suppressed/unsubscribed/no_email/frequency_cap from pre-send-gate.ts) are bucketed client-side into exactly the UI-SPEC's two rows -- frequency_cap is its own bucket, all others fold into subscription/suppression"
  - "CampaignDetailPage's terminal-state SummaryView (sent/canceled campaigns) was NOT touched -- out of this plan's literal files_modified scope; it duplicates CampaignProgress.tsx's delivery-counter grid (a pre-existing duplication per the 05-05 STATE.md decision) and does not yet show D-01 rates or the excluded breakdown. Flagged below as a scope gap for phase UAT / a follow-up plan."

patterns-established:
  - "Rate-percentage rendering: computeRate(n, d) -> number | null, rendered via a local rateLabel(rate) helper that maps null to «—»"

requirements-completed: [ANLT-01]

coverage:
  - id: D1
    description: "computeRate returns the correct rounded percentage and null on a zero denominator"
    requirement: "ANLT-01"
    verification:
      - kind: unit
        ref: "apps/web/src/lib/__tests__/rates.test.ts#computeRate"
        status: pass
    human_judgment: false
  - id: D2
    description: "getCampaignProgress returns excludedBreakdown grouped by exclusion_reason, scoped to the workspace"
    requirement: "ANLT-01"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/campaigns/__tests__/campaign-excluded-breakdown.test.ts#Campaign excluded-reason breakdown (D-07)"
        status: pass
    human_judgment: false
  - id: D3
    description: "CampaignProgress (sending-view summary) renders D-01 rate percentages, a «Пропущено» breakdown, and a send-log deep link"
    requirement: "ANLT-01"
    verification:
      - kind: other
        ref: "grep computeRate/Пропущено/send-log?campaign= in CampaignProgress.tsx (plan acceptance criteria)"
        status: pass
    human_judgment: true
    rationale: "Visual rendering, real-world formula correctness across live data, and the send-log link's actual destination (send-log page ships in 07-05) need human/browser verification at phase UAT -- grep proves the code exists, not that it renders correctly."
  - id: D4
    description: "CampaignsListPage rows show sent/delivered%/opened%/clicked% for at-a-glance comparison"
    requirement: "ANLT-01"
    verification:
      - kind: other
        ref: "grep computeRate in CampaignsListPage.tsx (plan acceptance criteria)"
        status: pass
    human_judgment: true
    rationale: "List-row layout and readability need visual confirmation at phase UAT"

duration: 15min
completed: 2026-07-14
status: complete
---

# Phase 7 Plan 3: Campaign Metrics Summary

**D-01 rate percentages (delivered/open/click/bounce %) and a D-07 excluded-reason breakdown wired into the campaign summary and list, reading only existing campaigns/sends counters -- no schema change.**

## Performance

- **Duration:** 15 min
- **Completed:** 2026-07-14
- **Tasks:** 2
- **Files modified:** 7 (3 created, 4 modified)

## Accomplishments
- `computeRate(numerator, denominator)` shared helper (returns rounded percent or `null` on a zero denominator) -- unit-tested against all 5 must-have cases
- `getCampaignProgress` extended with `excludedBreakdown: { reason, count }[]`, grouped over the `sends` ledger's `exclusion_reason` column, scoped by workspace
- `CampaignProgress` (the sending-view summary) now shows delivered/open/click/bounce rate percentages next to each counter, a «Пропущено: N» row bucketed into subscription/suppression vs frequency-cap, and a «Смотреть в журнале отправок» deep link to `/w/{slug}/send-log?campaign={id}`
- `CampaignsListPage` rows gained sent/delivered%/opened%/clicked% columns for at-a-glance comparison across campaigns

## Task Commits

Each task was committed atomically:

1. **Task 1: Shared computeRate helper + campaign excluded-reason breakdown API** - RED `f7bbc6d` (test) → GREEN `fc2130e` (feat)
2. **Task 2: Enrich CampaignProgress summary and CampaignsListPage row metrics** - `6cb0054` (feat)

**Plan metadata:** (this commit)

## Files Created/Modified
- `apps/web/src/lib/rates.ts` - `computeRate(numerator, denominator): number | null`, the shared D-01 rate formula
- `apps/web/src/lib/__tests__/rates.test.ts` - unit tests pinning the rounding and null-on-zero-denominator cases
- `apps/api/src/modules/campaigns/campaign.repository.ts` - `getCampaignProgress` now also returns `excludedBreakdown`
- `apps/api/src/modules/campaigns/__tests__/campaign-excluded-breakdown.test.ts` - integration test proving empty-array and grouped-by-reason cases
- `apps/web/src/features/campaigns/api.ts` - `CampaignProgress` type carries `excludedBreakdown`
- `apps/web/src/features/campaigns/CampaignProgress.tsx` - rate percentages, excluded-breakdown row, send-log link, `tabular-nums`
- `apps/web/src/features/campaigns/CampaignsListPage.tsx` - sent/delivered%/opened%/clicked% row columns, `tabular-nums`

## Decisions Made
- Bucketed the four real `exclusion_reason` values (`suppressed`, `unsubscribed`, `no_email`, `frequency_cap` -- from `pre-send-gate.ts`'s `PreSendSkipReason` union) into exactly the UI-SPEC's two rows: `frequency_cap` is its own bucket, everything else folds into "подписки/suppression" -- matches the literal copy in 07-UI-SPEC.md without inventing a third bucket.
- Kept `computeRate` in `apps/web/src/lib/rates.ts` (web-only) since no server-side caller needs it yet; every current call site is a React component.
- The excluded-breakdown SQL query reuses `getCampaignProgress`'s existing tenant-scoped `withTenantTransaction` path rather than adding a new endpoint, keeping the security boundary identical to the ledger re-aggregation already in that function.

## Deviations from Plan

None — plan executed exactly as written for both tasks. One pre-existing scope gap was identified and left untouched (see below, not a deviation from this plan's instructions).

### Scope Note (not a deviation -- flagged for phase UAT / follow-up)

**CampaignDetailPage's terminal-state `SummaryView` (rendered when a campaign's status is `sent` or `canceled`) does not use the `CampaignProgress` component** -- it is a separate function with its own duplicated delivery-counter `dl` grid (a pre-existing duplication recorded in STATE.md's 05-05 decision). This plan's `files_modified` list and acceptance criteria scope the enrichment to `CampaignProgress.tsx` (used only in the live "Прогресс отправки" sending view) and `CampaignsListPage.tsx`. As a result, a completed/canceled campaign's terminal summary still shows only raw counts -- no D-01 rates, no «Пропущено» breakdown, no send-log link -- even though `07-UI-SPEC.md`'s screen inventory frames "CampaignDetailPage summary enrichment" as extending `CampaignProgress.tsx`'s logic to that surface too. Extending `SummaryView` would require touching a file outside this plan's declared scope and adding a new always-enabled progress query for terminal statuses (the current query is gated `enabled: status === "sending"`), which is more than an additive one-line fix. Left untouched per the SCOPE BOUNDARY guidance (only fix issues directly caused by this plan's own file changes); flagged here for the phase's end-of-phase UAT or a follow-up plan to decide whether `SummaryView` should also read the enriched data.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- `computeRate` is now available as the shared rate-formula source for the remaining phase-7 plans (flow analytics, dashboard KPIs, send log) per the plan's `key_links`.
- `excludedBreakdown` is available on the campaign-progress API response for any future consumer (e.g., a flow-analytics equivalent).
- Known gap carried forward: `CampaignDetailPage`'s terminal `SummaryView` still lacks the D-01/D-07 enrichment (see Scope Note above) -- worth a decision before phase UAT sign-off.

---
*Phase: 07-analytics-dashboard-send-log*
*Completed: 2026-07-14*

## Self-Check: PASSED

All created/modified files verified present on disk; all task commit hashes (`f7bbc6d`, `fc2130e`, `6cb0054`) verified in git log.
