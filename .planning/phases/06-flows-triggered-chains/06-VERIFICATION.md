---
phase: 06-flows-triggered-chains
verified: 2026-07-10T00:00:00Z
status: gaps_found
score: 1/4 must-haves verified
behavior_unverified: 0
overrides_applied: 0
gaps:
  - truth: "A contact entering via an event or by joining a segment moves through the flow — respecting delays and branch conditions — and leaves when an exit condition is met."
    status: failed
    reason: "CR-01 (verified independently in code): every producer of FLOW_RUN_ADVANCE_QUEUE jobs (delay-node.ts, send-node.ts, flow-reconciliation.worker.ts, flow-trigger-evaluator.worker.ts x2, flow-enroll-existing.worker.ts) uses the deterministic jobId: flowRunId, and the queue's DEFAULT_JOB_OPTIONS retain completed jobs for 24h (removeOnComplete: { age: 86400 }) and failed jobs forever (removeOnFail: false). BullMQ's Queue.add() with a reused jobId silently no-ops while a job with that id exists in ANY state (active/completed/failed). Send and branch nodes (flow-run-advance.worker.ts) additionally enqueue NO advance job at all after moving to the next node (WR-08) — forward progress after such a step depends entirely on the reconciliation scan, which itself is blocked by the same jobId-reuse bug for up to 24h after the prior advance job completes. Net effect: any flow with more than one send/branch/delay step stalls for up to 24h per step, or permanently once one advance job exhausts its 5 retries (removeOnFail: false leaves a permanent block). All engine tests (flow-run-advance.test.ts) call processFlowRunAdvance(data) directly, bypassing BullMQ's add-time dedupe, so this defect is untested."
    artifacts:
      - path: apps/worker/src/queues/flows/flow-queues.ts
        issue: "DEFAULT_JOB_OPTIONS (removeOnComplete: {age: 86400}, removeOnFail: false) applied to flowRunAdvanceQueue; combined with deterministic jobId: flowRunId reused by 6 producers, this silently drops wake nudges"
      - path: apps/worker/src/queues/flows/flow-run-advance.worker.ts
        issue: "Send-node and branch-node advance paths (lines ~211-232, ~279-283) set next_wake_at = now() and status = 'waiting' but enqueue no advance job — relies entirely on the (also-blocked) reconciliation backstop"
    missing:
      - "flowRunAdvanceQueue must not retain completed/failed jobs under a reusable jobId (removeOnComplete: true, removeOnFail: true), OR the wake jobId must be unique per wake (e.g. `${flowRunId}:${timestamp}`) so an in-flight/completed/failed job can never shadow a future wake"
      - "An integration test that exercises a real Queue/Worker pair (not a direct processFlowRunAdvance call) asserting a multi-step (2+ delay) run actually advances through all steps"
  - truth: "Re-entry control (once ever / once per N days / every time) and quiet hours are honored: no email is sent inside the quiet window, and it is deferred until the window ends."
    status: failed
    reason: "CR-02 (verified independently in code): three incompatible vocabularies exist for flows.quiet_hours_mode. packages/shared-schemas/src/flow.ts defines the API/UI enum as [\"workspace_default\", \"custom\", \"disabled\"] and apps/web/src/features/flows/detail/QuietHoursCard.tsx sends exactly those values ('custom' whenever the marketer sets an explicit window). apps/api/src/modules/flows/flow.repository.ts persists whatever the API receives verbatim. But apps/worker/src/queues/flows/flow-run-advance.worker.ts (FlowRunAdvanceRow.quietHoursMode typed \"inherit\"|\"override\"|\"disabled\") and handlers/send-node.ts's resolveQuietHoursWindow only branch on 'override' (`if (flow.quietHoursMode === 'override') { use flow's own window }`). A flow saved with quietHoursMode:'custom' never matches 'override' and falls into the inherit/workspace-default branch — the marketer's explicitly configured quiet window is never applied; emails go out during it. The only worker test exercising the deferral path (flow-run-advance.test.ts, 'a send node inside its flow's override quiet-hours window defers') seeds the DB column directly with 'override' (the worker's vocabulary), never through the real API path that would write 'custom' — so the mismatch is untested and undetected."
    artifacts:
      - path: packages/shared-schemas/src/flow.ts
        issue: "flowQuietHoursModeSchema = z.enum([\"workspace_default\", \"custom\", \"disabled\"]) — canonical API/UI vocabulary"
      - path: apps/worker/src/queues/flows/handlers/send-node.ts
        issue: "resolveQuietHoursWindow branches on 'disabled' / 'override' only; 'custom' (and 'workspace_default') both fall through to the inherit/workspace-default branch"
      - path: apps/api/src/modules/flows/flow.repository.ts
        issue: "persists quiet_hours_mode verbatim from the API request ('custom'/'workspace_default'/'disabled'), never translated to the worker's 'inherit'/'override' vocabulary"
    missing:
      - "One canonical enum for quiet_hours_mode shared by API, DB default, and worker (e.g. update the worker to branch on 'custom' instead of 'override', per the review's suggested fix)"
      - "A worker-side test that creates a flow row through the actual API/repository path with a custom quiet-hours window and asserts the deferral fires"
  - truth: "Editing a live flow happens in a draft that only takes effect on publish; contacts already mid-flight continue on the version they entered, with no duplicate or skipped sends."
    status: failed
    reason: "CR-03 (verified independently in code): apps/api/src/modules/flows/flow.repository.ts's updateFlowDraft computes `triggerColumns = patch.definition !== undefined ? extractTriggerColumns(patch.definition) : null` and syncs trigger_type/trigger_event_name/trigger_segment_id onto the flows row on every definition PATCH — unconditionally, regardless of flow status (draft/live/paused). Since the canvas autosaves on every change (useAutosaveDraft.ts), editing a live flow's trigger on the canvas immediately changes flows.trigger_event_name/trigger_segment_id. flow-trigger-evaluator.worker.ts and flow-segment-sweep.worker.ts both select live-flow enrollment candidates via `WHERE status = 'live' AND trigger_event_name = $2` / `trigger_segment_id IS NOT NULL` against those SAME columns — so live enrollment re-targets to the unpublished trigger before publish, while flows.live_version_id (and therefore the graph in-flight runs execute) still points at the old, published version. This directly contradicts the success criterion: an unpublished draft edit changes live behavior. Compounding this, WR-03 (also verified: apps/web/src/features/flows/detail/FlowDetailPage.tsx's lifecycleButton only renders 'Опубликовать' when flow.status === 'draft' — there is no UI action to publish an accumulated draft on a live/paused flow, so even the correct remediation path (publish the draft to make its trigger the new live trigger) has no UI entry point)."
    artifacts:
      - path: apps/api/src/modules/flows/flow.repository.ts
        issue: "updateFlowDraft syncs trigger_type/trigger_event_name/trigger_segment_id from the draft definition onto the flows row unconditionally (lines ~261-283), not gated on existing.status === 'draft'"
      - path: apps/worker/src/queues/flows/flow-trigger-evaluator.worker.ts
        issue: "matches live-flow enrollment candidates on flows.trigger_event_name / trigger_segment_id (lines ~53-55, ~92-98) — the same columns updateFlowDraft mutates pre-publish"
      - path: apps/web/src/features/flows/detail/FlowDetailPage.tsx
        issue: "lifecycleButton (lines ~143-156) renders no publish action for a live/paused flow with an accumulated draft (WR-03) — no UI path to correctly apply draft changes via publish"
    missing:
      - "Sync trigger columns from the draft only while status = 'draft'; for live/paused flows keep them pinned to the published definition and re-derive them inside publishFlow from the version being published"
      - "A UI action ('Опубликовать изменения') that opens the publish/enroll dialog when flow.draftVersionId is set on a live/paused flow"
      - "A test asserting that editing a live flow's draft trigger does NOT change flow-trigger-evaluator/segment-sweep enrollment behavior before publish"
