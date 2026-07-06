---
phase: 04-broadcast-campaigns-send-pipeline
plan: 07
subsystem: ui
tags: [react, tanstack-query, shadcn, campaigns, sendgrid]

requires:
  - phase: 04-broadcast-campaigns-send-pipeline
    provides: "04-05's campaigns.routes.ts (list/create/get/update/delete/launch/schedule/cancel/duplicate/test-send/progress/audience-breakdown/sendgrid-templates/sendgrid-senders endpoints)"
provides:
  - "campaigns/api.ts -- the full frontend client for the campaigns REST surface, including the 04-08 launch/schedule/cancel/test-send/progress/audience-breakdown wrappers"
  - "CampaignsListPage.tsx -- the campaigns list (table, status badges, empty state, row actions)"
  - "CampaignBuilderPage.tsx + TemplateSenderPickers.tsx -- create/edit-draft builder with segment/template/sender pickers"
  - "CampaignStatusBadge.tsx -- the five-status badge component reused by 04-08's detail page"
  - "Кампании sidebar nav item + /w/:slug/campaigns, /campaigns/new, /campaigns/:id routes"
affects: ["04-08 (campaign detail/launch/schedule/progress UI)"]

tech-stack:
  added: []
  patterns:
    - "NavLink-based active-state sidebar accent (converted from plain Link across AppShell.tsx)"
    - "Segment-id -> segment-name lookup map for a list column that isn't denormalized server-side (mirrors SegmentsListPage's createdByUserId -> member-name resolution)"

key-files:
  created:
    - apps/web/src/features/campaigns/api.ts
    - apps/web/src/features/campaigns/CampaignsListPage.tsx
    - apps/web/src/features/campaigns/CampaignStatusBadge.tsx
    - apps/web/src/features/campaigns/CampaignBuilderPage.tsx
    - apps/web/src/features/campaigns/TemplateSenderPickers.tsx
  modified:
    - apps/web/src/features/app-shell/AppShell.tsx
    - apps/web/src/App.tsx

key-decisions:
  - "listCampaignTemplates(slug) takes no `id` param -- the actual GET /campaigns/sendgrid/templates route (04-05) reads the tenant's own SendGrid key, not a specific campaign, so the plan's 'id?' signature description doesn't match the real route"
  - "No CampaignResponse/CampaignListResponse type exists in @mega-crm/shared-schemas (only request schemas do) -- defined them locally in campaigns/api.ts, mirroring campaigns.routes.ts's toCampaignResponse field-for-field"
  - "CampaignBuilderPage uses plain useState (not react-hook-form) for its top-level fields, matching SegmentCreatePage.tsx's actual established pattern (the plan's read_first described RHF, but the real analog file doesn't use it)"
  - "AppShell's sidebar links converted from plain Link to NavLink with an isActive-driven accent class -- closes a pre-existing Phase 1-3 gap where no nav item ever rendered as active, needed to satisfy this plan's explicit 'active-state accent' truth for Кампании"
  - "Builder renders disabled 'Отправить сейчас'/'Запланировать' affordances (with a role-aware tooltip) on an existing draft, satisfying T-04-07-01's Member-facing mitigation ahead of 04-08 wiring the actual dialogs"

requirements-completed: [CAMP-01]

coverage:
  - id: D1
    description: "Кампании nav item routes to /w/:slug/campaigns with active-state accent"
    requirement: "CAMP-01"
    verification:
      - kind: other
        ref: "grep 'Кампании' AppShell.tsx + npm run build"
        status: pass
    human_judgment: true
    rationale: "Visual active-state accent styling needs a human to confirm it renders correctly in the browser"
  - id: D2
    description: "Campaigns list shows name + status badge (exact Russian labels/colors) + empty state"
    requirement: "CAMP-01"
    verification:
      - kind: other
        ref: "grep 'Кампаний пока нет'/'Отправляется' + npm run build"
        status: pass
    human_judgment: true
    rationale: "Badge color/label correctness and empty-state layout need visual confirmation; no frontend unit test harness exists in this codebase (apps/web has no *.test.* files)"
  - id: D3
    description: "Campaign builder creates a draft with name + segment + template + sender, saves via createCampaign/updateCampaign"
    requirement: "CAMP-01"
    verification:
      - kind: other
        ref: "grep 'Сохранить черновик'/'Обновить список' + npm run build"
        status: pass
    human_judgment: true
    rationale: "End-to-end save flow against a live SendGrid key/segment needs manual UAT (no unit test harness in apps/web)"
  - id: D4
    description: "Row dropdown offers duplicate and delete (draft/canceled only)"
    requirement: "CAMP-01"
    verification: []
    human_judgment: true
    rationale: "Interactive dropdown behavior needs manual click-through verification"
  - id: D5
    description: "Launch/schedule affordances render disabled with Owner/Admin tooltip for a Member"
    requirement: "CAMP-01"
    verification: []
    human_judgment: true
    rationale: "Role-conditioned tooltip content requires testing as both a Member and an Owner/Admin session"

