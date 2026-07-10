---
phase: 06-flows-triggered-chains
reviewed: 2026-07-10T00:00:00Z
depth: standard
files_reviewed: 79
files_reviewed_list:
  - apps/api/src/modules/campaigns/send-settings.routes.ts
  - apps/api/src/modules/contacts/contact.repository.ts
  - apps/api/src/modules/contacts/contacts.routes.ts
  - apps/api/src/modules/flows/flow-queues.ts
  - apps/api/src/modules/flows/flow-run.repository.ts
  - apps/api/src/modules/flows/flow-validation.ts
  - apps/api/src/modules/flows/flow-version.repository.ts
  - apps/api/src/modules/flows/flow.repository.ts
  - apps/api/src/modules/flows/flows.routes.ts
  - apps/api/src/modules/segments/segment.repository.ts
  - apps/api/src/server.ts
  - apps/web/src/App.tsx
  - apps/web/src/components/ui/switch.tsx
  - apps/web/src/features/app-shell/AppShell.tsx
  - apps/web/src/features/campaigns/SendSettingsPage.tsx
  - apps/web/src/features/contacts/ContactForm.tsx
  - apps/web/src/features/contacts/CsvImportWizard.tsx
  - apps/web/src/features/contacts/TimezoneCombobox.tsx
  - apps/web/src/features/flows/FlowStatusBadge.tsx
  - apps/web/src/features/flows/api.ts
  - apps/web/src/features/flows/canvas/FlowCanvas.tsx
  - apps/web/src/features/flows/canvas/NodeConfigPanel.tsx
  - apps/web/src/features/flows/canvas/NodePalette.tsx
  - apps/web/src/features/flows/canvas/nodeTypes.tsx
  - apps/web/src/features/flows/canvas/useAutosaveDraft.ts
  - apps/web/src/features/flows/detail/FlowDetailPage.tsx
  - apps/web/src/features/flows/detail/FlowLifecycleSettings.tsx
  - apps/web/src/features/flows/detail/FlowRunsTable.tsx
  - apps/web/src/features/flows/detail/PublishEnrollDialog.tsx
  - apps/web/src/features/flows/detail/QuietHoursCard.tsx
  - apps/web/src/features/flows/list/FlowsListPage.tsx
  - apps/worker/src/queues/events-ingest.worker.ts
  - apps/worker/src/queues/flows/flow-enroll-existing.worker.ts
  - apps/worker/src/queues/flows/flow-exit-conditions.ts
  - apps/worker/src/queues/flows/flow-queues.ts
  - apps/worker/src/queues/flows/flow-reconciliation.worker.ts
  - apps/worker/src/queues/flows/flow-reentry.ts
  - apps/worker/src/queues/flows/flow-run-advance.worker.ts
  - apps/worker/src/queues/flows/flow-segment-sweep.worker.ts
  - apps/worker/src/queues/flows/flow-send.ts
  - apps/worker/src/queues/flows/flow-trigger-evaluator.worker.ts
  - apps/worker/src/queues/flows/handlers/branch-node.ts
  - apps/worker/src/queues/flows/handlers/delay-node.ts
  - apps/worker/src/queues/flows/handlers/exit-node.ts
  - apps/worker/src/queues/flows/handlers/send-node.ts
  - apps/worker/src/queues/send-dispatch.ts
  - apps/worker/src/server.ts
  - apps/worker/src/test/db-fixture.ts
  - packages/contacts-core/src/contact-repository.ts
  - packages/contacts-core/src/csv-mapping.ts
  - packages/db/migrations/0026_flows.sql
  - packages/db/migrations/0027_flows_scheduler_scan_policy.sql
  - packages/db/migrations/0028_sends_flow_columns.sql
  - packages/db/migrations/0029_contacts_timezone.sql
  - packages/db/migrations/0030_workspace_send_settings_timezone_quiet_hours.sql
  - packages/db/migrations/0031_flows_exit_conditions.sql
  - packages/db/migrations/0032_flows_segment_sweep_scan_policy.sql
  - packages/db/migrations/0033_flows_enroll_cursor.sql
  - packages/db/src/index.ts
  - packages/db/src/schema/contacts.ts
  - packages/db/src/schema/flow-run-steps.ts
  - packages/db/src/schema/flow-runs.ts
  - packages/db/src/schema/flow-segment-membership-snapshot.ts
  - packages/db/src/schema/flow-versions.ts
  - packages/db/src/schema/flows.ts
  - packages/db/src/schema/sends.ts
  - packages/db/src/schema/workspace-send-settings.ts
  - packages/delivery-core/src/index.ts
  - packages/delivery-core/src/quiet-hours.ts
  - packages/delivery-core/src/send-ledger.ts
  - packages/delivery-core/src/send-mail.ts
  - packages/delivery-core/src/send-settings.ts
  - packages/flows-core/src/flow-definition-schema.ts
  - packages/flows-core/src/flow-validate.ts
  - packages/flows-core/src/index.ts
  - packages/flows-core/src/wait-until.ts
  - packages/shared-schemas/src/campaign.ts
  - packages/shared-schemas/src/contact.ts
  - packages/shared-schemas/src/flow.ts
  - packages/shared-schemas/src/index.ts
  - packages/shared-schemas/src/queues.ts
