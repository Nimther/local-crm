---
phase: 07-analytics-dashboard-send-log
verified: 2026-07-14T03:36:29Z
status: gaps_found
score: 3/5 must-haves verified
behavior_unverified: 0
overrides_applied: 0
gaps:
  - truth: "A user can view campaign metrics — sent / delivered / opened / clicked / bounced / unsubscribed — as both counts and percentages (ANLT-01, SC1)"
    status: partial
    reason: >
      The D-01 rate-percentage enrichment (07-03) was applied ONLY to CampaignProgress.tsx
      (the live "sending"-status view) and CampaignsListPage.tsx. CampaignDetailPage's
      SummaryView — the component rendered for a campaign whose status is `sent` or
      `canceled` (the terminal state every campaign eventually reaches, and the state a
      marketer is most likely to be reviewing after a campaign finishes) — was left
      untouched. Verified directly in apps/web/src/features/campaigns/CampaignDetailPage.tsx
      lines 114-162: SummaryView renders raw counts only (Доставлено/Открытий/Кликов/Не
      доставлено/Отписалось) with zero percentages, no «Пропущено» excluded-reason
      breakdown, and no send-log deep link. The plan's own 07-03-SUMMARY.md documented this
      exact gap as a "Scope Note...flagged for phase UAT" but it was never closed by a later
      plan in this phase, and Phase 7 is the last analytics phase in ROADMAP.md (nothing to
      defer to).
    artifacts:
      - path: "apps/web/src/features/campaigns/CampaignDetailPage.tsx"
        issue: "SummaryView (rendered for status sent/canceled, lines 114-162) shows only raw counts — no computeRate percentages, no excluded breakdown, no send-log link, unlike the sibling CampaignProgress.tsx component that plan 07-03 enriched"
    missing:
      - "Extend SummaryView (or replace its rendering with CampaignProgress-style output) to show D-01 rate percentages (delivered/open/click/bounce %), the «Пропущено» excluded-reason breakdown, and the «Смотреть в журнале отправок» deep link for sent/canceled campaigns — the same enrichment CampaignProgress.tsx already has for in-progress campaigns"
  - truth: "A workspace dashboard shows send / deliver / open trends over a chosen period and contact-base growth (ANLT-04, SC4)"
    status: partial
    reason: >
      workspace_daily_rollup.opened_count/clicked_count are written by two paths with
      conflicting semantics, verified directly in code: the incremental webhook path
      (apps/worker/src/queues/webhook-events.worker.ts, open/click cases) increments the
      rollup on EVERY genuinely-new open/click event (repeat-event count, explicitly not
      gated by justSet — comment: "mirrors sends.open_count -- climbs on every genuinely-new
      open, not gated by justSet"), while the reconciliation worker
      (apps/worker/src/queues/analytics-reconciliation.worker.ts's reconcileWorkspaceDay,
      lines 34-63) OVERWRITES the same row every ~3 minutes with
      count(*) FILTER (WHERE first_opened_at::date = day) — a unique-send-first-opened
      count. A send opened 5 times today shows opened_count=5 immediately, then gets
      silently rewritten to 1 within 3 minutes; a cross-day repeat open increments today's
      count and is then permanently zeroed by the next reconciliation tick. The dashboard's
      TrendChart/KPI "Открыто" values are read directly from this table
      (dashboard.repository.ts's trend query), so the displayed open trend is not a stable,
      correct number — it oscillates by design of the current write-path conflict. A second
      instance of the same class of bug: a send that both hard-bounces and gets a spam
      report increments bounced_count twice via the incremental path's two separate justSet
      gates, but the reconciliation's OR-combined filter counts it once — same oscillation.
      This is the same defect independently identified as CR-01 (Critical) in
      07-REVIEW.md, confirmed here by direct code inspection rather than trusting the
      review's claim.
    artifacts:
      - path: "apps/worker/src/queues/webhook-events.worker.ts"
        issue: "open/click cases (~248-268) increment workspace_daily_rollup.opened_count/clicked_count on every genuinely-new event (repeat-event semantics)"
      - path: "apps/worker/src/queues/analytics-reconciliation.worker.ts"
        issue: "reconcileWorkspaceDay (~34-63) overwrites the same columns with a unique-first-open/click count every 3 minutes (DO UPDATE SET ... = EXCLUDED...), clobbering the incremental path's repeat-event values"
      - path: "apps/api/src/modules/analytics/dashboard.repository.ts"
        issue: "trend series reads opened/delivered counts directly from workspace_daily_rollup with no awareness of the conflicting semantics"
    missing:
      - "Pick one semantic for opened_count/clicked_count (unique-send matches the reconciliation backstop, the campaign counters, and keeps rates <=100% — the cheaper fix per 07-REVIEW.md's CR-01): gate the incremental rollup increment on justSet exactly like the delivered case, keeping sends.open_count/click_count's own unconditional per-event increment untouched"
      - "Add a regression test that runs reconcileWorkspaceDay after the incremental-increment test scenario and asserts the rollup counts are unchanged — the dual-write invariant the table's own schema comment claims ('Maintained two ways that must never conflict') is currently untested"
      - "Resolve the same bounced_count double-count vs single-count discrepancy between the two write paths (hard bounce + spam report on the same send)"
human_verification:
  - test: "Open a sent (terminal-status) campaign's detail page and visually confirm whether rate percentages are shown"
    expected: "Percentages should render next to each counter (currently absent per the gap above — included here so a human can confirm the visual before any fix)"
    why_human: "Confirms the code-level finding renders as described in the live UI"
  - test: "Watch a workspace dashboard's 'Открыто' KPI/trend value across two reconciliation ticks (~6+ minutes) while a send is opened multiple times"
    expected: "The value should stay stable and reflect a single, well-defined metric"
    why_human: "The oscillation is a timing-dependent runtime behavior that a snapshot code review can describe but not directly observe running"
  - test: "Render CampaignProgress, FlowAnalyticsTable, the flow-canvas node badges, and the WorkspaceDashboard charts in the browser at realistic data volumes"
    expected: "Rates, badges, tooltips, and charts are legible, correctly formatted (tabular-nums, «—» on null rate, fixed chart palette/legend order), and layouts hold at various zoom levels"
    why_human: "Flagged by 07-02/07-03/07-04/07-07 SUMMARYs as visual/layout items not exercised by an automated screenshot check; carried to end-of-phase UAT per human_verify_mode: end-of-phase"
---

# Phase 7: Analytics, Dashboard & Send Log Verification Report

**Phase Goal:** A marketer can see end-to-end performance — per campaign, per flow step, per contact, and across the whole workspace — down to the status of every individual message.
**Verified:** 2026-07-14T03:36:29Z
**Status:** gaps_found
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth (ROADMAP Success Criterion) | Status | Evidence |
|---|---|---|---|
| 1 | User views campaign metrics as counts AND percentages (ANLT-01) | ✗ FAILED (partial) | `apps/web/src/features/campaigns/CampaignProgress.tsx` + `CampaignsListPage.tsx` correctly show D-01 rates (verified: `computeRate` used 4x+, «Пропущено» row, send-log link, all grep- and code-confirmed). But `CampaignDetailPage.tsx`'s `SummaryView` (rendered for `sent`/`canceled` campaigns — the terminal, most-viewed state) shows raw counts only, confirmed by direct code read (lines 114-162) — no rates, no excluded breakdown, no send-log link |
| 2 | User sees per-flow-step metrics to find underperforming steps (ANLT-02) | ✓ VERIFIED | `apps/api/src/modules/analytics/flow-analytics.repository.ts` + `flow-analytics.routes.ts` exist, registered under `registerAnalyticsRoutes`; `COUNT(DISTINCT` confirmed in repo; `FlowAnalyticsTable.tsx` + `nodeTypes.tsx` metrics badge confirmed; `npm run test -w apps/api -- flow-node-analytics` passes (part of the 10/10 run covering contact-timeline+flow-node-analytics+dashboard) |
| 3 | Contact card timeline unions custom events/emails/opens/clicks/status changes (ANLT-03) | ✓ VERIFIED | `apps/api/src/modules/analytics/timeline.repository.ts` (UNION ALL over events/sends/subscription_status_history/flow_runs) + `ContactEventFeed.tsx` confirmed; test passes. Note: pagination is present in the API (`page` param) but `ContactEventFeed.tsx` never passes it and shows no "load more" — silently truncates at 50 rows for prolific contacts (07-REVIEW.md WR-05, confirmed here by grep: no `page` usage in ContactEventFeed.tsx). Not severe enough to fail the core truth (a timeline IS shown); flagged as a known limitation, not a blocker |
| 4 | Workspace dashboard shows send/deliver/open trends + contact growth (ANLT-04) | ✗ FAILED (partial) | `apps/api/src/modules/analytics/dashboard.repository.ts` + `WorkspaceDashboard.tsx`/`TrendChart.tsx`/`GrowthChart.tsx` exist, wired as the `/w/:slug` index route, tests pass, palette hex values confirmed, build clean. BUT the "Открыто"/"opened" trend and KPI values are unreliable: `workspace_daily_rollup.opened_count`/`clicked_count` are written with two conflicting semantics by the incremental webhook path vs. the every-3-minute reconciliation overwrite (see gap below), confirmed by direct inspection of both `webhook-events.worker.ts` and `analytics-reconciliation.worker.ts` |
| 5 | User browses per-message send log filtered by contact/campaign-or-flow/status/period (ANLT-05) | ✓ VERIFIED | `apps/api/src/modules/send-log/send-log.repository.ts` + `send-log.routes.ts` registered in `server.ts`; `SendLogPage.tsx` + `SendLogRowDrawer.tsx` wired into `AppShell.tsx`/`App.tsx`; all 13 API tests pass. Note: `ORDER BY COALESCE("sentAt","queuedAt") DESC LIMIT/OFFSET` has no unique tie-breaker (confirmed at line 168-169) — rows can repeat/vanish across pages for same-instant broadcast batches (07-REVIEW.md WR-03). Core browse/filter truth holds; flagged as a known limitation, not a blocker |

**Score:** 3/5 truths verified, 0 present-but-behavior-unverified, 2 failed (partial)

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `packages/db/src/schema/subscription-status-history.ts` | Audit table schema | ✓ VERIFIED | 31 lines, exists, builds clean |
| `packages/db/migrations/0036_analytics_status_history_counts.sql` | Migration for history table + sends counters | ✓ VERIFIED | Exists; journal idx 36 registered |
| `packages/contacts-core/src/subscription-status-history.ts` | `recordSubscriptionStatusChange` helper | ✓ VERIFIED | Exists, exported per index.ts |
| `apps/api/src/modules/analytics/timeline.repository.ts` | Contact timeline UNION query | ✓ VERIFIED | 125 lines, exists, test passes |
| `apps/api/src/modules/analytics/timeline.routes.ts` | Timeline route + IDOR gate | ✓ VERIFIED | Registered under `registerAnalyticsRoutes` |
| `apps/web/src/lib/rates.ts` | Shared `computeRate` helper | ✓ VERIFIED | 10 lines, unit-tested (5/5 pass) |
| `apps/api/src/modules/analytics/flow-analytics.repository.ts` | Per-node flow analytics | ✓ VERIFIED | 101 lines, `COUNT(DISTINCT` confirmed |
| `apps/web/src/features/flows/detail/FlowAnalyticsTable.tsx` | «Аналитика» comparison tab | ✓ VERIFIED | 197 lines, exists |
| `apps/api/src/modules/send-log/send-log.repository.ts` | Filtered send-log list + drawer read | ✓ VERIFIED | 222 lines, tests pass (8/8) |
| `apps/web/src/features/send-log/SendLogPage.tsx` | «Журнал отправок» page | ✓ VERIFIED | 417 lines, nav+route wired |
| `apps/web/src/features/send-log/SendLogRowDrawer.tsx` | Per-message drawer (shadcn sheet) | ✓ VERIFIED | 144 lines, exists |
| `apps/api/src/modules/analytics/dashboard.repository.ts` | Rollup-backed dashboard read | ⚠️ HOLLOW (partial) | Exists, wired, tests pass, but reads an `opened_count`/`clicked_count` source with conflicting write semantics (see gap) |
| `apps/web/src/features/dashboard/WorkspaceDashboard.tsx` | Workspace index dashboard | ✓ VERIFIED (data quality caveat) | 221 lines, is the `/w/:slug` index route, `OnboardingChecklist` preserved, empty-state copy present |
| `packages/db/src/schema/workspace-daily-rollup.ts` | Per-workspace-per-day rollup table | ✓ VERIFIED (schema); ⚠️ dual-writer semantics conflict | 40 lines, exists, migration 0037 registered (journal idx 37) |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `apps/api/src/server.ts` | `registerAnalyticsRoutes` | `app.register(...)` | ✓ WIRED | Confirmed at server.ts:93 |
| `apps/api/src/server.ts` | `registerSendLogRoutes` | `app.register(...)` | ✓ WIRED | Confirmed at server.ts:94 |
| `analytics/index.ts` | timeline/flow-analytics/dashboard routes | aggregator | ✓ WIRED | All three `register*Routes` called from one aggregator |
| `apps/web/src/App.tsx` | `WorkspaceDashboard` | index route | ✓ WIRED | `<Route index element={<WorkspaceDashboard />} />` |
| `apps/web/src/App.tsx` | `SendLogPage` | `/send-log` route | ✓ WIRED | Confirmed |
| `apps/web/src/features/app-shell/AppShell.tsx` | send-log nav | NavLink | ✓ WIRED | «Журнал отправок» confirmed |
| `webhook-events.worker.ts` (open/click) | `workspace_daily_rollup.opened_count/clicked_count` | `incrementWorkspaceDailyRollup` | ⚠️ CONFLICTING | Wired, but writes repeat-event semantics that the reconciliation path's overwrite later contradicts |
| `analytics-reconciliation.worker.ts` | `workspace_daily_rollup` | `reconcileWorkspaceDay` overwrite | ⚠️ CONFLICTING | Wired (registered in `apps/worker/src/server.ts`), correctly non-additive, but computes a different metric definition than the incremental path for opened/clicked |

### Behavioral Spot-Checks / Tests Run

| Suite | Command | Result | Status |
|---|---|---|---|
| Contact timeline / flow-node-analytics / dashboard | `npm run test -w apps/api -- contact-timeline flow-node-analytics dashboard` | 3 files, 10/10 tests passed | ✓ PASS |
| Send-log filters / drawer / subscription-history / campaign-excluded-breakdown | `npm run test -w apps/api -- send-log-filters send-log-drawer subscription-status-history campaign-excluded-breakdown` | 4 files, 13/13 tests passed | ✓ PASS |
| rates.ts unit tests | `npm run test -w apps/web -- rates` | 1 file, 5/5 tests passed | ✓ PASS |
| Rollup idempotency | `npm run test -w apps/worker -- analytics-rollup-idempotency` | 1 file, 5/5 tests passed | ✓ PASS |
| Rollup reconciliation + tenant-isolation + open/click counts | `npm run test -w apps/worker -- analytics-reconciliation analytics-rollup-tenant-isolation webhook-open-click-counts` | 3 files, 6/6 tests passed | ✓ PASS |
| `packages/db` build | `npm run build -w packages/db` | exit 0 | ✓ PASS |
| `apps/api` build | `npm run build -w apps/api` | exit 0 | ✓ PASS |
| `apps/web` build | `npm run build -w apps/web` | exit 0 (vite build succeeded) | ✓ PASS |
| `apps/worker` build | `npm run build -w apps/worker` | exit 0 | ✓ PASS |

All Phase 7 test suites pass individually — this is exactly why CR-01 (the rollup semantics conflict) shipped: each writer's test asserts only its own semantics in isolation (`analytics-rollup-idempotency.test.ts` asserts repeat-event incrementing; `analytics-reconciliation.test.ts` asserts unique-send overwrite), and no test exercises both writers against the same data, so the contradiction between them was never caught by CI. Confirmed by reading both test files' assertions directly.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|---|---|---|---|---|
| ANLT-01 | 07-03 | Campaign metrics as counts + percentages | ⚠️ PARTIAL | Live/list views enriched; terminal-state (`sent`/`canceled`) `SummaryView` not enriched — see gap |
| ANLT-02 | 07-04 | Per-flow-step metrics | ✓ SATISFIED | Endpoint + table + canvas badges verified, tests pass |
| ANLT-03 | 07-01, 07-02 | Contact timeline | ✓ SATISFIED | Endpoint + UI verified, tests pass; pagination limitation noted (non-blocking) |
| ANLT-04 | 07-06, 07-07 | Workspace dashboard trends + growth | ⚠️ PARTIAL | Endpoint + UI + rollup infra verified; opened/clicked trend values unreliable due to dual-writer semantics conflict — see gap |
| ANLT-05 | 07-05 | Per-message send log | ✓ SATISFIED | Endpoint + UI verified, tests pass; pagination tie-breaker limitation noted (non-blocking) |

No orphaned requirements — all 5 ANLT-* IDs declared across plans 07-01 through 07-07 match REQUIREMENTS.md's Phase 7 mapping exactly.

### Anti-Patterns Found

No `TBD`/`FIXME`/`XXX`/`TODO`/`HACK`/`PLACEHOLDER` markers found in the phase's key files (checked 22 files spanning all 7 plans' artifacts).

The independently-run 07-REVIEW.md (code review, not this verification) additionally documents 8 warnings and 7 info-level findings beyond the two truths this verification classifies as gaps above (CR-01 = this verification's gap #2). Spot-checked and confirmed directly in code during this verification:

- **WR-03** (confirmed): `send-log.repository.ts:168-169` — `ORDER BY COALESCE("sentAt","queuedAt") DESC LIMIT/OFFSET` has no unique tie-breaker.
- **WR-05** (confirmed): `ContactEventFeed.tsx` never sends the `page` query param the API supports; no "load more" control — timeline silently truncates at 50 rows.
- **WR-06** (confirmed): `grep -n "isError"` returns zero matches in `SendLogPage.tsx`, `SendLogRowDrawer.tsx`, and `ContactEventFeed.tsx` — a fetch failure renders as an empty-data state, not an error state.
- **IN-01** (confirmed): `computeRate` imported but unused in `WorkspaceDashboard.tsx` line 10.

The remaining review findings (WR-01, WR-02, WR-04, WR-07, WR-08, IN-02 through IN-07) were not independently re-verified line-by-line in this pass but are consistent with the codebase's structure observed during this verification and are not disputed.

### Human Verification Required

1. **Terminal-campaign metrics view** — Open a `sent` or `canceled` campaign's detail page and confirm whether/how much this gap is noticed by an actual user (expected: percentages should be visible; currently they are not).
2. **Dashboard open-metric stability** — Watch the workspace dashboard's "Открыто" KPI/trend across two-plus reconciliation cycles (~6+ minutes) while generating repeat opens, to observe the oscillation directly.
3. **Visual/layout checks** carried from 07-02/07-03/07-04/07-07 SUMMARYs (rate rendering, badge placement/tooltip legibility on the flow canvas at various zoom levels, chart legend/palette rendering, KPI card layout) — deferred to end-of-phase UAT per `human_verify_mode: end-of-phase`, not independently re-checked pixel-by-pixel here.

### Gaps Summary

Two of the five ROADMAP success criteria are not fully met by the current codebase, both confirmed by direct code inspection (not by trusting SUMMARY.md or REVIEW.md claims alone):

1. **Campaign metrics (ANLT-01):** the D-01 rate-percentage/excluded-breakdown/send-log-link enrichment built in plan 07-03 only reaches `CampaignProgress.tsx` (in-progress campaigns) and `CampaignsListPage.tsx`, not `CampaignDetailPage.tsx`'s `SummaryView` — the view shown once a campaign finishes sending (`sent`/`canceled`), which is the state most campaigns spend the vast majority of their lifetime in. A marketer reviewing a completed campaign sees raw counts only, never percentages.

2. **Workspace dashboard trends (ANLT-04):** `workspace_daily_rollup`'s `opened_count`/`clicked_count` columns are written with two structurally different, unreconciled definitions by the incremental webhook path (repeat-event count) and the periodic reconciliation overwrite (unique-first-open count), which runs every 3 minutes and always wins. The dashboard's "Открыто" trend/KPI is therefore not a stable, well-defined number — it silently and repeatedly changes underneath the user. This was independently flagged as a Critical finding (CR-01) in the phase's own code review and is confirmed here by directly reading both write paths.

Everything else — flow-step analytics (ANLT-02), the contact timeline (ANLT-03), and the send log (ANLT-05) — is genuinely built, wired, and test-covered, with only non-blocking pagination/error-handling limitations noted for follow-up.

---

_Verified: 2026-07-14T03:36:29Z_
_Verifier: Claude (gsd-verifier)_