duration: 25min
completed: 2026-07-06
status: complete
---

# Phase 4 Plan 7: Campaigns List + Builder UI Summary

**Campaigns feature (api client, list page, create/edit-draft builder with segment/template/sender pickers) plus the Кампании nav item and routes -- the first marketer-visible surface of Phase 4 (CAMP-01)**

## Performance

- **Duration:** 25 min
- **Completed:** 2026-07-06
- **Tasks:** 3 completed
- **Files modified:** 7 (5 created, 2 modified)

## Accomplishments

- A marketer can now navigate to «Кампании» in the sidebar, see every campaign in a paginated table with the correct status badge (Черновик/Запланирована/Отправляется/Отправлена/Отменена) and audience/updated columns, or land on the empty state with the "Создать кампанию" CTA.
- A marketer can create a campaign (name + segment + optional template/sender) and save it as a draft, then re-open and edit it while it stays a draft; editing is blocked (read-only notice) once the campaign leaves draft status.
- The template/sender pickers reuse Phase 3's popover+command combobox pattern verbatim, fetch live from the tenant's SendGrid key, offer an "Обновить список" refresh, and give the template picker a manual `template_id` text fallback (D-16) since the sender picker is verified-only (D-17).
- Row actions on the list let a user duplicate any campaign (new draft copy, toast + navigate) or delete a draft/canceled campaign via a confirmation dialog; scheduled/sending/sent campaigns are not offered delete, preserving history for Phase 7 analytics.

## Task Commits

Each task was committed atomically:

1. **Task 1: campaigns/api.ts + nav item + routes** - `58ab77b` (feat)
2. **Task 2: Campaigns list + status badge** - `952d037` (feat)
3. **Task 3: Campaign builder (create/edit draft) + template/sender pickers** - `5d6825b` (feat)

_No TDD tasks in this plan; apps/web has no unit-test harness (build/tsc + manual/E2E verification only, consistent with Phase 1-3's frontend plans)._

## Files Created/Modified

- `apps/web/src/features/campaigns/api.ts` - Thin wrapper client for every campaign REST endpoint (list/create/get/update/delete/launch/schedule/cancel/duplicate/test-send/progress/audience-breakdown/templates/senders), plus locally-defined `CampaignResponse`/`CampaignListResponse` types (no shared-schemas response schema exists yet)
- `apps/web/src/features/campaigns/CampaignsListPage.tsx` - Paginated campaigns table with status badge, segment-name column (resolved via a lookup map), empty state, and row dropdown (Открыть/Дублировать/Удалить черновик)
- `apps/web/src/features/campaigns/CampaignStatusBadge.tsx` - Maps all five campaign statuses to the exact UI-SPEC Russian label + color (canceled gets an XCircle icon, not a new color)
- `apps/web/src/features/campaigns/CampaignBuilderPage.tsx` - Create/edit-draft form: name + Аудитория (segment combobox) + Шаблон и отправитель sections, save wired to createCampaign/updateCampaign, read-only notice for non-draft campaigns, disabled launch/schedule affordances with role-aware tooltip
- `apps/web/src/features/campaigns/TemplateSenderPickers.tsx` - `TemplatePicker` (SendGrid Dynamic Templates + refresh + manual template_id fallback) and `SenderPicker` (verified senders + refresh) components
- `apps/web/src/features/app-shell/AppShell.tsx` - Added the «Кампании» nav item; converted every sidebar link from `Link` to `NavLink` with an active-state accent class
- `apps/web/src/App.tsx` - Registered `campaigns`, `campaigns/new`, `campaigns/:id` routes under the `/w/:slug` AppShell route

## Decisions Made

- `listCampaignTemplates(slug)` has no `id` parameter, matching the real `GET /api/workspaces/:slug/campaigns/sendgrid/templates` route (04-05), which reads the tenant's SendGrid key independent of any specific campaign -- the plan's read_first description ("listCampaignTemplates(slug, id?)") doesn't match the actual backend contract, so the wrapper follows the real route (source grounding: grep).
- Defined `CampaignResponse`/`CampaignListResponse` as local TypeScript interfaces in `campaigns/api.ts` rather than importing from `@mega-crm/shared-schemas`, since that package only exports campaign *request* schemas (`createCampaignSchema`, `updateCampaignSchema`, etc.) -- no response schema exists for campaigns yet, unlike segments (`SegmentResponse`/`SegmentListResponse`).
- `CampaignBuilderPage` uses plain `useState` fields (not `react-hook-form`) for name/segment/template/sender, matching `SegmentCreatePage.tsx`'s actual implementation -- the plan's read_first described that file as an "react-hook-form + save" shell, but the real file (verified by reading it) doesn't use react-hook-form at all; the plain-state pattern was followed for consistency with the established codebase convention.
- Converted `AppShell.tsx`'s sidebar links from `Link` to `NavLink` with an `isActive`-driven indigo-600 accent class, applied to every link (not just Кампании) -- this closes a pre-existing Phase 1-3 gap where no nav item ever rendered as "active" despite the design system reserving that treatment, and was necessary to satisfy this plan's explicit must-have truth ("active-state accent per UI-SPEC" for the Кампании item).
- Added disabled `«Отправить сейчас»`/`«Запланировать»` buttons (role-aware tooltip: the exact D-19 copy for Members, a "coming in 04-08" note for Owner/Admin) on an existing draft's builder view, directly implementing this plan's threat-model mitigation T-04-07-01 ("Launch/schedule controls render disabled with the Owner/Admin tooltip for Members") even though Task 3's action text didn't spell out this specific UI element -- the threat register assigns it to this plan's files, so it's a Rule 2 (auto-add missing critical/threat-mitigation functionality) addition, not scope creep. 04-08 wires the actual click handlers/dialogs.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - blocking/contract mismatch] `listCampaignTemplates` signature adjusted to match the real route**
- **Found during:** Task 1 (campaigns/api.ts)
- **Issue:** The plan's artifact list describes `listCampaignTemplates(slug, id?)`, but `apps/api/src/modules/campaigns/campaigns.routes.ts` (04-05) registers `GET /api/workspaces/:slug/campaigns/sendgrid/templates` with no `:id` path segment -- an optional-id wrapper would silently build a URL the backend never matches.
- **Fix:** Implemented `listCampaignTemplates(slug)` against the actual static route; documented the discrepancy in a code comment.
- **Files modified:** `apps/web/src/features/campaigns/api.ts`
- **Verification:** `npm run build` succeeds; route path matches `campaigns.routes.ts` verbatim.
- **Committed in:** `58ab77b` (part of Task 1 commit)