findings:
  critical: 3
  warning: 9
  info: 7
  total: 19
status: issues_found
---

# Phase 6: Code Review Report

**Reviewed:** 2026-07-10
**Depth:** standard
**Files Reviewed:** 79
**Status:** issues_found

## Summary

Phase 6 (triggered flows) was reviewed end-to-end: DB migrations 0026-0033, the flows-core validation package, the flow API (routes + repositories), the execution-engine workers (advance / reconciliation / trigger-evaluator / segment-sweep / enroll-existing), the send-pipeline extension (`kind: 'flow'`), and the @xyflow/react canvas UI.

The strong points are real: tenant isolation is consistently double-enforced (RLS ENABLE+FORCE with the NULLIF guard from the first migration, plus explicit `workspace_id` predicates in every query, plus narrow SELECT-only `app.admin_scan` policies for the two cross-tenant discovery scans); the send path reuses the exact same pre-send gate / per-tenant token bucket / three-unit claim-send-record discipline as campaigns, with a partial unique index (`sends_flow_run_node_unique`) as the DB-level idempotency backstop; and version pinning (`flow_runs.flow_version_id`, never `live_version_id`) is honored everywhere in the engine.

However, three critical defects will cause incorrect production behavior:

1. **The engine's wake mechanism is self-blocking.** Every advance-nudge producer reuses `jobId: flowRunId` while the queue retains completed jobs for 24h (`removeOnComplete: { age: 86400 }`) and failed jobs forever (`removeOnFail: false`). BullMQ silently ignores an `add()` whose jobId still exists in *any* state — including active, completed, and failed. Multi-step runs therefore stall for up to 24h per step (permanently, after one poison job). Integration tests invoke `processFlowRunAdvance` directly and cannot catch this.
2. **Per-flow custom quiet hours are silently ignored** because the API writes `quiet_hours_mode = 'custom'` while the worker branches on `'override'`.
3. **Editing a live flow's draft trigger immediately changes live enrollment** because `updateFlowDraft` syncs `trigger_*` columns from the *draft* definition and the trigger evaluator matches live flows on those columns.

## Critical Issues

### CR-01: Advance-queue jobId reuse + retained completed/failed jobs silently drops wake nudges — multi-step runs stall up to 24h (or forever)

**File:** `apps/worker/src/queues/flows/flow-queues.ts:13-18, 51-54`; `apps/worker/src/queues/flows/handlers/delay-node.ts:71-75`; `apps/worker/src/queues/flows/handlers/send-node.ts:130-134`; `apps/worker/src/queues/flows/flow-reconciliation.worker.ts:114`; `apps/worker/src/queues/flows/flow-trigger-evaluator.worker.ts:188, 283`; `apps/worker/src/queues/flows/flow-enroll-existing.worker.ts:126`

