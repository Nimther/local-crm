---
phase: 04-broadcast-campaigns-send-pipeline
plan: 18
subsystem: ui
tags: [react, tanstack-query, vitest, segments, campaigns]

requires:
  - phase: 04-broadcast-campaigns-send-pipeline
    provides: "04-08 CampaignResponse/campaigns api client + D-03 mount-time banner; 04-15 EXHAUSTIVE_LOOKUP_PAGE_SIZE fix"
provides:
  - "Pure D-03 save-gate decision (findBlockingScheduledCampaign) shared by the mount-time banner and a new save-time gate"
  - "apps/web's first vitest unit-test lane (node env, no jsdom/testing-library)"
  - "Save-time refetch+confirm gate in SegmentDetailPage.handleSave, closing UAT Test 12"
affects: [segments, campaigns, web-testing]

tech-stack:
  added: []
  patterns:
    - "apps/web unit-test lane: vitest.config.ts (environment: node, test.include src/**/*.test.{ts,tsx}), package.json test script `vitest run` -- mirrors apps/api/apps/worker's hoisted vitest, no new installs"
    - "Pure decision-helper pattern: a framework-free function (segmentSaveGate.ts) is the single source of truth consulted by both a passive mount-time render and an imperative save-time gate, so the two can never disagree"

key-files:
  created:
    - apps/web/src/features/segments/segmentSaveGate.ts
    - apps/web/src/features/segments/__tests__/segmentSaveGate.test.ts
    - apps/web/vitest.config.ts
  modified:
    - apps/web/src/features/segments/SegmentDetailPage.tsx
    - apps/web/package.json

key-decisions:
  - "Inline two-step confirm (pendingConfirmCampaign state + button label swap) chosen over an AlertDialog, per the plan's explicit acceptable-alternative wording -- avoids introducing a second dialog component for what is functionally a two-click flow"
  - "A refetch failure inside handleSave is caught and treated as non-blocking (save proceeds) while surfaced via referencingCampaignsQuery.isError's muted note -- never silently blocks or silently allows with zero feedback"
  - "pendingConfirmCampaign resets on any subsequent name/definition edit (via handleNameChange/handleDefinitionChange wrappers) so a fresh edit always re-gates instead of riding a stale confirm"

patterns-established:
  - "Web vitest lane: node-environment vitest.config.ts + `test` script per workspace app, picked up automatically by root `npm test --workspaces --if-present`"

requirements-completed: [CAMP-05]

coverage:
  - id: D1
    description: "findBlockingScheduledCampaign pure helper: only a status='scheduled' campaign referencing the exact segmentId blocks, across 5 pinned behaviors (no campaigns, matching scheduled, non-matching segment, non-scheduled statuses, mixed-list ordering)"
    requirement: "CAMP-05"
    verification:
      - kind: unit
        ref: "apps/web/src/features/segments/__tests__/segmentSaveGate.test.ts (8 tests, all passing)"
        status: pass
    human_judgment: false
  - id: D2
    description: "apps/web unit-test lane stood up (vitest.config.ts + package.json test script), runnable via npm run test -w @mega-crm/web and root npm test --workspaces"
    verification:
      - kind: unit
        ref: "npm run test -w @mega-crm/web -- 1 test file, 8 tests passed"
        status: pass
    human_judgment: false
  - id: D3
    description: "handleSave awaits a fresh referencingCampaignsQuery.refetch() before mutate() and requires an explicit second-click confirm when a scheduled campaign references the segment; mount-time banner and save-gate share the same helper; a failed lookup renders a muted note instead of silently implying no reference"
    requirement: "CAMP-05"
    verification:
      - kind: integration
        ref: "npm run build -w @mega-crm/web (tsc --noEmit + vite build, clean); grep confirms findBlockingScheduledCampaign/refetch()/isError wiring present in SegmentDetailPage.tsx"
        status: pass
      - kind: manual_procedural
        ref: "Phase UAT re-run of Test 12 (human_verify_mode: end-of-phase) -- campaign 'Datetime picker' scheduled 2026-07-08 referencing segment 'Город пусто'"
        status: unknown
    human_judgment: true
    rationale: "The save-time gate's actual browser behavior (confirm banner appearing, button label swap, save committing on second click) needs a live UAT click-through against the still-scheduled campaign; automated coverage here is limited to the pure decision + typecheck/build, not a rendered DOM assertion (no jsdom install in this lane by design)."

