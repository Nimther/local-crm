---
phase: 04-broadcast-campaigns-send-pipeline
plan: 08
subsystem: ui
tags: [react, tanstack-query, shadcn, campaigns, send-pipeline]

requires:
  - phase: 04-broadcast-campaigns-send-pipeline
    provides: "04-05 launch/schedule/cancel/test-send/audience-breakdown/progress/send-settings routes, 04-06 worker real progress, 04-07 campaign list/builder + api.ts wrappers"
provides:
  - "Campaign detail page with per-status views (draft/scheduled/sending/sent/canceled)"
  - "Launch-confirm dialog with D-04 audience breakdown, schedule dialog with D-06 UTC conversion, cancel dialog covering both D-07/D-09 semantics"
  - "Test-send panel with editable D-18 JSON sample"
  - "Live 3s-polled send progress with D-10 failed-count line"
  - "Workspace send-settings page (frequency cap + optional RPS)"
  - "D-03 segment-editor warning for scheduled-campaign references"
affects: [phase-05-webhook-tracking, phase-06-flows]

tech-stack:
  added: []
  patterns:
    - "refetchInterval callback reading the query's own latest fetched status to self-stop polling on any terminal state (CsvImportWizard precedent, reused for CampaignProgress and CampaignDetailPage)"
    - "Controlled Dialog/AlertDialog components (open/onOpenChange props from parent state, no DialogTrigger) for actions triggered from a radio-group/button row rather than a fixed trigger element"

key-files:
  created:
    - apps/web/src/features/campaigns/AudienceBreakdown.tsx
    - apps/web/src/features/campaigns/LaunchScheduleDialogs.tsx
    - apps/web/src/features/campaigns/TestSendPanel.tsx
    - apps/web/src/features/campaigns/CampaignProgress.tsx
    - apps/web/src/features/campaigns/CampaignDetailPage.tsx
    - apps/web/src/features/campaigns/SendSettingsPage.tsx
  modified:
    - apps/web/src/App.tsx
    - apps/web/src/features/campaigns/CampaignBuilderPage.tsx
    - apps/web/src/features/app-shell/AppShell.tsx
    - apps/web/src/features/segments/SegmentDetailPage.tsx
    - apps/web/src/lib/api.ts

key-decisions:
  - "CampaignBuilderPage's placeholder disabled launch/schedule buttons (added ahead of this plan in 04-07) were removed rather than left in place, since CampaignDetailPage's draft view now embeds CampaignBuilderPage AND renders the real LaunchScheduleActions below it -- keeping the old placeholders would have shown two non-functional-looking button pairs"
  - "apiPut added to lib/api.ts -- the send-settings route is a PUT and no full-replace HTTP verb wrapper existed yet (only apiGet/apiPost/apiPatch/apiDelete)"
  - "SendSettingsPage uses manual useState instead of react-hook-form+zodResolver -- workspaceSendSettingsSchema's frequencyWindowHours has a zod .default(24), which makes the schema's input/output types diverge in a way zodResolver's generic can't reconcile for a field this page never surfaces as an editable input"
  - "SegmentDetailPage's D-03 warning is computed by client-side filtering the existing listCampaigns response (segmentId===id && status==='scheduled') rather than a new dedicated endpoint -- no such endpoint exists yet and workspace campaign counts are small"

requirements-completed: [CAMP-02, CAMP-03, CAMP-04, CAMP-05]