**2. [Rule 2 - missing threat mitigation] Disabled launch/schedule affordances with role-aware tooltip**
- **Found during:** Task 3 (CampaignBuilderPage)
- **Issue:** This plan's threat register (T-04-07-01) assigns a `mitigate` disposition to `CampaignBuilderPage.tsx`/`CampaignsListPage.tsx` for "Member seeing enabled launch/schedule controls," and the plan's own `must_haves.truths` lists this as a required outcome of 04-07 -- but Task 3's action text never described building the affordance.
- **Fix:** Added disabled `«Отправить сейчас»`/`«Запланировать»` buttons on an existing draft, tooltipped with the D-19 Member copy (or a neutral "coming in 04-08" note for Owner/Admin).
- **Files modified:** `apps/web/src/features/campaigns/CampaignBuilderPage.tsx`
- **Verification:** `npm run build` succeeds; buttons render `disabled` unconditionally in this plan (no click handler exists until 04-08).
- **Committed in:** `5d6825b` (part of Task 3 commit)

**3. [Rule 2 - missing correctness/consistency gap] Sidebar active-state accent**
- **Found during:** Task 1 (AppShell.tsx)
- **Issue:** This plan's must-have truth requires the Кампании nav item to show "active-state accent per UI-SPEC," but `AppShell.tsx` used plain `Link` elements with no active-state logic at all for any nav item (a pre-existing gap carried from Phase 1-3).
- **Fix:** Converted all sidebar links to `NavLink` with a shared `navLinkClassName` helper applying the indigo-600/accent-background treatment when active.
- **Files modified:** `apps/web/src/features/app-shell/AppShell.tsx`
- **Verification:** `npm run build` succeeds; `NavLink`'s `isActive` callback is the standard react-router mechanism for this.
- **Committed in:** `58ab77b` (part of Task 1 commit)

---

**Total deviations:** 3 auto-fixed (1 Rule 3, 2 Rule 2)
**Impact on plan:** All three were necessary for correctness (matching the real backend route) or to satisfy this plan's own explicit must-have truths and threat-model mitigations. No scope creep beyond what 04-07 itself commits to; the actual launch/schedule dialogs, progress polling, and send-settings page remain entirely deferred to 04-08 as the plan specifies.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required. Live SendGrid template/sender fetching depends on the tenant's own connected key (already configured in Phase 1's SendGrid-key settings flow); this plan's automated verification only exercises the build, not a live SendGrid account.

## Next Phase Readiness

`campaigns/api.ts` already exposes every wrapper 04-08 needs (launch/schedule/cancel/testSend/getCampaignProgress/getCampaignAudienceBreakdown/getCampaignTestSample), and `CampaignStatusBadge`/`CampaignBuilderPage` are ready to be reused/extended by `CampaignDetailPage.tsx`. The `campaigns/:id` route currently points at `CampaignBuilderPage` for every status (with a read-only notice for non-draft) -- 04-08 replaces this with `CampaignDetailPage`, splitting the detail/progress views out per the plan's own note in `App.tsx`. No blockers.

---
*Phase: 04-broadcast-campaigns-send-pipeline*
*Completed: 2026-07-06*
