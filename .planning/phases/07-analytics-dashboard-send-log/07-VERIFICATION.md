---
phase: 07-analytics-dashboard-send-log
verified: 2026-07-14T18:15:00Z
status: gaps_found
score: 8/9 must-haves verified
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 5/5
  gaps_closed:
    - "After «Сбросить фильтры», the user can re-apply a campaign filter to filter sends by campaign (UAT Test 1, major) — 07-10 added a persistent «Кампания / цепочка» Popover+Command selector, rendered unconditionally in the send-log toolbar (SendLogPage.tsx:292), independent of resetFilters(). Pure applySendTargetToParams/resolveSendTargetLabel helpers (send-log-filters.ts) enforce campaign⊕flow mutual exclusion and page reset. 9/9 unit tests pass, apps/web build clean."
  gaps_remaining: []
  regressions: []
gaps:
  - truth: "Selecting a campaign filters sends to that campaign and writes ?campaign=; selecting a flow writes ?flow= and clears ?campaign= (mutually exclusive)"
    status: partial
    reason: "New defect (WR-02, discovered by the phase's own 2026-07-14T13:03:51Z code review and independently confirmed here by reading CampaignFlowFilter.tsx + campaign.repository.ts/flow.repository.ts directly): CampaignFlowFilter.tsx keys cmdk's CommandItem `value` prop by the entity's display NAME (`value={campaign.name}` line 83, `value={flow.name}` line 100), not by id. cmdk (v1.1.1, confirmed in apps/web/package.json) uses `value` as the item's internal identity for filtering/selection/keyboard-nav -- duplicate values are not supported and cause selection ambiguity (first match wins). Campaign/flow names are NOT unique: duplicateCampaign (apps/api/src/modules/campaigns/campaign.repository.ts:318-343) and duplicateFlow (apps/api/src/modules/flows/flow.repository.ts:550-580) both copy the source name into the new row verbatim, with no disambiguating suffix -- confirmed by reading both functions directly. Since duplicating a campaign/flow for an A/B or seasonal-rerun variant is a normal workflow (not a contrived edge case), two send-log-selectable items with an identical label is a routine occurrence in a mature workspace. When it occurs, clicking the SECOND of two identically-named campaigns in the selector can silently resolve to the FIRST one's id -- the log re-filters to the wrong campaign's sends with no error, no visual difference, and no way for the marketer to detect the mismatch from the UI alone. This directly undermines the phase goal's promise of per-campaign accountability 'down to the status of every individual message.' The happy path (unique names, the majority case) is unaffected and verified working: 9/9 unit tests pass for the pure mutual-exclusion/page-reset/label-resolution logic, and the component/wiring is otherwise correctly structured (unconditional render, correct URL param writes, correct Check-icon/Очистить behavior)."
    artifacts:
      - path: "apps/web/src/features/send-log/CampaignFlowFilter.tsx"
        issue: "Lines 83 and 100: value={campaign.name} / value={flow.name} are not unique keys; must disambiguate with the id."
    missing:
      - "Make the cmdk CommandItem value unique while keeping name-based text search, e.g. value={`${campaign.name} ${campaign.id}`} (and the same for flows) -- the fix suggested by 07-REVIEW.md WR-02."
      - "A regression test (or at minimum a manual UAT re-test) exercising two same-named campaigns to confirm the fix actually resolves the correct id on selection."
---

# Phase 7: Analytics, Dashboard & Send Log Verification Report

**Phase Goal:** A marketer can see end-to-end performance — per campaign, per flow step, per contact, and across the whole workspace — down to the status of every individual message.
**Verified:** 2026-07-14T18:15:00Z
**Status:** gaps_found
**Re-verification:** Yes — after gap-closure plan 07-10 (send-log campaign/flow filter re-apply, closing UAT Test 1)

## What This Pass Covers

The prior `07-VERIFICATION.md` (2026-07-14T07:07:40Z, status `human_needed`, 5/5 ROADMAP success criteria verified) predates plan 07-10. Since then:
- `07-UAT.md` ran and found 1 major gap: after «Сбросить фильтры» in the send log, the campaign filter could not be re-applied in-page (deep-link-only).
- Plan 07-10 closed it: new pure helpers (`send-log-filters.ts`), a persistent «Кампания / цепочка» combobox (`CampaignFlowFilter.tsx`), wired unconditionally into `SendLogPage.tsx`'s toolbar.

This pass (a) re-verifies the 5 ROADMAP success criteria are still intact — a quick regression check, since 07-10 touched only send-log files (confirmed via `git diff --stat` against the 07-10 commits: exactly `send-log-filters.ts`, `send-log-filters.test.ts`, `CampaignFlowFilter.tsx`, `SendLogPage.tsx`) — and (b) does a full 3-level verification of 07-10's own `must_haves`, since this is new work, not a regression.