**Issue:** All six producers of `FLOW_RUN_ADVANCE_QUEUE` jobs use the deterministic `jobId: flowRunId`, and the queue's `DEFAULT_JOB_OPTIONS` are `removeOnComplete: { age: 86400 }, removeOnFail: false`. In BullMQ, `Queue.add()` with a custom jobId is a **silent no-op if a job with that id exists in any state — active, delayed, waiting, completed, or failed** — until the old job is physically removed. Consequences:

- **Delay nodes never get their low-latency wake.** The active advance job being processed usually *itself* has `jobId = flowRunId` (it came from the reconciliation scan, the trigger evaluator, or a prior delay). `handleDelayNode`'s `flowRunAdvanceQueue.add(..., { jobId: flowRunId, delay })` is therefore ignored while that job is active.
- **The reconciliation backstop is also blocked.** After the advance job completes, its job hash lingers in the completed set for up to 24h. Every reconciliation tick's `add(..., { jobId: row.id })` (line 114) for that run is silently dropped for that entire window. A run that reaches a send/branch node (which sets `next_wake_at = now()` and enqueues nothing — see WR-08) or a delay node **stalls until the completed job ages out (~24h per step)**.
- **Permanent stall on failure.** With `removeOnFail: false`, one advance job that exhausts its 5 attempts leaves a failed job with `jobId = flowRunId` in Redis forever — after which *no* mechanism (delay wake, quiet-hours wake, reconciliation) can ever enqueue another advance for that run. The run is bricked.
- The quiet-hours deferral wake (`send-node.ts:130-134`, same `jobId: flowRunId`) is dropped for the same reason whenever the active/completed job shares the id.

The engine's own tests pass because they call `processFlowRunAdvance(data)` directly, bypassing BullMQ's add-time dedupe entirely.

**Fix:**
```ts
// flow-queues.ts — advance queue: never retain finished jobs, they only exist as one-shot nudges
export const flowRunAdvanceQueue = new Queue<FlowRunAdvanceJob>(FLOW_RUN_ADVANCE_QUEUE, {
  connection: buildRedisConnectionOptions(requireRedisUrl()),
  defaultJobOptions: { ...DEFAULT_JOB_OPTIONS, removeOnComplete: true, removeOnFail: true },
});
```
plus make the wake jobId unique per wake so an in-flight job with the same run id can never shadow a *future* wake:
```ts
// delay-node.ts / send-node.ts / reconciliation
{ jobId: `${flowRunId}:${nextWakeAt.getTime()}`, delay: ... }
```
(The queue-as-doorbell design already makes duplicate nudges harmless — `loadDueFlowRun`'s guards no-op them — so dedupe only needs to prevent unbounded stacking, which BullMQ's `deduplication` option or the timestamped jobId both achieve without blocking future wakes.) Add an integration test that goes through a real `Queue`/`Worker` pair and asserts a two-delay run advances twice.

### CR-02: `quiet_hours_mode` value mismatch between API and worker — per-flow custom quiet hours are never applied

**File:** `packages/shared-schemas/src/flow.ts:17` (enum `["workspace_default", "custom", "disabled"]`); `apps/api/src/modules/flows/flow.repository.ts:132-134` (writes `'workspace_default'`); `apps/worker/src/queues/flows/flow-run-advance.worker.ts:25` and `apps/worker/src/queues/flows/handlers/send-node.ts:14, 67-80` (expects `"inherit" | "override" | "disabled"`); `packages/db/migrations/0026_flows.sql:23` / `packages/db/src/schema/flows.ts:40` (default `'inherit'`, comment documents `"inherit" | "override" | "disabled"`)

**Issue:** Three different vocabularies exist for the same column. The API layer persists exactly what the UI sends: `'workspace_default'`, `'custom'`, or `'disabled'` (see `QuietHoursCard.tsx:57-69`). The worker's `resolveQuietHoursWindow` branches:

```ts
if (flow.quietHoursMode === "disabled") return null;
if (flow.quietHoursMode === "override") { /* use flow's own window */ }
else { /* inherit workspace default */ }
```

A flow configured with a **custom** quiet-hours window (`'custom'`) never matches `"override"` and falls into the inherit branch — its own `quiet_hours_start/end` are ignored and the workspace default (or *no gate at all*, if workspace quiet hours are disabled) is used instead. The marketer's explicitly configured quiet window is silently violated: emails go out during it. `'workspace_default'` only works by accident (falls through to the inherit branch). The stored data itself is inconsistent: DB default is `'inherit'`, app-created rows are `'workspace_default'`.