coverage:
  - id: D1
    description: "Launch a draft immediately via a confirm dialog showing the Display-size sendable count + exclusion breakdown before commit, or schedule it via a datetime-local picker labelled with the resolved local timezone, storing UTC"
    requirement: "CAMP-02"
    verification:
      - kind: automated_ui
        ref: "grep verification: datetime-local present in LaunchScheduleDialogs.tsx; npm run build clean"
        status: pass
    human_judgment: true
    rationale: "Requires a live tenant SendGrid key + segment with real contacts to observe the actual launch/schedule network round-trip and toast; automated build/grep checks confirm the code shape but not live behavior."
  - id: D2
    description: "State machine visible in the UI: launch/schedule disabled until template+sender+audience chosen with inline error copy; only draft/canceled deletable"
    requirement: "CAMP-03"
    verification:
      - kind: unit
        ref: "computeIncompleteReason in LaunchScheduleDialogs.tsx (manually reasoned, no dedicated unit test file added this plan)"
        status: unknown
    human_judgment: true
    rationale: "No test file was added for this plan (execute-only, no tdd=true tasks) -- needs a UAT pass clicking through a draft missing template/sender."
  - id: D3
    description: "Send a test email to own address with editable sample dynamic_template_data JSON auto-filled from a real segment contact"
    requirement: "CAMP-04"
    verification:
      - kind: automated_ui
        ref: "grep verification: 'Отправить тестовое письмо' present in TestSendPanel.tsx; npm run build clean"
        status: pass
    human_judgment: true
    rationale: "Requires a live SendGrid key to observe an actual test email arriving; code-shape checks alone don't prove delivery."
  - id: D4
    description: "Live 3s-polled determinate progress bar + failed-count line during sending"
    requirement: "CAMP-05"
    verification:
      - kind: automated_ui
        ref: "grep verification: refetchInterval + отправлено present in CampaignProgress.tsx; npm run build clean"
        status: pass
    human_judgment: true
    rationale: "Requires an actual in-flight send (worker processing real jobs) to observe the poll transitioning through sending -> sent/canceled; not exercisable via a static build check."
  - id: D5
    description: "Send-settings page (frequency cap + optional RPS) Owner/Admin-gated; Member sees disabled controls with tooltip"
    requirement: "CAMP-05"
    verification:
      - kind: automated_ui
        ref: "grep verification: 'Сохранить настройки' + settings/sending route present; npm run build clean"
        status: pass
    human_judgment: true
    rationale: "Role-gating behavior (Member vs Owner/Admin) needs a live session switch to observe the disabled+tooltip state, not provable from a static grep."
  - id: D6
    description: "Segment editor warns when referenced by a scheduled campaign (D-03)"
    requirement: "CAMP-03"
    verification:
      - kind: automated_ui
        ref: "grep verification: 'запланированной кампанией' present in SegmentDetailPage.tsx; npm run build clean"
        status: pass
    human_judgment: true
    rationale: "Needs a real scheduled campaign referencing the segment to observe the warning actually rendering, not just being present in source."

duration: 35min
completed: 2026-07-06
status: complete
---

# Phase 4 Plan 8: Campaign Detail, Launch/Schedule/Cancel, Test-Send, Progress, Send-Settings Summary

**Full observable send loop for campaigns: launch/schedule dialogs with the D-04 audience breakdown and D-06 UTC-safe scheduling, a live 3s-polled progress view, a D-18-sourced test-send panel, workspace send-settings, and a D-03 segment-editor warning.**

## Performance

- **Duration:** 35 min
- **Tasks:** 3 completed
- **Files modified:** 11 (6 created, 5 modified)

## Accomplishments

- Built `AudienceBreakdown`, `LaunchScheduleDialogs` (launch-confirm, schedule, cancel), and `TestSendPanel` — the three CAMP-02/03/04 building blocks, all consuming the 04-05 API wrappers already in `campaigns/api.ts`.
- Built `CampaignProgress` (self-stopping 3s poll) and `CampaignDetailPage`, which branches on campaign status into draft (embeds the 04-07 builder + the new test-send panel + launch/schedule actions), scheduled (provisional estimate + cancel), sending (live progress + frozen breakdown + stop), and sent/canceled (summary with D-10 failed-count line). `App.tsx`'s `campaigns/:id` route now points here instead of the 04-07 placeholder.
- Built `SendSettingsPage` (frequency cap + optional RPS, Owner/Admin-gated) at `/w/:slug/settings/sending`, added the AppShell nav link, and added the D-03 amber warning to `SegmentDetailPage` when a scheduled campaign references the segment being edited.

## Task Commits

1. **Task 1: Launch/schedule/cancel dialogs + test-send panel + audience breakdown** - `958b5d0` (feat)
2. **Task 2: Campaign detail page + live progress** - `bf921ae` (feat)
3. **Task 3: Send-settings page + nav + D-03 segment-editor warning** - `c7f73bb` (feat)

## Files Created/Modified

- `apps/web/src/features/campaigns/AudienceBreakdown.tsx` - D-04 sendable count + non-zero exclusion reasons
- `apps/web/src/features/campaigns/LaunchScheduleDialogs.tsx` - LaunchConfirmDialog, ScheduleDialog, CancelDialog, LaunchScheduleActions
- `apps/web/src/features/campaigns/TestSendPanel.tsx` - editable JSON prefilled from getCampaignTestSample
- `apps/web/src/features/campaigns/CampaignProgress.tsx` - self-stopping 3s-polled progress bar + failed line
- `apps/web/src/features/campaigns/CampaignDetailPage.tsx` - per-status detail views, replaces the 04-07 builder placeholder at `/campaigns/:id`
- `apps/web/src/features/campaigns/SendSettingsPage.tsx` - frequency cap + RPS settings page
- `apps/web/src/App.tsx` - `campaigns/:id` -> CampaignDetailPage, new `settings/sending` route
- `apps/web/src/features/campaigns/CampaignBuilderPage.tsx` - removed now-redundant placeholder launch/schedule buttons
- `apps/web/src/features/app-shell/AppShell.tsx` - «Настройки отправки» nav link
- `apps/web/src/features/segments/SegmentDetailPage.tsx` - D-03 amber warning
- `apps/web/src/lib/api.ts` - added `apiPut`