## Goal Achievement

### ROADMAP Success Criteria (regression check — unaffected by 07-10's scope)

| # | Truth | Status | Evidence |
|---|---|---|---|
| 1 | User views campaign metrics as counts AND percentages (ANLT-01) | ✓ VERIFIED (regression) | `CampaignMetricsSummary.tsx`/`CampaignDetailPage.tsx`/`CampaignProgress.tsx` byte-identical to prior verification pass — confirmed unchanged in `git diff --stat` against 07-10's commits. |
| 2 | User sees per-flow-step metrics (ANLT-02) | ✓ VERIFIED (regression) | `flow-analytics.repository.ts`/`.routes.ts` and `FlowAnalyticsTable.tsx` unchanged; not touched by 07-10. |
| 3 | Contact card timeline unions events/emails/opens/clicks/status changes (ANLT-03) | ✓ VERIFIED (regression) | `timeline.repository.ts`/`ContactEventFeed.tsx` unchanged; not touched by 07-10. |
| 4 | Workspace dashboard shows send/deliver/open trends + contact growth (ANLT-04) | ✓ VERIFIED (regression) | `webhook-events.worker.ts`/`analytics-rollup.ts` unchanged since 07-09's fix; not touched by 07-10. |
| 5 | User browses per-message send log filtered by contact/campaign-or-flow/status/period (ANLT-05) | ✓ VERIFIED, with a scoped defect in the newly-added selector | Core capability (contact/status/period filters, and campaign/flow filtering via URL param) works and the backend is unchanged. The NEW in-page campaign/flow selector added by 07-10 works correctly for the common case (unique names) but has a confirmed selection-ambiguity defect for duplicate-named campaigns/flows — see Gaps below. |

### 07-10 Must-Haves (full verification — new work)