**Fix:** Pick one canonical enum. Simplest: update the worker to the API vocabulary —
```ts
if (flow.quietHoursMode === "disabled") return null;
if (flow.quietHoursMode === "custom") { startMinutes = flow.quietHoursStart; endMinutes = flow.quietHoursEnd; }
else { /* 'workspace_default' / legacy 'inherit' -> workspace window */ }
```
update the `FlowRunAdvanceRow`/`FlowQuietHoursConfig` types, change the DB default from `'inherit'` to `'workspace_default'` in a follow-up migration (with an `UPDATE ... SET quiet_hours_mode='workspace_default' WHERE quiet_hours_mode='inherit'` backfill), and add a worker-side test using a `'custom'` flow row created through the actual API path.

### CR-03: Draft edits leak into live behavior — `updateFlowDraft` syncs trigger columns from the unpublished draft while the flow is live

**File:** `apps/api/src/modules/flows/flow.repository.ts:261-307` (trigger sync); `apps/worker/src/queues/flows/flow-trigger-evaluator.worker.ts:50-59, 91-103` (matches live flows on `flows.trigger_event_name`/`trigger_segment_id`); `apps/worker/src/queues/flows/flow-segment-sweep.worker.ts:52-58`

**Issue:** `updateFlowDraft` unconditionally mirrors the *draft* definition's trigger node onto the `flows` row (`trigger_type`, `trigger_event_name`, `trigger_segment_id`) on every definition PATCH — including for a **live** flow (D-20 explicitly allows editing a live flow's draft; the canvas autosaves on every change). But the trigger evaluator and segment sweep select enrollment candidates via `WHERE status = 'live' AND trigger_event_name = $2` / `trigger_segment_id IS NOT NULL` against those same columns. The moment a marketer changes the trigger on the canvas of a live flow — *without publishing* — live enrollment switches to the new trigger while `live_version_id` still points at the old graph:

- New contacts enroll on an event/segment the published version was never configured for (they then execute the *old* pinned definition — a mismatched trigger/graph pair).
- Contacts matching the *published* trigger silently stop enrolling.
- For segment triggers, the sweep starts diffing an entirely different segment's membership against the snapshot, mass-enrolling contacts the live version never targeted.

This violates the FLOW-06/FLOW-07 publish-pinning contract that the rest of the phase is carefully built around.

**Fix:** Sync trigger columns from the draft only while `status = 'draft'` (needed for the enroll-preview route); for live/paused flows, keep the columns pinned to the published definition and re-derive them inside `publishFlow` from the version being published:
```ts
const syncTrigger = patch.definition !== undefined && existing.status === "draft";
```
and in `publishFlow`, after validation, `extractTriggerColumns(definition)` → include in the publish UPDATE. The enroll-preview dialog for an unpublished trigger change can read the draft definition directly instead of the flows row.

## Warnings

### WR-01: Cycle in the graph passes `branch_missing_exit` validation, and the engine has no loop guard

**File:** `packages/flows-core/src/flow-validate.ts:104-124`; `apps/worker/src/queues/flows/flow-run-advance.worker.ts` (no revisit guard)
**Issue:** `pathReachesExit` treats a revisited node as satisfied (`if (visited.has(nodeId)) return true`). A branch whose "yes" path is a pure cycle (e.g., delay → branch → back to delay) with no exit node anywhere validates clean and can be published. At runtime nothing detects revisits: a cyclic run re-executes delay nodes forever (a perpetual run that never terminates; send nodes in the cycle are only saved from re-sending by the `(flow_run_id, node_id)` claim dedupe). The schema and the canvas both permit constructing cycles (`isValidConnection` only blocks self-loops).
**Fix:** In the DFS, distinguish "in current path" (cycle → return `false`) from "already proven" (memoized `true`). Optionally add an engine-side guard: if `flow_run_steps` already contains this `(run, node)` visit for a non-send node beyond a threshold, eject the run with a distinct `exit_reason` instead of looping.

