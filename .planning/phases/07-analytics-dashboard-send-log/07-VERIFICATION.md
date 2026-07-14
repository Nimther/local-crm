---
phase: 07-analytics-dashboard-send-log
verified: 2026-07-14T07:07:40Z
status: human_needed
score: 5/5 must-haves verified
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 3/5
  gaps_closed:
    - "A user can view campaign metrics as both counts and percentages (ANLT-01, SC1) — CampaignDetailPage's SummaryView now renders the shared CampaignMetricsSummary component (07-08), showing D-01 rate percentages, the D-07 «Пропущено» excluded-reason breakdown, and the D-04 send-log deep link for sent/canceled campaigns, matching CampaignProgress.tsx"
    - "A workspace dashboard shows send/deliver/open trends over a chosen period and contact-base growth (ANLT-04, SC4) — workspace_daily_rollup.opened_count/clicked_count/bounced_count are now written with unique-send semantics by BOTH the incremental webhook path (gated on justSet / isFirstNonDeliveryTerminal, 07-09) and the reconciliation backstop, closing the CR-01 dual-writer oscillation; proven by a new real-Postgres regression test (analytics-rollup-reconciliation-invariant.test.ts) that runs the incremental path then reconciliation and asserts the counts are unchanged"
  gaps_remaining: []
  regressions: []
---

# Phase 7: Analytics, Dashboard & Send Log Verification Report

**Phase Goal:** A marketer can see end-to-end performance — per campaign, per flow step, per contact, and across the whole workspace — down to the status of every individual message.
**Verified:** 2026-07-14T07:07:40Z
**Status:** human_needed
**Re-verification:** Yes — after gap closure (plans 07-08 and 07-09)

## Goal Achievement

### Observable Truths

