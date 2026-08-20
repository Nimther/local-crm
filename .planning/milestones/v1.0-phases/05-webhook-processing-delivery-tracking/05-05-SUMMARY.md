---
phase: 05-webhook-processing-delivery-tracking
plan: 05
subsystem: ui
tags: [fastify, react, tanstack-query, campaigns, webhooks]

# Dependency graph
requires:
  - phase: 05-webhook-processing-delivery-tracking (05-03)
    provides: "campaigns delivery counters (delivered_count/opened_count/clicked_count/bounced_count/unsubscribed_count) written by the webhook worker"
  - phase: 05-webhook-processing-delivery-tracking (05-04)
    provides: "GET /api/workspaces/:slug/webhook-health + POST /api/workspaces/:slug/webhook-reconnect authenticated routes, WebhookHealthResponse contract"
provides:
  - "campaign progress/detail responses carry deliveredCount/openedCount/clickedCount/bouncedCount/unsubscribedCount"
  - "apps/web/src/features/webhooks/webhook-health.api.ts (getWebhookHealth, reconnectWebhook)"
  - "WebhookHealthCard on the SendGrid settings page (connected/pending/error + last-event relative time + Reconnect)"
  - "OnboardingChecklist 'Включить отслеживание доставки' item"
affects: [delivery-tracking-ui, campaign-metrics, onboarding]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Shared TanStack Query key [\"workspace\", slug, \"webhook-health\"] used identically by SendGridKeySettings and OnboardingChecklist so a reconnect-triggered invalidation refreshes both surfaces"
    - "Duplicated Intl.RelativeTimeFormat('ru') relativeTime helper in SendGridKeySettings.tsx, mirroring ContactEventFeed.tsx's established pattern rather than extracting a shared util (matches this codebase's existing per-file mirroring convention)"

key-files:
  created:
    - apps/web/src/features/webhooks/webhook-health.api.ts
    - apps/api/src/modules/campaigns/__tests__/campaign-delivery-counters.test.ts
  modified:
    - apps/api/src/modules/campaigns/campaign.repository.ts
    - apps/api/src/modules/campaigns/campaigns.routes.ts
    - apps/web/src/features/campaigns/api.ts
    - apps/web/src/features/campaigns/CampaignProgress.tsx
    - apps/web/src/features/campaigns/CampaignDetailPage.tsx
    - apps/web/src/features/sendgrid-key/SendGridKeySettings.tsx
    - apps/web/src/features/onboarding/OnboardingChecklist.tsx

key-decisions:
  - "webhook-health badge status maps connected->active, provisionStatus==='error'->error, everything else (pending/never-provisioned)->pending -- since the 05-04 API already collapses connected to exactly provisionStatus==='active', this needed no new server contract"
  - "Onboarding checklist's webhook-tracking done-state is Boolean(connected && provisionStatus==='active') even though connected alone is equivalent per the API -- kept both checks explicit to match the plan's literal must_haves wording and stay resilient if the API contract ever decouples the two fields"
  - "No new shared component extracted for the five-counter row -- duplicated the same <dl> markup in CampaignProgress.tsx (sending view) and CampaignDetailPage.tsx's SummaryView (sent/canceled view), matching the plan's exact files_modified list and this codebase's existing per-view duplication precedent (e.g. relativeTime)"

patterns-established: []

requirements-completed: [WBHK-04]

coverage:
  - id: D1
    description: "Campaign progress and campaign detail API responses carry deliveredCount/openedCount/clickedCount/bouncedCount/unsubscribedCount sourced from the campaigns row"
    requirement: "WBHK-04"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/campaigns/__tests__/campaign-delivery-counters.test.ts#progress endpoint returns delivered/opened/clicked/bounced/unsubscribed counters"
        status: pass
    human_judgment: false
  - id: D2
    description: "Campaign summary/progress UI (CampaignProgress.tsx sending view, CampaignDetailPage.tsx SummaryView) renders delivered/opened/clicked/не доставлено/unsubscribed as counts"
    requirement: "WBHK-04"
    verification:
      - kind: other
        ref: "npm run build -w apps/web type-checks clean against the extended CampaignProgress/CampaignResponse types; both components render the five-counter <dl> reading the new fields"
        status: pass
    human_judgment: true
    rationale: "Visual rendering of the counter row against a real sending/sent campaign requires live browser verification -- deferred to phase-level UAT (human_verify_mode: end-of-phase, Phase 1-4 precedent)."
  - id: D3
    description: "SendGrid settings page shows a webhook connected/disconnected indicator, last-event-received relative time, and a working Reconnect button for Owner/Admin"
    verification:
      - kind: other
        ref: "npm run build -w apps/web type-checks clean; webhook-health.api.ts exports getWebhookHealth/reconnectWebhook typed with WebhookHealthResponse; WebhookHealthCard gated behind status?.connected and canManage"
        status: pass
    human_judgment: true
    rationale: "Requires a live SendGrid key connect + a real signed webhook event to observe the connected badge and non-null last-event time in the browser -- deferred to phase-level UAT per the plan's own <verify> human-check."
  - id: D4
    description: "Onboarding checklist shows 'Включить отслеживание доставки' reflecting webhook-health connected state, deep-linking to SendGrid settings when incomplete"
    requirement: "WBHK-04"
    verification:
      - kind: other
        ref: "npm run build -w apps/web type-checks clean; OnboardingChecklist.tsx buildItems includes the webhook-tracking item with done: Boolean(connected && provisionStatus==='active') and href to /w/:slug/settings/sendgrid"
        status: pass
    human_judgment: true
    rationale: "Confirming an already-connected workspace sees the item and it flips to done after a live reconnect requires browser verification -- deferred to phase-level UAT per the plan's own <verify> human-check."

duration: 20min
completed: 2026-07-08
status: complete
---

# Phase 5 Plan 5: Campaign Delivery Counters + Webhook Health UI Summary

**Three thin UI slices surfacing the send loop's closure: campaign progress/detail now carries delivered/opened/clicked/не доставлено/unsubscribed counters (D-07/D-08/D-09), the SendGrid settings page gained a webhook connected/disconnected + last-event-time + Reconnect card (D-03), and the onboarding checklist gained an "Включить отслеживание доставки" item for already-connected workspaces (D-02).**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-07-08T14:53:48Z
- **Completed:** 2026-07-08T15:02:21Z
- **Tasks:** 3
- **Files modified:** 9

## Accomplishments

- `campaign.repository.ts`'s `CampaignRow` and `CampaignProgress` interfaces, `CAMPAIGN_COLUMNS`, and `getCampaignProgress` now carry `deliveredCount`/`openedCount`/`clickedCount`/`bouncedCount`/`unsubscribedCount`, sourced straight from the `campaigns` row columns the 05-03 webhook worker writes exactly-once. `campaigns.routes.ts`'s `toCampaignResponse` carries the same five fields, so both `GET .../campaigns/:id/progress` and `GET .../campaigns/:id` expose them.
- `apps/web/src/features/campaigns/api.ts`'s `CampaignResponse`/`CampaignProgress` types extended to match; `CampaignProgress.tsx` (live sending view) and `CampaignDetailPage.tsx`'s `SummaryView` (sent/canceled view) each render a compact Доставлено/Открытий/Кликов/Не доставлено/Отписалось counter row beneath the existing progress bar or sent/failed/excluded summary.
- New `apps/web/src/features/webhooks/webhook-health.api.ts` (`getWebhookHealth`, `reconnectWebhook`) wraps the 05-04 `GET webhook-health`/`POST webhook-reconnect` routes. `SendGridKeySettings.tsx` gained a `WebhookHealthCard`, rendered once a SendGrid key is connected: a connected/pending/error `KeyStatusBadge`, "Последнее событие получено: {relative time}" (or "События ещё не поступали"), and — for Owner/Admin only — a Переподключить/Включить отслеживание доставки button that invalidates the `["workspace", slug, "webhook-health"]` query on success.
- `OnboardingChecklist.tsx` gained a "Включить отслеживание доставки" item (done-state from the same `getWebhookHealth` query, deep-linking to the SendGrid settings page while incomplete), covering workspaces that connected SendGrid before Phase 5 shipped auto-provisioning.
- New `campaign-delivery-counters.test.ts`: seeds a campaign with non-zero delivery counters directly and asserts both the progress endpoint and the campaign detail endpoint return them unchanged.

## Task Commits

Each task was committed atomically:

1. **Task 1: Surface campaign delivery counters in the progress API + campaign summary/progress UI (D-07/D-08/D-09)** - `4f39398` (feat)
2. **Task 2: Webhook health card + Reconnect on the SendGrid settings page (D-03) + web health client** - `c3eb7af` (feat)
3. **Task 3: Onboarding checklist "Включить отслеживание доставки" item (D-02)** - `3d14011` (feat)

## Files Created/Modified

- `apps/api/src/modules/campaigns/campaign.repository.ts` - `CampaignRow`/`CampaignProgress` + `CAMPAIGN_COLUMNS`/`getCampaignProgress` carry the five delivery counters
- `apps/api/src/modules/campaigns/campaigns.routes.ts` - `toCampaignResponse` carries the same five fields
- `apps/api/src/modules/campaigns/__tests__/campaign-delivery-counters.test.ts` - integration test seeding non-zero counters, asserting progress + detail responses
- `apps/web/src/features/campaigns/api.ts` - `CampaignResponse`/`CampaignProgress` web types extended
- `apps/web/src/features/campaigns/CampaignProgress.tsx` - renders the five-counter `<dl>` beneath the live progress bar
- `apps/web/src/features/campaigns/CampaignDetailPage.tsx` - `SummaryView` renders the same counter row
- `apps/web/src/features/webhooks/webhook-health.api.ts` - `getWebhookHealth`/`reconnectWebhook` typed client (new file)
- `apps/web/src/features/sendgrid-key/SendGridKeySettings.tsx` - `WebhookHealthCard` component + relative-time helper
- `apps/web/src/features/onboarding/OnboardingChecklist.tsx` - "Включить отслеживание доставки" checklist item

## Decisions Made

- Webhook-health badge status maps `connected -> active`, `provisionStatus === 'error' -> error`, everything else (including never-provisioned) `-> pending` — the 05-04 API already collapses `connected` to exactly `provisionStatus === 'active'`, so no new server contract was needed.
- Onboarding checklist's done-state checks `connected && provisionStatus === 'active'` explicitly (even though `connected` alone is currently equivalent per the API), matching the plan's literal must_haves wording and staying resilient if the two fields ever decouple.
- No new shared component was extracted for the five-counter row — the same `<dl>` markup is duplicated in `CampaignProgress.tsx` and `CampaignDetailPage.tsx`'s `SummaryView`, matching the plan's exact `files_modified` list (which didn't include a new shared component file) and the codebase's existing per-view duplication precedent.

## Deviations from Plan

None - plan executed exactly as written. All three tasks' acceptance criteria were met without needing any Rule 1-4 auto-fixes.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required. The webhook-health card and onboarding item both surface state produced by the already-live 05-04 provisioning flow; no new environment variables or manual dashboard steps are needed.

## Next Phase Readiness

- Phase 5 (webhook-processing-delivery-tracking) is now feature-complete across all 5 plans: dedup receiver + endpoint table (05-01), pure decision modules (05-02), delivery fact columns/counters/suppression engine (05-03), auto-provisioning + health/reconnect API (05-04), and this plan's UI surfacing (05-05).
- Three deferred human-verify checks remain, consistent with `human_verify_mode: end-of-phase` and every prior phase's precedent: (1) the delivery-counter UI rendering against a real sending/sent campaign, (2) the webhook-health card showing `connected: true` with a real last-event time after a live signed event, (3) the onboarding item flipping to done after a live reconnect. All three are covered by clean `npm run build -w apps/web` type-checks and the passing `campaign-delivery-counters` integration test; only the visual/live-event confirmation is outstanding.
- No known gaps for Phase 6 (triggered chains) or Phase 7 (analytics/send log) to work around — this plan's counters intentionally stay as raw counts (not percentages), matching D-07's explicit deferral of percentage math to Phase 7 ANLT-01.

---
*Phase: 05-webhook-processing-delivery-tracking*
*Completed: 2026-07-08*

## Self-Check: PASSED

All 9 created/modified files found on disk; all 3 task commits (`4f39398`, `c3eb7af`, `3d14011`) plus the summary commit (`48da3b0`) found in git history.