### WR-02: An unconfigured trigger node passes server-side publish validation — live flow that can never enroll

**File:** `packages/flows-core/src/flow-validate.ts:45-48`; `packages/flows-core/src/flow-definition-schema.ts:27-34` (`eventName`/`segmentId` optional)
**Issue:** `validateFlowDefinition` only checks that exactly one trigger node exists — not that it is configured. A trigger with `triggerType: 'event'` and no `eventName` (or `'segment'` with no `segmentId`) is schema-valid, is serialized by the canvas, and publishes successfully; `flows.trigger_event_name` ends up NULL, `loadLiveEventTriggeredFlows` matches on `trigger_event_name = $2`, so the flow is live but never enrolls anyone — silently. The canvas *does* flag this client-side (`FlowCanvas.tsx:185-191`), but the server — the stated authority (Pitfall 3) — accepts it.
**Fix:** Add a `trigger_unconfigured` (or extend `no_trigger`) hard error in `validateFlowDefinition` when `triggerType === 'event' && !eventName` or `triggerType === 'segment' && !segmentId`, and map it in `flow-validation.ts`.

### WR-03: No UI path to publish an edited draft of a live/paused flow

**File:** `apps/web/src/features/flows/detail/FlowDetailPage.tsx:143-156`
**Issue:** The lifecycle button renders "Опубликовать" only for `status === 'draft'`; a live flow shows only "Приостановить" and a paused one only "Возобновить". Per D-20, editing a live flow's canvas lazily creates a new working draft (`draft_version_id` set), and `publishFlow` fully supports re-publishing it — but no UI control triggers it. Canvas edits to a live flow accumulate in a draft that can never go live from the app, which is also the only correct remediation path for CR-03.
**Fix:** When `flow.draftVersionId !== null` on a live/paused flow, render a "Опубликовать изменения" action that opens the same `PublishEnrollDialog`.

### WR-04: `flows.enroll_cursor` is never reset — re-publish with "enroll existing" resumes from the previous pass's cursor

**File:** `apps/api/src/modules/flows/flow.repository.ts:363-372` (publish UPDATE omits `enroll_cursor`); `apps/worker/src/queues/flows/flow-enroll-existing.worker.ts:205-209, 139-142`; `packages/db/migrations/0033_flows_enroll_cursor.sql`
**Issue:** The migration comment defines the cursor as scoped to "this flow's current enroll-existing pass", but nothing ever resets it. After a completed back-fill the cursor sits at the last contact id; a later re-publish (new `liveVersionId` → new jobId → the job runs again) reads the stale cursor and keyset-skips every contact whose uuid sorts at or below it. The 15-minute segment sweep eventually enrolls unseen matching contacts, so the impact is mostly a silent partial back-fill plus up to 15 minutes of unexpected latency — but the "Зачислить и опубликовать" choice does not do what it says on re-publish.
**Fix:** `UPDATE flows SET enroll_cursor = NULL` inside `publishFlow`'s publish UPDATE (or at the start of a new enroll pass, keyed by `flowVersionId`).

### WR-05: Segment-triggered enrollment is one-shot forever — snapshot rows are never pruned, so leave-and-re-enter never re-triggers and `every_time` is inert

**File:** `apps/worker/src/queues/flows/flow-trigger-evaluator.worker.ts:127-147, 206-217`; `apps/worker/src/queues/flows/flow-segment-sweep.worker.ts:110-115`
**Issue:** Both the event-driven re-check and the sweep skip any contact present in `flow_segment_membership_snapshot`, and rows are inserted on first sight and never deleted when a contact leaves the segment. A contact who exits the trigger segment and later re-enters it will never enroll again — regardless of the flow's configured `reentry_mode`, including `every_time`. `enterSegmentTriggeredFlow` also marks "seen" when `canEnterFlow` denies for `active_run`, so a contact who was in-flow at first sighting is permanently excluded from future segment entries. The re-entry settings UI (`FlowLifecycleSettings`) offers all three modes for segment-triggered flows with no hint that they are effectively meaningless. If one-shot-per-contact is the intended D-02 semantic, the UI and `canEnterFlow` interplay should say so; if not, departed contacts must be removed from the snapshot (the sweep already computes current membership and could diff both directions).
**Fix:** Either prune snapshot rows for contacts no longer in the segment during the sweep (making re-entry subject to `canEnterFlow` as the mode implies), or document/enforce one-shot semantics (hide re-entry modes for segment triggers in the UI).