duration: 20min
completed: 2026-07-07
status: complete
---

# Phase 04 Plan 18: D-03 Save-Time Gate Summary

**Segment save now refetches referencing campaigns at click time and requires an explicit confirm when a scheduled campaign is affected, replacing a mount-time-only banner that silently missed UAT Test 12.**

## Performance

- **Duration:** ~20 min
- **Completed:** 2026-07-07T00:59:22Z
- **Tasks:** 2 completed
- **Files modified:** 5

## Accomplishments
- Extracted the D-03 decision (`findBlockingScheduledCampaign`) into a pure, framework-free helper with 8 passing unit tests covering all 5 required behaviors, including mixed-list ordering.
- Stood up apps/web's first vitest lane (node environment, no new installs -- vitest was already hoisted from apps/api/apps/worker) with a `test` script that root `npm test --workspaces` now picks up.
- Rewired `SegmentDetailPage.handleSave` to `await` a fresh `referencingCampaignsQuery.refetch()` before mutating and gate on the shared helper, requiring an explicit second-click confirm when a scheduled campaign references the segment being edited -- closing the exact UAT Test 12 timing gap (editor mounted before the campaign was scheduled).
- Surfaced `referencingCampaignsQuery.isError` as a muted note so a failed lookup is visible instead of silently rendering as "no warning".

## Task Commits

1. **Task 1: Extract a pure D-03 save-gate helper and stand up the web vitest lane** - `499154c` (test)
2. **Task 2: Save-time D-03 refetch+confirm gate + isError surfacing in the segment editor** - `b3d1124` (fix)

**Plan metadata:** (this commit)

## Files Created/Modified
- `apps/web/src/features/segments/segmentSaveGate.ts` - pure `findBlockingScheduledCampaign(campaigns, segmentId)` helper, single source of truth for the D-03 decision
- `apps/web/src/features/segments/__tests__/segmentSaveGate.test.ts` - 8 unit tests pinning the decision (no campaigns, scheduled+matching, scheduled+different-segment, each non-scheduled status, mixed-list ordering)
- `apps/web/vitest.config.ts` - node-environment vitest config for apps/web (new file)
- `apps/web/package.json` - added `"test": "vitest run"` script
- `apps/web/src/features/segments/SegmentDetailPage.tsx` - mount-time banner now derives from the shared helper; `handleSave` made async, refetches before mutate, gates on a `pendingConfirmCampaign` state that resets on further edits; `referencingCampaignsQuery.isError` rendered as a muted note

## Decisions Made
- Inline two-step confirm (not an AlertDialog) -- matches the plan's stated acceptable alternative, keeps the change additive/minimal.
- A refetch error inside `handleSave` is caught and treated as non-blocking for the save itself, with visibility handled entirely by the existing `isError` note (avoids duplicating error UI in two places).
- `pendingConfirmCampaign` resets on any subsequent name/definition change, so a stale confirm can never carry through onto a different edit.

## Deviations from Plan

None - plan executed exactly as written. The plan explicitly offered the AlertDialog-based confirm as an acceptable alternative to the inline two-step confirm; the inline approach was implemented as it satisfies all three stated conditions (refetch before mutate, explicit confirm when blocked, no block when clear).

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness

CAMP-05's D-03 warning now has real automated coverage at the decision layer and correctly re-checks at the moment the UAT truth anchors to (the save click). Remaining verification is the phase-level UAT re-run of Test 12 against the live app (campaign "Datetime picker" is still scheduled for 2026-07-08, per the debug session's discriminator), which is a human_judgment item carried into phase UAT per `human_verify_mode: end-of-phase`. No blockers for closing out phase 04.

---
*Phase: 04-broadcast-campaigns-send-pipeline*
*Completed: 2026-07-07*

## Self-Check: PASSED

All created files verified present on disk; all task/summary commit hashes verified present in git log.
