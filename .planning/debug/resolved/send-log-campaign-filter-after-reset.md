---
status: resolved
trigger: "UAT Phase 07 Test 1: after resetting filters in the send log the user cannot re-filter sends by campaign — only by events"
created: 2026-07-14T08:00:00Z
updated: 2026-07-14T14:20:00Z
---

## Current Focus

hypothesis: CONFIRMED — The campaign filter on the send-log page exists only as a URL-param-driven deep-link chip (set by the «Смотреть в журнале отправок» link from campaign detail). The filter toolbar has no user-facing campaign selector, so once the chip is cleared (× or «Сбросить фильтры») there is no way to re-apply a campaign filter from within the page.
test: Read SendLogPage.tsx in full; traced deep-link source (CampaignMetricsSummary.tsx) and API route (send-log.routes.ts); cross-checked 07-UI-SPEC.md component inventory.
expecting: n/a — hypothesis confirmed by direct code reading; no alternative hypotheses remain (no errors, no broken state, behavior matches the code's own documented intent).
next_action: Return ROOT CAUSE FOUND to orchestrator (goal: find_root_cause_only — no fix applied).

## Symptoms

expected: "Open a sent/canceled campaign's detail page: the «Смотреть в журнале отправок» link opens the send log pre-filtered by this campaign. Filters in the send log should allow filtering by campaign at any time."
actual: "User reported (verbatim, Russian): «Всё работает, но после сброса фильтров в журнале отправок я не могу снова отфильтровать результаты отправок по кампании — только по событиям». Translation: everything works, but after resetting filters in the send log the user cannot re-filter sends by campaign — only by events."
errors: None reported
reproduction: "Test 1 in UAT — open campaign detail → «Смотреть в журнале отправок» (arrives pre-filtered by campaign) → reset filters → try to filter by campaign again → no campaign filter control available, only event-type filters"
started: Discovered during UAT on 2026-07-14 (Phase 07 analytics-dashboard-send-log)

## Eliminated

## Evidence

- timestamp: 2026-07-14T08:05:00Z
  checked: apps/web/src/features/send-log/SendLogPage.tsx (full read)
  found: >
    The component's doc comment (lines 106-114) states verbatim: filters are
    "driven entirely by URL search params -- contact/campaign/flow are set by
    OTHER pages' deep-links (never edited here, only cleared via their chip's ×
    or the blanket «Сбросить фильтры»), while status/period/page are edited
    directly on this page." Interactive controls rendered: status multi-select
    popover (STATUS_OPTIONS, line 282-303), period preset buttons (line
    305-316), «Сбросить фильтры» (line 318-320), pagination. The campaign
    filter renders ONLY as a Badge chip with an × when searchParams has
    "campaign" (lines 265-272). resetFilters() (line 190-192) does
    setSearchParams(new URLSearchParams()) — wipes the campaign param. There is
    NO campaign/flow/contact selector control anywhere in the component.
  implication: >
    Confirmed by direct code reading: once the campaign URL param is cleared
    (chip × or reset), the page offers no way to re-apply it. Only status
    ("события" in the user's wording — the send-event statuses
    delivered/opened/clicked/bounced) and period remain filterable. This is
    intentional per the code comment, i.e., a design/UX gap rather than a state
    bug.

- timestamp: 2026-07-14T08:10:00Z
  checked: apps/web/src/features/campaigns/CampaignMetricsSummary.tsx:102-103
  found: The «Смотреть в журнале отправок» link is `/w/{slug}/send-log?campaign={campaignId}` — a plain URL deep link. This is the sole UI path that sets the `campaign` search param.
  implication: Re-applying the campaign filter after reset requires navigating back to the campaign detail page (or hand-editing the URL); confirms there is no in-page path.

- timestamp: 2026-07-14T08:10:00Z
  checked: apps/api/src/modules/send-log/send-log.routes.ts (full read)
  found: sendLogQuerySchema accepts campaignOrFlowId (uuid, optional, line 21); listSendLog is called with it (line 117). Backend filtering by campaign is fully functional and unconditional.
  implication: The gap is frontend-only — no API change needed for a fix; a campaign selector writing the `campaign` URL param would work against the existing endpoint as-is.

- timestamp: 2026-07-14T08:12:00Z
  checked: .planning/phases/07-analytics-dashboard-send-log/07-UI-SPEC.md (filter/interaction inventory)
  found: "Line 153: Campaign summary → send log link 'Pre-filters send log by campaignId via URL param'. Line 202: SendLogPage component inventory lists only 'popover+command+checkbox (multi-select status), button (period presets)' as filter controls. No campaign selector was ever specified."
  implication: The behavior is spec-conformant — the UAT failure is a spec/design gap (UAT truth requires re-applicable campaign filtering; UI-SPEC never specified a control for it), not an implementation regression.

- timestamp: 2026-07-14T08:00:00Z
  checked: .planning/STATE.md accumulated decisions for Phase 07
  found: "07-05: contact/campaign/flow send-log filters are URL-param-driven deep-link chips, not open comboboxes -- 07-UI-SPEC's inventory lists only status multi-select + period presets as interactive controls on this page"
  implication: The design decision itself states campaign filtering is deep-link-only. This is a strong prior for the hypothesis, but must be confirmed against actual code (chip removal behavior, reset behavior, absence of selector).

## Resolution

root_cause: >
  Design gap, not a state/logic bug. The send-log page
  (apps/web/src/features/send-log/SendLogPage.tsx) implements the
  campaign/flow/contact filters exclusively as URL-search-param-driven
  deep-link chips: the «Смотреть в журнале отправок» link on the campaign
  summary (apps/web/src/features/campaigns/CampaignMetricsSummary.tsx:102,
  `/w/{slug}/send-log?campaign={campaignId}`) is the ONLY entry point that sets
  the `campaign` param. The page renders that param as a removable Badge chip
  (SendLogPage.tsx:265-272) but provides no combobox/select to choose a
  campaign. resetFilters() (SendLogPage.tsx:190-192) replaces the search params
  with an empty URLSearchParams, deleting `campaign`. After that, the only
  interactive filter controls remaining are the status multi-select
  (the "события" the user refers to — delivered/opened/clicked/bounced send
  statuses) and period presets, so re-filtering by campaign is impossible
  without navigating back to the campaign detail page. This is intentional per
  the 07-05 design decision ("contact/campaign/flow send-log filters are
  URL-param-driven deep-link chips, not open comboboxes") and 07-UI-SPEC.md's
  component inventory (line 202: only status multi-select + period presets),
  but it violates the UAT truth "filters in the send log should allow filtering
  by campaign at any time". The backend already fully supports this filter:
  GET /api/workspaces/:slug/send-log accepts campaignOrFlowId
  (apps/api/src/modules/send-log/send-log.routes.ts:21,117) — only the UI
  selector is missing.
fix: (not applied — goal was find_root_cause_only)
verification: (n/a)
files_changed: []