| # | Truth (ROADMAP Success Criterion) | Status | Evidence |
|---|---|---|---|
| 1 | User views campaign metrics as counts AND percentages (ANLT-01, SC1) | ✓ VERIFIED | Gap closed by 07-08. `apps/web/src/features/campaigns/CampaignDetailPage.tsx`'s `SummaryView` (lines 126-166) now renders `<CampaignMetricsSummary slug={slug} campaignId={campaign.id} .../>` fed by a `staleTime: Infinity` `getCampaignProgress` query, with the `campaign` row's own counters as loading fallback. `CampaignMetricsSummary.tsx` (new, 109 lines) computes `deliveryRate`/`bounceRate`/`openRate`/`clickRate` via `computeRate` (rendered `{rate}%` or «—»), the «Пропущено» excluded breakdown via `bucketExcludedCounts` (extracted to `campaign-metrics.ts`, unit-tested 4/4), and the «Смотреть в журнале отправок» send-log deep link. `CampaignProgress.tsx` (sending view) now delegates to the SAME component — zero duplicated rate/excluded logic between the two views. `npm run test -w apps/web -- campaign-metrics rates`: 2 files, 9/9 pass. `npm run build -w apps/web`: tsc --noEmit + vite build exit 0. |
| 2 | User sees per-flow-step metrics to find underperforming steps (ANLT-02) | ✓ VERIFIED (regression, unchanged since prior verification) | `apps/api/src/modules/analytics/flow-analytics.repository.ts` + `flow-analytics.routes.ts` registered under `registerAnalyticsRoutes`; `FlowAnalyticsTable.tsx` + node-badge wiring unchanged by this gap-closure pass. `npm run test -w apps/api -- flow-node-analytics`: passes (part of the 18/18 regression run below). No files under `apps/api/src/modules/analytics` or `apps/web/src/features/flows` were touched by plans 07-08/07-09 (confirmed via `git diff --stat` against the two gap-closure commits' file lists). |
| 3 | Contact card timeline unions custom events/emails/opens/clicks/status changes (ANLT-03) | ✓ VERIFIED (regression, unchanged since prior verification) | `apps/api/src/modules/analytics/timeline.repository.ts` (UNION ALL) + `ContactEventFeed.tsx` unchanged. `npm run test -w apps/api -- contact-timeline`: passes. Known non-blocking limitation carried forward: `ContactEventFeed.tsx` still doesn't pass the API's `page` param (silently truncates at 50 rows) — unchanged, not in gap-closure scope. |
| 4 | Workspace dashboard shows send/deliver/open trends + contact growth (ANLT-04, SC4) | ✓ VERIFIED | Gap closed by 07-09. The dual-writer conflict (CR-01) is fixed: `webhook-events.worker.ts`'s `open`/`click` cases now gate the `incrementWorkspaceDailyRollup(..., "opened"/"clicked")` call inside `if (justSet)` (lines 276-291, 293-303), matching `delivered`'s existing pattern and `reconcileWorkspaceDay`'s unique-send count. A new `isFirstNonDeliveryTerminal(client, sendId)` helper (lines 156-167) gates the `bounced_count` increment across all four non-delivery-terminal cases (`bounce_hard`, `bounce_soft` streak, `dropped`, `spam_report`) so a send with multiple terminals (e.g. hard bounce + spam report) counts once, matching reconciliation's OR-combined filter — suppression itself stays unconditional. **This is a behavior-dependent (state-consistency invariant) truth** and was upgraded from PRESENT_BEHAVIOR_UNVERIFIED to VERIFIED by running the single named regression test that exercises it directly against real Postgres: `npm run test -w apps/worker -- analytics-rollup-reconciliation-invariant` — both Scenario A (two distinct opens/clicks → `opened_count`/`clicked_count` = 1 before AND after `reconcileWorkspaceDay`) and Scenario B (hard bounce + spam report on the same send → `bounced_count` = 1 before AND after reconcile) pass. Full regression run `npm run test -w apps/worker -- analytics-rollup-reconciliation-invariant analytics-rollup-idempotency webhook-open-click-counts analytics-reconciliation`: 4 files, 13/13 pass (includes `webhook-open-click-counts.test.ts`, byte-for-byte unchanged, still proving `sends.open_count`/`click_count` climb per-event unconditionally). `npm run build -w apps/worker` exits 0. |
| 5 | User browses per-message send log filtered by contact/campaign-or-flow/status/period (ANLT-05) | ✓ VERIFIED (regression, unchanged since prior verification) | `apps/api/src/modules/send-log/send-log.repository.ts` + `send-log.routes.ts` unchanged by this pass. `npm run test -w apps/api -- send-log-filters send-log-drawer`: passes. Known non-blocking limitation carried forward: no unique tie-breaker in the `ORDER BY COALESCE("sentAt","queuedAt") DESC` pagination — unchanged, not in gap-closure scope. |

**Score:** 5/5 truths verified, 0 present-but-behavior-unverified, 0 failed

### Required Artifacts (delta from prior verification)

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `apps/web/src/features/campaigns/campaign-metrics.ts` | Shared `bucketExcludedCounts` util | ✓ VERIFIED | New (07-08), 24 lines, exported, unit-tested 4/4 |
| `apps/web/src/features/campaigns/CampaignMetricsSummary.tsx` | Shared rate/excluded/send-log-link component | ✓ VERIFIED | New (07-08), 109 lines, imported+rendered by both `CampaignDetailPage.tsx` (SummaryView) and `CampaignProgress.tsx` |
| `apps/web/src/features/campaigns/CampaignDetailPage.tsx` | Terminal SummaryView enriched | ✓ VERIFIED | Modified (07-08): `SummaryView` gained `slug` prop, a terminal-status `getCampaignProgress` query (`staleTime: Infinity`), renders `CampaignMetricsSummary` instead of the raw-count `dl` grid |
| `apps/web/src/features/campaigns/CampaignProgress.tsx` | Sending view, DRY'd to shared component | ✓ VERIFIED | Modified (07-08): delegates to `CampaignMetricsSummary`; local `bucketExcludedCounts`/`rateLabel`/`computeRate` derivations removed (`grep -c bucketExcludedCounts` → 0); Progress bar / «отправлено» caption / «ошибок» line preserved |
| `apps/worker/src/queues/webhook-events.worker.ts` | Gated unique-send rollup increments | ✓ VERIFIED | Modified (07-09): `open`/`click` rollup increments moved inside `justSet`; new `isFirstNonDeliveryTerminal` helper gates `bounced_count` across 4 terminal cases; `sends.open_count`/`click_count` per-event counters left unconditional and untouched (outside the `justSet` block, confirmed at line 290/302) |
| `apps/worker/src/queues/__tests__/analytics-rollup-reconciliation-invariant.test.ts` | Dual-writer invariant regression test | ✓ VERIFIED | New (07-09), 208 lines, real-Postgres fixtures, 3/3 tests pass (fixture-timestamp sanity check + Scenario A + Scenario B) |
| `apps/worker/src/queues/__tests__/analytics-rollup-idempotency.test.ts` | Idempotency suite updated for unique-send semantics | ✓ VERIFIED | Modified (07-09): opened/clicked assertions now expect unchanged-at-1 on a distinct repeat (previously asserted climb to 2); still 5/5 pass |

All other Phase 7 artifacts (`timeline.repository.ts`, `flow-analytics.repository.ts`, `send-log.repository.ts`, `dashboard.repository.ts`, `WorkspaceDashboard.tsx`, `workspace-daily-rollup.ts` schema, etc.) are unchanged by plans 07-08/07-09 and were previously verified — confirmed unchanged via `git diff --stat` against the two gap-closure commits, which touched exactly 9 files (5 web files for 07-08, 4 worker files for 07-09).

### Key Link Verification (delta)

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `CampaignDetailPage.tsx` (`SummaryView`) | `getCampaignProgress(slug, campaign.id)` | `useQuery` | ✓ WIRED | Confirmed at line 129-133; response consumed by `CampaignMetricsSummary` props at line 151-162 |
| `CampaignProgress.tsx` (sending view) | `CampaignMetricsSummary` | shared component render | ✓ WIRED | Confirmed at line 68-79; identical prop shape to `SummaryView`'s usage |
| `webhook-events.worker.ts` (open/click cases) | `workspace_daily_rollup.opened_count/clicked_count` | `incrementWorkspaceDailyRollup` inside `if (justSet)` | ✓ WIRED, CONFLICT RESOLVED | Confirmed at lines 276-291 (open), 293-303 (click) — increment now lexically inside `justSet`, matching `delivered`'s structure |
| `webhook-events.worker.ts` (bounce_hard/bounce_soft/dropped/spam_report) | `workspace_daily_rollup.bounced_count` | `incrementWorkspaceDailyRollup` gated on `isFirstNonDeliveryTerminal` | ✓ WIRED, CONFLICT RESOLVED | Confirmed at lines 305-321 (bounce_hard), 323-347 (bounce_soft), 349-372 (dropped), 374-388 (spam_report) — all four gate the rollup+campaign increment on the new helper while leaving `applySuppression` unconditional |
| `analytics-rollup-reconciliation-invariant.test.ts` | `processWebhookEventBatch` + `reconcileWorkspaceDay` | direct function import (real Postgres) | ✓ WIRED | Both writers invoked against the same fixture data within one test, proving agreement |

### Behavioral Spot-Checks / Tests Run (this verification pass)

| Suite | Command | Result | Status |
|---|---|---|---|
| Campaign metrics util + rates (07-08) | `npm run test -w apps/web -- campaign-metrics rates` | 2 files, 9/9 passed | ✓ PASS |
| `apps/web` build | `npm run build -w apps/web` | tsc --noEmit + vite build exit 0 | ✓ PASS |
| Rollup dual-writer invariant + idempotency + open/click counts + reconciliation (07-09) | `npm run test -w apps/worker -- analytics-rollup-reconciliation-invariant analytics-rollup-idempotency webhook-open-click-counts analytics-reconciliation` | 4 files, 13/13 passed | ✓ PASS |
| `apps/worker` build | `npm run build -w apps/worker` | tsc exit 0 | ✓ PASS |
| Regression: contact-timeline, flow-node-analytics, dashboard, send-log-filters, send-log-drawer (unmodified truths) | `npm run test -w apps/api -- contact-timeline flow-node-analytics dashboard send-log-filters send-log-drawer` | 5 files, 18/18 passed | ✓ PASS |

The dual-write invariant test (`analytics-rollup-reconciliation-invariant.test.ts`) is the direct behavioral proof for the previously-behavior-unverified truth #4: it runs `processWebhookEventBatch` (incremental path) then `reconcileWorkspaceDay` (backstop) against the SAME real-Postgres fixture data and asserts the counts are byte-identical before and after — exactly the invariant the schema comment claims ("Maintained two ways that must never conflict") and that neither writer's own isolated test previously covered.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|---|---|---|---|---|
| ANLT-01 | 07-03, 07-08 | Campaign metrics as counts + percentages | ✓ SATISFIED | Live/list views (07-03) AND terminal (`sent`/`canceled`) SummaryView (07-08) both enriched via the shared `CampaignMetricsSummary`; tests pass, build clean |
| ANLT-02 | 07-04 | Per-flow-step metrics | ✓ SATISFIED | Unchanged since prior verification; endpoint + table + canvas badges verified, tests pass |
| ANLT-03 | 07-01, 07-02 | Contact timeline | ✓ SATISFIED | Unchanged since prior verification; endpoint + UI verified, tests pass; pagination limitation noted (non-blocking) |
| ANLT-04 | 07-06, 07-07, 07-09 | Workspace dashboard trends + growth | ✓ SATISFIED | Endpoint + UI (07-06/07-07) verified as before; dual-writer semantics conflict (CR-01) closed by 07-09, proven by a real-Postgres regression test |
| ANLT-05 | 07-05 | Per-message send log | ✓ SATISFIED | Unchanged since prior verification; endpoint + UI verified, tests pass; pagination tie-breaker limitation noted (non-blocking) |

No orphaned requirements — REQUIREMENTS.md marks all 5 ANLT-* IDs `Complete` for Phase 7, matching the plans' declared `requirements` fields (07-01 through 07-09).

### Anti-Patterns Found

No `TBD`/`FIXME`/`XXX`/`TODO`/`HACK`/`PLACEHOLDER` markers found in the 6 files touched by the two gap-closure plans (`CampaignDetailPage.tsx`, `CampaignMetricsSummary.tsx`, `CampaignProgress.tsx`, `campaign-metrics.ts`, `webhook-events.worker.ts`, `analytics-rollup.ts`).

Previously-flagged non-blocking review findings (WR-03, WR-05, WR-06, IN-01 from 07-REVIEW.md) are outside the scope of plans 07-08/07-09 and remain present, unchanged:
- **WR-03** (unchanged): `send-log.repository.ts` pagination has no unique tie-breaker.
- **WR-05** (unchanged): `ContactEventFeed.tsx` doesn't pass the API's `page` param — timeline truncates at 50 rows.
- **WR-06** (unchanged): no `isError` handling in `SendLogPage.tsx`/`SendLogRowDrawer.tsx`/`ContactEventFeed.tsx` — fetch failure renders as empty-data, not an error state.
- **IN-01** (unchanged): `computeRate` imported but unused in `WorkspaceDashboard.tsx` (confirmed still present at line 10).

None of these block the phase goal (all are documented as non-blocking limitations in the prior verification and were not in either gap-closure plan's scope).

### Human Verification Required

1. **Terminal-campaign metrics visual confirmation** — Open a `sent`/`canceled` campaign's detail page and visually confirm the delivered/open/click/bounce rate percentages, the «Пропущено» breakdown, and the send-log link render correctly and legibly.
   Expected: Percentages next to each counter, «Пропущено: N» with sub-lines when applicable, and a working «Смотреть в журнале отправок» link.
   Why human: Code-level evidence (grep proofs, unit tests, clean build) proves the component renders these values, but visual layout/legibility on a real campaign needs a human eye. (Carried from 07-08-SUMMARY.md D2's own `human_judgment: true`.)

2. **Visual/layout checks** carried from 07-02/07-03/07-04/07-07 SUMMARYs — rate rendering, badge placement/tooltip legibility on the flow canvas at various zoom levels, chart legend/palette rendering, KPI card layout.
   Why human: Flagged as visual/layout items not exercised by an automated screenshot check; carried to end-of-phase UAT per `human_verify_mode: end-of-phase`.

Note: the previously-listed "watch the dashboard's Открыто KPI across two reconciliation ticks" item is no longer required as a blocking human check — the underlying dual-writer invariant is now proven directly by a real-Postgres regression test (`analytics-rollup-reconciliation-invariant.test.ts`) that exercises the exact same code paths (`processWebhookEventBatch` then `reconcileWorkspaceDay`) the live dashboard depends on, which is stronger evidence than a timing-dependent visual observation. A live look at the dashboard remains a reasonable optional sanity check during end-of-phase UAT but does not block phase completion.

### Gaps Summary

No gaps remain. Both gaps identified in the prior verification (2026-07-14T03:36:29Z) have been closed and independently re-verified in this codebase pass, not merely accepted on SUMMARY.md's word:

1. **Campaign metrics (ANLT-01, SC1):** closed by plan 07-08. Read `CampaignDetailPage.tsx`, `CampaignMetricsSummary.tsx`, `CampaignProgress.tsx`, and `campaign-metrics.ts` directly — the terminal `SummaryView` now renders the same rate/excluded-breakdown/send-log-link component the in-progress view uses. Ran `npm run test -w apps/web -- campaign-metrics rates` (9/9 pass) and `npm run build -w apps/web` (clean).

2. **Workspace dashboard trends (ANLT-04, SC4 / CR-01):** closed by plan 07-09. Read `webhook-events.worker.ts` directly — `open`/`click` rollup increments are now gated on `justSet`, and a new `isFirstNonDeliveryTerminal` helper gates `bounced_count` across all four non-delivery-terminal cases. Ran the actual regression test (`analytics-rollup-reconciliation-invariant.test.ts`, 3/3 pass) that runs the incremental path then the reconciliation backstop against the same fixture data and asserts the counts are unchanged — direct behavioral proof of the invariant, not just code presence.

All five ROADMAP success criteria are now met at the code level. Two non-blocking visual/UAT items remain, carried to end-of-phase human verification per `human_verify_mode: end-of-phase` — these were flagged as such in the prior verification and in the plans' own SUMMARYs, not new findings from this pass.

---

_Verified: 2026-07-14T07:07:40Z_
_Verifier: Claude (gsd-verifier)_