| # | Must-Have Truth | Status | Evidence |
|---|---|---|---|
| 1 | The send-log filter toolbar shows a «Кампания / цепочка» selector at all times, independent of a campaign/flow URL param | ✓ VERIFIED | `SendLogPage.tsx:292`: `<CampaignFlowFilter slug={slug} campaignId={campaignId} flowId={flowId} onSelect={setSendTarget} />` renders unconditionally inside the toolbar `<div>` — not inside any `{campaignId && ...}` guard (unlike the read-only chips at lines 275-290). |
| 2 | Selecting a campaign filters sends to that campaign and writes `?campaign=`; selecting a flow writes `?flow=` and clears `?campaign=` (mutually exclusive) | ✗ FAILED (scoped) | **See Gaps.** `applySendTargetToParams` (send-log-filters.ts:17-40) correctly enforces mutual exclusion and page reset at the URL-param level (9/9 unit tests pass), and `CampaignFlowFilter.tsx`'s `onSelect` handlers correctly call `onSelect({ kind, id })` with the right `id` for the item cmdk resolves as selected — but cmdk resolves the WRONG item when two campaigns/flows share a display name, because `CommandItem value` is keyed by name (line 83/100), not id. Confirmed both `duplicateCampaign` and `duplicateFlow` copy the source name verbatim, so duplicate names are a routine occurrence, not a contrived edge case. |
| 3 | After «Сбросить фильтры», the selector is still available and can re-apply a campaign or flow filter from within the page | ✓ VERIFIED | `resetFilters()` (`SendLogPage.tsx:200-202`) calls `setSearchParams(new URLSearchParams())`, clearing all params — but `CampaignFlowFilter` is rendered unconditionally (must-have #1) and is not gated on `campaignId`/`flowId` being present, so it remains interactive after reset; selecting a target calls `setSendTarget` → `applySendTargetToParams`, which writes fresh `?campaign=`/`?flow=` params directly. This is the exact mechanism that closes UAT Test 1's root cause (previously: `resetFilters()` wiped the ONLY UI path that could set the campaign param, the read-only chip). |
| 4 | «Очистить» in the selector removes the campaign/flow filter param and returns to page 1 | ✓ VERIFIED | `CampaignFlowFilter.tsx:65-77`: the «Очистить» `CommandItem` (shown only when `campaignId \|\| flowId`) calls `onSelect(null)` → `setSendTarget(null)` → `applySendTargetToParams(current, null)` (send-log-filters.ts:23-28), which deletes `campaign`, `flow`, AND `page`. Covered by a dedicated unit test ("deletes both campaign and flow on null target, preserving unrelated params"). |

**Score:** 8/9 truths verified (5 ROADMAP regression + 3 of 4 new 07-10 must-haves), 1 failed (scoped to duplicate-named campaigns/flows)

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `apps/web/src/features/send-log/send-log-filters.ts` | Pure `applySendTargetToParams`/`resolveSendTargetLabel` helpers | ✓ VERIFIED | New, 70 lines, both functions exported, immutable (constructs a fresh `URLSearchParams`), fully covered by 9 unit tests |
| `apps/web/src/features/send-log/__tests__/send-log-filters.test.ts` | Unit test coverage for mutual exclusion, page reset, immutability, label resolution | ✓ VERIFIED | New, 112 lines, 9/9 pass (`npx vitest run src/features/send-log/__tests__/send-log-filters.test.ts`) |
| `apps/web/src/features/send-log/CampaignFlowFilter.tsx` | Persistent searchable Popover+Command combobox | ⚠️ VERIFIED WITH DEFECT | New, 119 lines, correctly wired to TanStack Query (`listCampaigns`/`listFlows` with `EXHAUSTIVE_LOOKUP_PAGE_SIZE`), correct prop shape and rendering — but see WR-02/gap above: `CommandItem value` keyed by name, not id |
| `apps/web/src/features/send-log/SendLogPage.tsx` | Selector wired unconditionally into the toolbar | ✓ VERIFIED | Modified: `setSendTarget` handler added (line 196-198), `<CampaignFlowFilter>` rendered at line 292 (after existing chips, before the status Popover, exactly as the plan specified); existing chips/resetFilters/deep-link untouched (confirmed via diff — only 22 lines changed in this file) |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `CampaignFlowFilter.tsx` `onSelect` | `SendLogPage.tsx` `setSendTarget` | prop callback | ✓ WIRED | `SendLogPage.tsx:292` passes `onSelect={setSendTarget}`; `setSendTarget` (line 196-198) calls `setSearchParams` with `applySendTargetToParams` |
| `setSendTarget` → URL params | `apiParams.campaignOrFlowId` | `campaignOrFlowId = campaignId ?? flowId` (line 130) | ✓ WIRED | Reading `campaign`/`flow` back from `searchParams` after a param write correctly recomputes `campaignOrFlowId`, unchanged from pre-07-10 logic |
| `apiParams.campaignOrFlowId` | `send-log.routes.ts` backend filter | `fetchSendLog` → `GET /api/workspaces/:slug/send-log?campaignOrFlowId=` | ✓ WIRED, unchanged | `send-log.routes.ts` was NOT modified by 07-10 (zero backend changes, per plan's own scope) — confirmed via diff-stat |
| `CampaignFlowFilter.tsx` cmdk `CommandItem` | `onSelect({ kind, id })` correct-id resolution | cmdk internal `value`-keyed selection | ✗ NOT RELIABLY WIRED for duplicate names | See Gaps — the identity key (`value={name}`) is not guaranteed unique, so cmdk's own selection resolution can call the handler for the wrong item |

### Behavioral Spot-Checks / Tests Run (this verification pass)

| Suite | Command | Result | Status |
|---|---|---|---|
| send-log-filters unit tests | `cd apps/web && npx vitest run src/features/send-log/__tests__/send-log-filters.test.ts` | 9/9 passed | ✓ PASS |
| send-log test files (regression) | `npm run test -w apps/web -- send-log` | 1 file, 9/9 passed | ✓ PASS |
| `apps/web` build | `npm run build -w apps/web` | tsc --noEmit + vite build exit 0 | ✓ PASS |
| `duplicateCampaign`/`duplicateFlow` name-copy behavior | Direct code read: `campaign.repository.ts:318-343`, `flow.repository.ts:550-580` | Both copy `existing.name` verbatim into the new row, no suffix | Confirms WR-02's premise — duplicate names are routine |
| cmdk version check | `grep cmdk apps/web/package.json` | `"cmdk": "^1.1.1"` | Confirms the library whose documented `value`-keyed identity model underlies the defect |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|---|---|---|---|---|
| ANLT-01 | 07-03, 07-08 | Campaign metrics as counts + percentages | ✓ SATISFIED (regression) | Unchanged since prior verification pass |
| ANLT-02 | 07-04 | Per-flow-step metrics | ✓ SATISFIED (regression) | Unchanged since prior verification pass |
| ANLT-03 | 07-01, 07-02 | Contact timeline | ✓ SATISFIED (regression) | Unchanged since prior verification pass |
| ANLT-04 | 07-06, 07-07, 07-09 | Workspace dashboard trends + growth | ✓ SATISFIED (regression) | Unchanged since prior verification pass |
| ANLT-05 | 07-05, 07-10 | Per-message send log with contact/campaign-or-flow/status/period filters | ⚠️ SATISFIED WITH A SCOPED GAP | UAT gap (deep-link-only campaign filter) is closed by 07-10 for the common case; a new, narrower gap (duplicate-name selection ambiguity) is introduced by the same plan — see gaps section. |

No orphaned requirements — REQUIREMENTS.md marks all 5 ANLT-* IDs `Complete` for Phase 7 (`.planning/REQUIREMENTS.md:87,178`), matching the plans' declared `requirements` fields (07-01 through 07-10).

### Anti-Patterns Found

No `TBD`/`FIXME`/`XXX`/`TODO`/`HACK`/`PLACEHOLDER` markers in the 4 files touched by plan 07-10.

**New finding this pass (independently confirmed, not merely trusting SUMMARY.md):** `CampaignFlowFilter.tsx` lines 83/100 key cmdk's selection identity by display name rather than id — see the Gaps section for full detail and fix. This was surfaced by the project's own `07-REVIEW.md` (code review dated 2026-07-14T13:03:51Z, after 07-10's execution) as finding **WR-02**, and I independently re-derived and confirmed it by reading `CampaignFlowFilter.tsx`, `campaign.repository.ts`, and `flow.repository.ts` directly rather than taking the review's word for it.

Other pre-existing, non-blocking findings from `07-REVIEW.md` (WR-01, WR-03 through WR-08, IN-01 through IN-09) concern code NOT touched by plan 07-10 (timezone-dependent `::date` casts, unsubscribe-route undercounting, reconciliation-worker error isolation, pagination tiebreakers, fetch-error UI states, contact-timeline truncation, status-history race conditions, duplicated helper functions, dashboard KPI edge cases). These are out of scope for this re-verification pass (which is scoped to 07-10's gap closure) and were not part of 07-10's `must_haves` — they are noted here for traceability but do not affect this pass's status determination. They should be triaged separately (e.g., via `/gsd-plan-phase` follow-up work or accepted as documented tech debt).

### Human Verification Still Recommended (not blocking this pass's status, but outstanding)

1. **07-10 selector interaction, browser-driven, happy path** — Open a `sent`/`canceled` campaign detail page → «Смотреть в журнале отправок» (arrives pre-filtered) → «Сбросить фильтры» → open the «Кампания / цепочка» selector → re-select the same campaign → confirm the log re-filters to that campaign's sends. Then try a flow selection and «Очистить».
   Why human: `07-10-SUMMARY.md`'s own coverage entry (D2) flags this as `human_judgment: true` — the build passing only proves it typechecks and bundles, not that the interaction works as intended in a real browser. This exact sequence was never re-run in `07-UAT.md` (which predates 07-10).
2. **Duplicate-name confirmation** — With two campaigns (or a campaign and a flow) sharing an identical name in the workspace, open the send-log selector and attempt to select the SECOND of the two. Confirm whether the log filters to the correct campaign's sends or silently applies the first one's id (predicted failure mode per the Gaps section).
   Why human: converts the code-level prediction (cmdk `value`-collision) into an empirically observed result before deciding whether to fix immediately or accept as documented debt.

### Gaps Summary

**07-10 successfully closes UAT Test 1 for the common case:** the send-log filter toolbar now has a persistent, always-rendered «Кампания / цепочка» selector that survives «Сбросить фильтры», writes the correct mutually-exclusive `?campaign=`/`?flow=` URL params, and lets a marketer re-apply a campaign or flow filter from within the page without navigating back to campaign/flow detail — the exact root cause identified in `.planning/debug/send-log-campaign-filter-after-reset.md`. All 9 unit tests for the pure filter-mutation logic pass, and the `apps/web` build is clean.

**One gap remains, introduced by the same plan:** `CampaignFlowFilter.tsx` keys cmdk's `CommandItem` selection identity by the campaign/flow's display NAME rather than its id (lines 83, 100). Since `duplicateCampaign`/`duplicateFlow` both copy the source name verbatim (confirmed by reading both repository functions directly), duplicate names are a routine, expected outcome of the app's own "Duplicate" action — not a contrived edge case. When two send-log-selectable entities share a name, cmdk (v1.1.1) can resolve the WRONG item on selection, silently filtering the send log by an incorrect campaign/flow with no error and no visible indication of the mismatch. This was independently confirmed (not taken on the code review's word) by reading the component and both duplication functions directly.

This does not block the phase goal for the common/majority case (unique names), but it is a genuine, reproducible defect in exactly the feature this gap-closure plan added, and it directly threatens the phase's core value proposition of precise per-campaign/per-flow accountability. Recommended next step: apply the review's suggested fix (`value={`${name} ${id}`}` for both campaign and flow items) in a small follow-up plan, or explicitly accept it as a documented, scoped limitation via a VERIFICATION.md override if the team judges the risk acceptable for v1.

---

_Verified: 2026-07-14T18:15:00Z_
_Verifier: Claude (gsd-verifier)_