## Decisions Made

- Removed `CampaignBuilderPage`'s 04-07 placeholder disabled launch/schedule buttons rather than leaving them alongside the new real ones (Rule 1 — avoids a confusing duplicate/dead button pair).
- Added `apiPut` to `lib/api.ts` (Rule 3 — send-settings is a PUT and no wrapper existed for it).
- `SendSettingsPage` uses manual `useState` instead of react-hook-form + zodResolver, because `workspaceSendSettingsSchema`'s `frequencyWindowHours` field (`z.number().default(24)`) makes the schema's parsed-input and output types diverge in a way `zodResolver`'s generic inference can't reconcile — and this page never exposes that field as an editable input anyway, so the simpler manual form avoids the type friction entirely.
- D-03's segment-referenced-by-scheduled-campaign check reuses the existing `listCampaigns` list, filtered client-side, rather than a new dedicated endpoint — no such endpoint exists yet in 04-05/04-06 and workspace campaign counts are small enough that this is a reasonable read-only, non-blocking check.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Removed CampaignBuilderPage's placeholder launch/schedule buttons**
- **Found during:** Task 2 (Campaign detail page + live progress)
- **Issue:** 04-07 had added disabled, tooltip-gated «Отправить сейчас»/«Запланировать» placeholder buttons to `CampaignBuilderPage.tsx` (with a code comment explicitly noting "ahead of 04-08 wiring the actual dialogs"). Since `CampaignDetailPage`'s draft view now embeds `CampaignBuilderPage` unmodified AND renders the new, real `LaunchScheduleActions` below it, leaving the old placeholders in place would have produced two visually similar but functionally different button pairs on the same page — one dead, one real.
- **Fix:** Removed the two placeholder `TooltipProvider`/`Button` blocks and their now-unused `workspaceQuery`/`viewerRole`/`canLaunch`/`MEMBER_TOOLTIP`/`NOT_YET_WIRED_TOOLTIP` support code from `CampaignBuilderPage.tsx`; updated its doc comment to describe the new embedding relationship.
- **Files modified:** `apps/web/src/features/campaigns/CampaignBuilderPage.tsx`
- **Verification:** `npm run build` clean (tsc + vite) after the removal.
- **Committed in:** `bf921ae` (part of Task 2 commit)

**2. [Rule 3 - Blocking] Added apiPut wrapper**
- **Found during:** Task 3 (Send-settings page)
- **Issue:** `lib/api.ts` only exported `apiGet`/`apiPost`/`apiPatch`/`apiDelete`; the send-settings route (04-05) is a `PUT`, which had no wrapper.
- **Fix:** Added `apiPut<T>(path, data)` mirroring `apiPatch`'s implementation.
- **Files modified:** `apps/web/src/lib/api.ts`
- **Verification:** `npm run build` clean.
- **Committed in:** `c7f73bb` (part of Task 3 commit)

---

**Total deviations:** 2 auto-fixed (1 Rule 1, 1 Rule 3)
**Impact on plan:** Both fixes were necessary for correctness (avoiding dead/duplicate UI) and completeness (a missing HTTP-verb wrapper). No scope creep beyond what the plan's own read_first notes already flagged as forthcoming (04-07's comment explicitly anticipated 04-08 replacing its placeholders).

## Issues Encountered

- `SendSettingsPage`'s initial react-hook-form + zodResolver implementation failed `tsc` with a resolver type-mismatch caused by `workspaceSendSettingsSchema`'s `.default(24)` on `frequencyWindowHours`. Resolved by switching to a manual `useState`-based form (matching the pattern already used by `CampaignBuilderPage`/`SegmentDetailPage` elsewhere in this codebase), rather than fighting the zod/react-hook-form generic inference for a field this page doesn't surface as an input.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

The full campaign send loop (create draft -> launch/schedule -> live progress -> sent/canceled summary -> test-send -> send-settings) is now UI-complete, closing out CAMP-02 through CAMP-05 and the phase's "observable send loop" success criterion. Live human verification of the actual SendGrid round-trip (test-send delivery, launch confirming a real send, schedule firing at the scheduled instant, worker-driven progress polling) is deferred to phase-level UAT per this project's established `human_verify_mode: end-of-phase` precedent (Phases 1-3) — the `coverage` entries above are marked `human_judgment: true` accordingly. This is the last plan (04-08) in phase 04's plan sequence; phase-level UAT is the next step before moving to Phase 5 (webhook tracking).

---
*Phase: 04-broadcast-campaigns-send-pipeline*
*Completed: 2026-07-06*

## Self-Check: PASSED

All 11 created/modified files verified present on disk; all 3 task commits (`958b5d0`, `bf921ae`, `c7f73bb`) verified present in git log.