deferred: []
---

# Phase 6: Flows — Triggered Chains Verification Report

**Phase Goal:** A marketer can visually build, publish, and run automated triggered chains that send the right email at the right time, reusing the proven send pipeline, suppression, and frequency cap.
**Verified:** 2026-07-10
**Status:** gaps_found
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (Roadmap Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A user can drag-and-drop a flow on the canvas with trigger, delay/wait, conditional branch, send-email, and explicit exit nodes per branch, then publish it (draft → live → paused). | ✓ VERIFIED | `flow-definition-schema.ts` defines all 5 node types (trigger/delay/branch/send/exit); `flow-validate.ts` enforces D-17 hard errors (no trigger, empty send, branch-missing-exit) server-side; `FlowCanvas.tsx`/`nodeTypes.tsx`/`NodePalette.tsx` implement drag-drop + binary Да/Нет branch edges; `flow.repository.ts` implements `createFlow`/`publishFlow`/`pauseFlow`/`resumeFlow` with `FlowStatus = "draft" \| "live" \| "paused"` and atomic version-snapshot-on-publish. Publish re-validates server-side (does not trust client `isValid`). |
| 2 | A contact entering via an event or by joining a segment moves through the flow — respecting delays and branch conditions — and leaves when an exit condition is met. | ✗ FAILED | **CR-01 confirmed in code** (see gap). Every advance-nudge producer reuses `jobId: flowRunId` against a queue that retains completed jobs 24h and failed jobs forever; BullMQ silently drops the re-`add()`. Send/branch steps enqueue no advance job at all (WR-08), leaning entirely on the reconciliation scan, which is itself blocked by the same bug. Any flow beyond a single step stalls for up to 24h per hop, or permanently after one retry-exhausted job. |
| 3 | Re-entry control (once ever / once per N days / every time) and quiet hours are honored: no email is sent inside the quiet window, and it is deferred until the window ends. | ✗ FAILED | Re-entry control (once_ever/once_per_n_days/every_time) is correctly implemented in `flow-reentry.ts` and enforced via `flow_runs_one_active_per_contact`. **However quiet hours fails**: **CR-02 confirmed in code** — API/UI vocabulary is `"workspace_default"\|"custom"\|"disabled"`, worker vocabulary is `"inherit"\|"override"\|"disabled"`, and the worker's `resolveQuietHoursWindow` only recognizes `"override"`. A flow with an explicit custom quiet-hours window (mode `"custom"`) is never gated — its window is silently ignored and emails send during the marketer's configured quiet period. |
| 4 | Editing a live flow happens in a draft that only takes effect on publish; contacts already mid-flight continue on the version they entered, with no duplicate or skipped sends. | ✗ FAILED | Version-pinning for in-flight runs IS correctly implemented (`flow_runs.flow_version_id` resolved everywhere, never `live_version_id`) — no duplicate/skipped sends from that angle. **But CR-03 confirmed in code**: `updateFlowDraft` unconditionally syncs the draft's trigger columns onto the live `flows` row on every autosaved PATCH, and the trigger evaluator/segment sweep select live-enrollment candidates against those same columns — so an in-progress (unpublished) canvas edit to a live flow's trigger immediately changes who gets enrolled, before publish. This is the literal negation of "only takes effect on publish." Additionally (WR-03) there is no UI control to publish an accumulated draft on a live/paused flow at all. |

**Score:** 1/4 truths verified (0 present-but-behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/flows-core/src/flow-definition-schema.ts` | 5 node types + edges Zod schema | ✓ VERIFIED | trigger/delay/branch/send/exit all present |
| `packages/flows-core/src/flow-validate.ts` | pure D-17 validator | ✓ VERIFIED | no-trigger / empty-send / branch-missing-exit checks present, DB-free |
| `apps/api/src/modules/flows/flow.repository.ts` | draft CRUD, publish/pause/resume, version pin | ⚠️ WIRED BUT DEFECTIVE | publish/version-pin logic correct; `updateFlowDraft`'s unconditional trigger-column sync is the CR-03 defect |
| `apps/worker/src/queues/flows/flow-run-advance.worker.ts` | state-machine step executor | ⚠️ WIRED BUT DEFECTIVE | re-reads run state correctly (queue-as-doorbell honored); send/branch steps enqueue no forward nudge (WR-08), compounding CR-01 |
| `apps/worker/src/queues/flows/flow-queues.ts` | advance queue producer | ✗ DEFECTIVE | `DEFAULT_JOB_OPTIONS` (`removeOnComplete: {age: 86400}`, `removeOnFail: false`) + deterministic `jobId: flowRunId` reused by 6 producers — CR-01 |
| `apps/worker/src/queues/flows/handlers/send-node.ts` | dispatch-time quiet-hours gate | ✗ DEFECTIVE | `resolveQuietHoursWindow` branches on `"override"`, never `"custom"` — CR-02 |
| `apps/web/src/features/flows/canvas/FlowCanvas.tsx` | drag-drop canvas | ✓ VERIFIED | ReactFlow with 5 custom node types, binary branch edges |
| `apps/web/src/features/flows/detail/FlowDetailPage.tsx` | lifecycle actions | ⚠️ ORPHANED (partial) | Publish button only rendered for `status === 'draft'`; no "publish draft changes" action for live/paused flows (WR-03) |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `apps/worker/src/queues/flows/handlers/send-node.ts` | `apps/worker/src/queues/send-dispatch.ts` | enqueues `kind:'flow'` job onto `email-triggered` queue | ✓ WIRED | Confirmed same queue, same `consumeTenantToken`, same pre-send gate reused (no forked dispatch path) |
| `apps/worker/src/queues/flows/flow-run-advance.worker.ts` | `flow_versions.definition` | resolves next node from pinned `flow_version_id`, never `live_version_id` | ✓ WIRED | `loadDueFlowRun` selects `fr.flow_version_id`; node resolution joins only through the run's pinned version |
| `apps/worker/src/queues/flows/handlers/delay-node.ts` / `send-node.ts` / `flow-reconciliation.worker.ts` / `flow-trigger-evaluator.worker.ts` / `flow-enroll-existing.worker.ts` | `apps/worker/src/queues/flows/flow-queues.ts` (`flowRunAdvanceQueue`) | wake nudge via `Queue.add(..., {jobId: flowRunId})` | ✗ NOT RELIABLY WIRED | All 6 producers share the same jobId per run against a queue that retains completed (24h)/failed (forever) jobs — `add()` silently no-ops after the first job for that run id exists in any of those states (CR-01) |
| `apps/api/src/modules/flows/flow.repository.ts` (`updateFlowDraft`) | `apps/worker/src/queues/flows/flow-trigger-evaluator.worker.ts` | shared `flows.trigger_event_name`/`trigger_segment_id` columns | ✗ INCORRECTLY WIRED | Columns are meant to reflect the *published* trigger for live flows but are overwritten from the *draft* on every autosave (CR-03) |
| `apps/web/src/features/flows/detail/QuietHoursCard.tsx` (writes `custom`/`workspace_default`/`disabled`) | `apps/worker/src/queues/flows/handlers/send-node.ts` (`resolveQuietHoursWindow`, expects `override`/`inherit`/`disabled`) | `flows.quiet_hours_mode` column | ✗ NOT WIRED (vocabulary mismatch) | CR-02 — see above |

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|-------------|-----------------|--------------|--------|----------|
| FLOW-01 | 01,02,03,04,05,07,08,09,10,11 | Visual canvas builder, 5 node types, publish | ✓ SATISFIED | Canvas + validator + storage all present and wired |
| FLOW-02 | 02,06,08 | Trigger by event or segment entry | ⚠️ PARTIALLY BLOCKED | Trigger matching logic present and correct in isolation, but CR-01 (wake-nudge loss) and CR-03 (draft-leaks-to-live trigger) undermine reliable end-to-end enrollment/advancement |
| FLOW-03 | 02,05,08 | Exit conditions | ✓ SATISFIED (logic) | `evaluateExitConditions` checked at step boundary before send — correct; blocked in practice only by CR-01's advancement stalls |
| FLOW-04 | 06,11 | Re-entry control | ✓ SATISFIED | `flow-reentry.ts` correctly implements once_ever/once_per_n_days/every_time + one-active-run guard |
| FLOW-05 | 07,11 | Quiet hours | ✗ BLOCKED | CR-02 — custom per-flow quiet hours never applied |
| FLOW-06 | 01,04,05,09,11 | draft → live → paused state machine | ⚠️ PARTIALLY BLOCKED | State machine itself correct; CR-03 means a "draft" edit on a live flow is not actually isolated from live behavior (trigger columns), and WR-03 means the UI has no path to publish that draft |
| FLOW-07 | 01,03,04,05,09 | Immutable published versions, in-flight pinning | ✓ SATISFIED | Verified: `flow_runs.flow_version_id` resolved everywhere, publish inserts a new `flow_versions` row and never mutates a referenced one, run-counter UI surfaces "on old versions" |

No orphaned requirements — all 7 FLOW-0X IDs from REQUIREMENTS.md are claimed across the 11 plans.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `apps/worker/src/queues/flows/flow-queues.ts` | 13-18 | Deterministic `jobId` reuse + long job retention on a "one-shot nudge" queue | 🛑 Blocker | CR-01 |
| `apps/api/src/modules/flows/flow.repository.ts` | 261-283 | Unconditional trigger-column sync from draft regardless of flow status | 🛑 Blocker | CR-03 |
| `apps/worker/src/queues/flows/handlers/send-node.ts` | 14, 67-80 | Vocabulary mismatch vs. `packages/shared-schemas/src/flow.ts` enum | 🛑 Blocker | CR-02 |
| `apps/web/src/features/flows/detail/FlowDetailPage.tsx` | 143-156 | No publish action rendered for live/paused flow with pending draft | ⚠️ Warning | WR-03, compounds CR-03's remediation gap |
| `apps/worker/src/queues/flows/flow-run-advance.worker.ts` | 211-232, 279-283 | Send/branch steps enqueue no forward advance nudge | ⚠️ Warning | WR-08, compounds CR-01 |

No unresolved `TBD`/`FIXME`/`XXX` markers found in the flow-specific files reviewed (debt-marker gate not triggered by this scope).

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Advance-queue test coverage does not exercise real BullMQ dedupe | `grep -n "processFlowRunAdvance(" apps/worker/src/queues/__tests__/flow-run-advance.test.ts` | All 6 test call sites invoke `processFlowRunAdvance(data)` directly | ✓ CONFIRMS review claim — no real-Queue integration test exists |
| Quiet-hours deferral test uses worker vocabulary, not API vocabulary | `grep -n "quietHoursMode" apps/worker/src/queues/__tests__/flow-run-advance.test.ts` | Test helper seeds DB directly with `opts.quietHoursMode ?? "inherit"`, and the override-window test passes `"override"` — never the API's `"custom"` | ✓ CONFIRMS the CR-02 mismatch is untested through the real write path |
| `updateFlowDraft` trigger-column sync is gated on flow status | `sed -n '253-268p' apps/api/src/modules/flows/flow.repository.ts` | `triggerColumns` computed and applied whenever `patch.definition !== undefined`, with no `existing.status === "draft"` check anywhere in the function | ✓ CONFIRMS CR-03 |

### Probe Execution

No `scripts/*/tests/probe-*.sh` files exist in this repository and no probes are declared in the phase's PLAN/SUMMARY files. Step 7c: SKIPPED (no probes declared or discovered).

### Human Verification Required

None — the 3 critical defects were independently confirmed by direct code inspection (not requiring runtime observation), and are sufficient on their own to determine `gaps_found`.

### Gaps Summary

Three review-flagged Critical defects were independently reproduced by reading the actual source (not trusting the review report or any SUMMARY.md claim):

1. **CR-01 — Advance-queue wake nudges are silently dropped.** All 6 producers of `FLOW_RUN_ADVANCE_QUEUE` jobs share the deterministic `jobId: flowRunId`, and the queue configuration retains completed jobs 24h / failed jobs forever. This makes multi-step runs stall for up to 24h per step, or permanently after a single retry-exhausted job — directly negating success criterion 2 ("moves through the flow ... respecting delays and branch conditions").
2. **CR-02 — Custom quiet hours are never enforced.** The API/UI persist `quietHoursMode: "custom"`, the worker only recognizes `"override"`. A marketer's configured quiet window is silently ignored — directly negating success criterion 3 ("no email is sent inside the quiet window").
3. **CR-03 — Draft edits to a live flow leak into live enrollment before publish.** `updateFlowDraft` syncs trigger columns from the unpublished draft onto the live `flows` row unconditionally, and the trigger evaluator/segment sweep read those same columns for live enrollment — directly negating success criterion 4 ("editing a live flow happens in a draft that only takes effect on publish"). Compounded by WR-03: no UI action exists to publish the accumulated draft on a live/paused flow at all.

Success criterion 1 (canvas builder + draft→live→paused state machine + version immutability, FLOW-07) is solidly implemented and verified. Re-entry control (part of success criterion 3) is also correctly implemented. The phase delivers real, substantial, well-architected work (tenant isolation, send-pipeline reuse, version pinning) — but 3 of 4 roadmap success criteria are not fully met as shipped, due to concrete, independently-reproduced defects rather than review false-positives.

These are not edge cases: CR-01 breaks the basic "contact moves through a multi-step flow" happy path; CR-02 breaks the phase's headline quiet-hours guarantee for the exact configuration path the UI exposes; CR-03 breaks the phase's core versioning/safety promise for the most common editing scenario (tweaking a live flow's canvas).

**Recommendation:** Do not proceed to the next phase until CR-01, CR-02, and CR-03 are fixed and each is covered by a regression test that exercises the real code path (real BullMQ Queue/Worker pair for CR-01; a flow row created through the actual API for CR-02; an `updateFlowDraft` call against a live flow asserting the trigger evaluator's candidate set is unchanged for CR-03).

---

_Verified: 2026-07-10_
_Verifier: Claude (gsd-verifier)_
