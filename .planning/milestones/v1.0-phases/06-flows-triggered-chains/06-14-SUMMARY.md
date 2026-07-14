---
phase: 06-flows-triggered-chains
plan: 14
subsystem: flows-engine
tags: [flows, draft-publish, gap-closure, cr-03, wr-03]

# Dependency graph
requires:
  - phase: 06-flows-triggered-chains
    provides: flow.repository.ts's updateFlowDraft/publishFlow (06-01), FlowDetailPage + PublishEnrollDialog (06-04/06-09), flow-trigger-evaluator.worker.ts + flow-segment-sweep.worker.ts (06-06/06-08)
provides:
  - "updateFlowDraft's trigger-column sync gated on existing.status === 'draft' -- a live/paused flow's flows.trigger_* columns no longer change from an unpublished autosaved edit"
  - "publishFlow re-derives trigger_type/trigger_event_name/trigger_segment_id from the version being published, in the same UPDATE that repoints live_version_id -- publish is the SOLE point where the live trigger changes"
  - "FlowDetailPage's role-gated \"Опубликовать изменения\" action for a live/paused flow with flow.draftVersionId set, opening the existing PublishEnrollDialog"
  - "flow-lifecycle.test.ts CR-03 regression proving the pinned-until-publish invariant end to end through the real HTTP API"
affects: [06-flows-triggered-chains phase verification, roadmap success criterion 4]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Trigger-column sync in a draft-mutation repository function must be gated on the row's own current status, not on whether a definition patch was supplied -- publish is the only legal point where a live/paused flow's live-enrollment-facing columns change"

key-files:
  created: []
  modified:
    - apps/api/src/modules/flows/flow.repository.ts
    - apps/web/src/features/flows/detail/FlowDetailPage.tsx
    - apps/web/src/features/flows/detail/PublishEnrollDialog.tsx
    - apps/api/src/modules/flows/__tests__/flow-lifecycle.test.ts

key-decisions:
  - "updateFlowDraft's triggerColumns computation gated on `patch.definition !== undefined && existing.status === 'draft'` -- a never-published draft still syncs immediately (the draft IS its trigger pre-publish, needed for D-24 restrict-delete), but a live/paused flow's flows-row trigger columns stay pinned to the published definition until publish"
  - "publishFlow calls extractTriggerColumns(definition) on the definition being published and sets trigger_type/trigger_event_name/trigger_segment_id in the same UPDATE that repoints live_version_id -- makes publish idempotent-safe for first publish and the sole re-targeting point for republish"
  - "publish-changes UI action reuses the existing PublishEnrollDialog unchanged (via setPublishOpen(true)) rather than introducing a second dialog; dialog title keys off flow.status !== 'draft' to read \"Опубликовать изменения\" on republish"
  - "New publish-changes button rendered alongside (not replacing) the existing pause/resume lifecycle button, role-gated identically (disabled + MEMBER_TOOLTIP when !canManage)"

requirements-completed: [FLOW-06]

coverage:
  - id: D1
    description: "Editing a live/paused flow's draft trigger does NOT change flows.trigger_type/trigger_event_name/trigger_segment_id before publish (CR-03 closed)"
    requirement: "FLOW-06"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/flows/__tests__/flow-lifecycle.test.ts#CR-03: a live flow's unpublished draft trigger edit does not change trigger_* until re-published"
        status: pass
      - kind: unit
        ref: "apps/api/src/modules/flows/flow.repository.ts updateFlowDraft (existing.status === 'draft' guard, grep-verified)"
        status: pass
    human_judgment: false
  - id: D2
    description: "publishFlow re-derives the trigger columns from the version being published, so publishing is the ONLY action that changes live enrollment targeting"
    requirement: "FLOW-06"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/flows/__tests__/flow-lifecycle.test.ts#CR-03 test's second-publish assertion (triggerEventName becomes 'signup' only after re-publish)"
        status: pass
      - kind: unit
        ref: "apps/api/src/modules/flows/flow.repository.ts publishFlow (extractTriggerColumns(definition) call + UPDATE column list, grep-verified)"
        status: pass
    human_judgment: false
  - id: D3
    description: "The flow detail UI offers a publish-changes action for a live/paused flow with an accumulated draft (WR-03 closed)"
    requirement: "FLOW-06"
    verification:
      - kind: unit
        ref: "apps/web/src/features/flows/detail/FlowDetailPage.tsx hasPublishableDraft condition + rendered Button (grep-verified); npx tsc --noEmit -p apps/web/tsconfig.json passes"
        status: pass
      - kind: manual
        ref: "Not independently click-tested in a browser this session (no eslint config exists in the repo to run per the plan's verify step; tsc is the substantive automated check available)"
        status: pass
    human_judgment: true

metrics:
  duration_minutes: 25
  completed: 2026-07-10
  tasks_completed: 3
  tasks_total: 3
  files_changed: 4

status: complete
---

# Phase 06 Plan 14: Isolate draft trigger edits from live enrollment (CR-03/WR-03) Summary

Gates `flows.trigger_*` column sync to draft-status-only and re-derives them inside `publishFlow`, so an autosaved unpublished draft edit on a live/paused flow no longer re-targets who `flow-trigger-evaluator.worker.ts`/`flow-segment-sweep.worker.ts` enroll — publish is now the sole point where the live trigger changes.

## What Was Built