### WR-06: BullMQ jobs are enqueued inside open DB transactions

**File:** `apps/worker/src/queues/flows/handlers/send-node.ts:130-143`; `handlers/delay-node.ts:71-75`; `flow-trigger-evaluator.worker.ts:188, 283` and `flow-enroll-existing.worker.ts:126` (inside `withTenantTransaction`)
**Issue:** The queue add and the `flow_runs`/`flow_run_steps` writes are not atomic. If the transaction rolls back *after* the add (e.g., a later statement in the trigger-evaluator's multi-flow loop throws), the enqueued job survives: an orphan advance nudge fires for a run row that was never committed (no-ops, but with CR-01's jobId reuse it then *blocks* the retried insert's legitimate nudge), and an enqueued `email-triggered` send job for a rolled-back advance will still dispatch the email — the run's `current_node_id` was never moved, so the eventual re-advance re-processes the same send node and only the `claimFlowSend` ledger prevents a duplicate email. The convergence depends entirely on ledger idempotency rather than on ordering.
**Fix:** Move queue adds after the transaction commits (return the intended enqueues from the transaction closure and add them outside), mirroring how `flow-reconciliation.worker.ts` already enqueues only after `transitionAndNudge`'s transaction returns.

### WR-07: `deleteSegment`'s 23503 fallback queries an aborted transaction — 500 instead of the intended 409

**File:** `apps/api/src/modules/segments/segment.repository.ts:370-403`
**Issue:** When the DELETE trips a foreign-key violation (23503), the catch block calls `findReferencingFlowName(client, ...)` on the *same* client — but the transaction is already in the aborted state, so that SELECT throws `25P02: current transaction is aborted`, replacing the intended `SegmentConflictError` (409) with an unhandled 500. The canceled-campaign case this fallback was built for (pre-check passes, FK still fires) now always 500s, and the flow-disambiguation branch is unreachable.
**Fix:** Wrap the DELETE in a `SAVEPOINT`/`ROLLBACK TO SAVEPOINT` (like `upsertContactByIdentity`'s CR-02 pattern in `packages/contacts-core/src/contact-repository.ts:247-283`), or perform the disambiguation queries on a fresh transaction after rollback.

### WR-08: Send/branch steps never enqueue the next advance — every hop leans on the 60s reconciliation scan

**File:** `apps/worker/src/queues/flows/flow-run-advance.worker.ts:211-215, 279-283`
**Issue:** After a send or branch node, the run is set to `next_wake_at = now(), status = 'waiting'` with **no** advance job enqueued; forward progress depends entirely on the reconciliation backstop (60s cadence). The reconciliation worker's own doc comment declares itself "a BACKSTOP, not the low-latency path", but for send→next and branch→next it *is* the only path: a 5-step flow incurs up to ~5 minutes of pure scheduling latency even when nothing is wrong (and, until CR-01 is fixed, stalls outright). This also concentrates all steady-state advancement into the single serial reconciliation tick loop.
**Fix:** Enqueue an immediate advance nudge (post-commit, per WR-06) after the send/branch `UPDATE` when `next_wake_at` is `now()`.

### WR-09: Autosave silently discards unconfigured nodes and their edges — user work lost on reload

**File:** `apps/web/src/features/flows/canvas/useAutosaveDraft.ts:28-61`
**Issue:** `serializeCanvas` drops any node that fails `flowNodeSchema` (a freshly dragged delay with no delay config, a branch with no segment) plus every edge touching it, and the debounced PATCH persists that reduced definition. The dropped nodes exist only in local React state: a page reload, tab close, or navigating between flows loses them — and because the *pruned* definition was saved, positions/wiring around them are gone too. Nothing warns the user; the toolbar says "Сохранено".
**Fix:** Persist incomplete nodes too (make config fields nullable in a draft-only envelope, or store the raw canvas alongside the validated definition), or at minimum surface "N узлов не сохранено — заполните настройки" instead of "Сохранено" while `incompleteNodeIds.length > 0`.

## Info

### IN-01: `advancing` run status is never set by production code

**File:** `packages/db/src/schema/flow-runs.ts:20-26`; `apps/worker/src/queues/flows/flow-run-advance.worker.ts:142`
**Issue:** The engine transitions runs among `waiting`/`completed`/`exited`/`ejected` only; `advancing` appears solely in guards, the partial unique index, and the test fixture (`db-fixture.ts:170`). Dead state today; if it is reserved for a future claim step, document that, otherwise drop it from guards to avoid implying a transition that never happens.

### IN-02: `flow_run_steps.send_id` is never populated

**File:** `packages/db/src/schema/flow-run-steps.ts:25`; `apps/worker/src/queues/flows/flow-run-advance.worker.ts:86-96`
**Issue:** The column exists precisely to link a send-node step to its `sends` row, but `appendFlowRunStep` never accepts/sets it, so the per-step audit trail can't be joined to delivery status. Pass the deterministic ledger row (or look it up by `(flow_run_id, node_id)`) when recording the `enqueued` outcome.

### IN-03: Misleading step outcomes on dead-end fallbacks

**File:** `apps/worker/src/queues/flows/flow-run-advance.worker.ts:216-232, 251-266`
**Issue:** When a send/delay node has no outgoing edge, the run is completed (`reached_exit`) but the step log still records `outcome: "enqueued"` / `"waiting"` — the audit trail contradicts what actually happened. Record a distinct `dead_end_completed` outcome in the fallback branches.

### IN-04: `once_per_n_days` fails open when `reentry_window_days` is NULL

**File:** `apps/worker/src/queues/flows/flow-reentry.ts:82` (`reentryWindowDays ?? 0`)
**Issue:** A row with `reentry_mode = 'once_per_n_days'` and a NULL window (possible via direct writes or drift, since the DB has no CHECK and `updateFlowDraft` can't null it but older rows could) makes the window 0 days → always allowed. Fail closed (treat NULL window as `once_ever` or deny with a reason) to match the function's own "unknown mode: fail closed" posture.

### IN-05: Helper duplication

**File:** `apps/web/src/features/flows/canvas/NodeConfigPanel.tsx:270-281`, `apps/web/src/features/flows/detail/QuietHoursCard.tsx:21-32`, `apps/web/src/features/campaigns/SendSettingsPage.tsx:31-42` (identical `minutesToHhMm`/`hhMmToMinutes` x3); `packages/delivery-core/src/quiet-hours.ts` vs `packages/flows-core/src/wait-until.ts` (identical `getZonedParts`/`offsetMsAt`/`zonedTimeToUtc`/`addCalendarDays`)
**Issue:** Three copies of the time-string helpers in the web app (extract to a shared util), and the zone-math block is duplicated across two packages — the latter is documented as deliberate, but a DST bug now needs fixing in two places; a tiny shared `@mega-crm/time-core` (or moving `wait-until` into delivery-core) would remove the drift risk.

### IN-06: Trigger-check jobId dedupe can drop a re-used eventId's flow check

**File:** `apps/worker/src/queues/events-ingest.worker.ts:60-64`
**Issue:** The flow-trigger job uses `jobId: ${workspaceId}-${eventId}-flow-trigger`, but the events table dedupes on `(workspace_id, id, occurred_at)` — a client re-sending the same `eventId` with a *different* `occurredAt` inserts a genuinely new event whose trigger evaluation is silently dropped while the prior job lingers (same BullMQ retention semantics as CR-01). Include `occurredAt` in the jobId.

### IN-07: CSV import completion toast says success for a failed import

**File:** `apps/web/src/features/contacts/CsvImportWizard.tsx:405-410`
**Issue:** `toast.success("Импорт завершён")` fires for both `done` and `failed` statuses; a failed import gets a green success toast (the card below does show the failure). Use `toast.error` for `failed`.

---

_Reviewed: 2026-07-10_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