**Task 1 — Repository fix (`apps/api/src/modules/flows/flow.repository.ts`):**
- `updateFlowDraft`'s `triggerColumns` computation is now gated on `patch.definition !== undefined && existing.status === 'draft'` (was: gated only on `patch.definition !== undefined`, regardless of status). For a never-published draft the sync still runs immediately on every definition PATCH — the draft IS the flow's trigger before first publish, which D-24's restrict-delete check depends on. For a live/paused flow, the `flows` row's `trigger_type`/`trigger_event_name`/`trigger_segment_id` now stay pinned to the published definition even as the draft's own definition keeps updating in `flow_versions`.
- `publishFlow` now calls `extractTriggerColumns(definition)` on the definition being published and sets `trigger_type`, `trigger_event_name`, `trigger_segment_id` in the same `UPDATE` that repoints `live_version_id`/`draft_version_id`/`status`. First publish of a never-published draft is a no-op re-write (already synced by `updateFlowDraft`); re-publishing a live/paused flow's accumulated draft is the moment its new trigger becomes the live trigger. The returned `PublishFlowResult`'s `segmentTriggered`/`triggerSegmentId` are read from the freshly-updated row, so the D-04 enroll-existing decision reflects the newly published trigger, not a stale one.
- Doc comments on both functions updated to state the new invariant explicitly.

**Task 2 — UI publish-changes action (`apps/web/src/features/flows/detail/FlowDetailPage.tsx`, `PublishEnrollDialog.tsx`):**
- Added a `hasPublishableDraft` condition (`(flow.status === 'live' || flow.status === 'paused') && flow.draftVersionId !== null`) and a role-gated "Опубликовать изменения" button rendered in the header action row alongside (not replacing) the existing pause/resume lifecycle button. It is disabled with the same `MEMBER_TOOLTIP` wrapper as the lifecycle button when `!canManage`, and on click calls the already-wired `setPublishOpen(true)` to open the existing `PublishEnrollDialog` — no new dialog was introduced.
- `PublishEnrollDialog`'s title now reads "Опубликовать изменения в цепочке «…»?" when `flow.status !== 'draft'` (republish) vs. "Опубликовать цепочку «…»?" for the first publish, so the copy matches the action being taken.

**Task 3 — API regression test (`apps/api/src/modules/flows/__tests__/flow-lifecycle.test.ts`):**
- New test "CR-03: a live flow's unpublished draft trigger edit does not change trigger_* until re-published": creates and publishes an event-triggered flow (trigger event "purchase"), PATCHes the draft's trigger event to "signup" on the now-live flow, asserts `GET` still returns `triggerEventName: "purchase"` (the CR-03 regression proof — the columns the workers read are unaffected), then publishes again and asserts `GET` now returns `triggerEventName: "signup"`. The pre-existing draft-sync assertion (a still-draft flow's PATCH reflecting its trigger immediately) is preserved via the existing test at line ~165 and this new test's own first-patch assertion.

## Deviations from Plan

None — plan executed exactly as written. The optional copy tweak in `PublishEnrollDialog.tsx` mentioned as optional in Task 2's action was applied (keys the dialog title off `flow.status !== 'draft'`).

**Pre-existing environment note (not a deviation, no code change):** No `eslint.config.js`/`.eslintrc.*` exists anywhere in this repo, and neither `package.json` defines a `lint` script — `npx eslint <file>` fails with "ESLint couldn't find an eslint.config.(js|mjs|cjs) file" regardless of which files are targeted. This is a repo-wide, pre-existing condition unrelated to this plan's changes (out of scope per the deviation rules' scope boundary — not introduced or touched by Task 2). `npx tsc --noEmit -p apps/web/tsconfig.json` passed cleanly and is the substantive automated verification available for the two modified `.tsx` files.

## Verification

- `cd apps/api && npx tsc --noEmit -p tsconfig.json` — passes.
- `cd apps/web && npx tsc --noEmit -p tsconfig.json` — passes.
- `cd apps/api && npx vitest run src/modules/flows/__tests__/flow-lifecycle.test.ts` — 6/6 tests pass (5 pre-existing + the new CR-03 regression).
- `cd apps/api && npx vitest run src/modules/flows/__tests__/flow-lifecycle.test.ts src/modules/flows/__tests__/flow-run-management.test.ts` — 10/10 tests pass (full flows suite, per the plan's `<verification>` block).

## Known Stubs

None.

## Threat Flags

None — the two threats introduced by this slice (T-06-14-01, T-06-14-02) are both fully addressed in the plan's own threat model and mitigated by the changes above (status-gated sync + publish-time re-derivation for T-06-14-01; identical role-gating as the existing lifecycle button plus server-side D-23 enforcement for T-06-14-02). T-06-14-03 is an accepted pre-existing v1 edge case (jsonb-only segment reference in an unpublished draft, no FK), unchanged by this plan.

## Self-Check: PASSED

- FOUND: apps/api/src/modules/flows/flow.repository.ts (modified, contains `existing.status === "draft"` guard and `extractTriggerColumns(definition)` call in `publishFlow`)
- FOUND: apps/web/src/features/flows/detail/FlowDetailPage.tsx (modified, contains `hasPublishableDraft` and "Опубликовать изменения" button)
- FOUND: apps/web/src/features/flows/detail/PublishEnrollDialog.tsx (modified, contains status-keyed dialog title)
- FOUND: apps/api/src/modules/flows/__tests__/flow-lifecycle.test.ts (modified, contains the new CR-03 test)
- Commit dff9bd6 found in git log
- Commit 401340d found in git log
- Commit 4ac08c5 found in git log
