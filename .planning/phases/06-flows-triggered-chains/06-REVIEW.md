---
phase: 06-flows-triggered-chains
reviewed: 2026-07-10T09:41:04Z
depth: standard
files_reviewed: 21
files_reviewed_list:
  - apps/api/src/modules/flows/__tests__/flow-lifecycle.test.ts
  - apps/api/src/modules/flows/flow.repository.ts
  - apps/web/src/features/flows/detail/FlowDetailPage.tsx
  - apps/web/src/features/flows/detail/PublishEnrollDialog.tsx
  - apps/worker/src/queues/__tests__/flow-run-advance-integration.test.ts
  - apps/worker/src/queues/__tests__/flow-run-advance.test.ts
  - apps/worker/src/queues/__tests__/flow-segment-trigger.test.ts
  - apps/worker/src/queues/__tests__/flow-trigger-evaluator.test.ts
  - apps/worker/src/queues/flows/flow-enroll-existing.worker.ts
  - apps/worker/src/queues/flows/flow-queues.ts
  - apps/worker/src/queues/flows/flow-reconciliation.worker.ts
  - apps/worker/src/queues/flows/flow-run-advance.worker.ts
  - apps/worker/src/queues/flows/flow-trigger-evaluator.worker.ts
  - apps/worker/src/queues/flows/handlers/delay-node.ts
  - apps/worker/src/queues/flows/handlers/send-node.ts
  - apps/worker/vitest.config.ts
  - packages/db/migrations/0034_flows_quiet_hours_mode_canonical.sql
  - packages/db/migrations/meta/0034_snapshot.json
  - packages/db/migrations/meta/_journal.json
  - packages/db/src/schema/flows.ts
  - packages/shared-schemas/src/campaign.ts
findings:
  critical: 1
  warning: 6
  info: 5
  total: 12
status: issues_found
---

# Phase 6: Code Review Report — Gap-Closure Plans 06-12 / 06-13 / 06-14

**Reviewed:** 2026-07-10T09:41:04Z
**Depth:** standard
**Files Reviewed:** 21
**Status:** issues_found

## Summary

This pass reviews the three gap-closure plans that closed the prior review's CR-01 (advance-nudge jobId shadowing), CR-02 (quiet_hours_mode vocabulary mismatch), and CR-03 (draft trigger edits leaking into live enrollment).

**What holds up:**

- **CR-01 (jobId shadowing) is correctly closed.** `enqueueFlowRunAdvance` is the sole producer path (verified by grep: no direct `flowRunAdvanceQueue.add` call sites remain in worker or API source), jobIds are unique per wake, `removeOnComplete: true` / `removeOnFail: {age: 86400}` are set only on the advance queue, and the WR-08 forward nudges were added for send and branch transitions. The new real-Queue/Worker integration test genuinely exercises the pre-fix stall scenarios, including the required 2+ delay chain.
- **CR-02 (vocabulary) is closed at the mode level.** Migration 0034 fixes the DB default and normalizes legacy rows idempotently; the 0034 snapshot correctly covers all 27 tables with the new default; no `"inherit"`/`"override"` remnants remain in worker/API/shared-schema source; the unrecognized-value branch fails toward the workspace window (correct fail-safe direction). **However, CR-01 below shows the custom window is still evaluated in the wrong timezone for any contact with a stored timezone — CR-02's user-facing guarantee is only partially restored.**
- **CR-03 (draft trigger leak) is correctly closed at the data layer.** The trigger-column sync is gated on `status === 'draft'`, `publishFlow` is the single re-derivation point inside the same UPDATE as the `live_version_id` repoint, and the feared D-24 regression does not exist — `findReferencingFlowName` (segment.repository.ts:303) also scans `flow_versions.definition` jsonb, so a segment referenced only by an unpublished draft is still delete-protected. The new lifecycle test covers the leak and the re-publish promotion. **However, the UI layer (06-14) still derives dialog behavior from the now-pinned live columns — see WR-02/WR-03.**

Findings below: 1 critical, 6 warnings, 5 info.

## Critical Issues

### CR-01: `loadContactTimezone` binds parameters in swapped order — contact timezone is NEVER resolved, quiet-hours and wait_until evaluate in the wrong timezone

**File:** `apps/worker/src/queues/flows/handlers/send-node.ts:46-51` and `apps/worker/src/queues/flows/handlers/delay-node.ts:21-26`
**Issue:** Both copies of `loadContactTimezone` run:

```ts
`SELECT timezone FROM contacts WHERE workspace_id = $1 AND id = $2`,
[contactId, workspaceId]   // $1 = contactId, $2 = workspaceId — SWAPPED
```

`workspace_id = <contactId>` matches zero rows, so the function always returns `null` and `resolveTimezone` silently falls back to the workspace default timezone. Consequences:

1. **Quiet-hours gating (send-node.ts) evaluates the window in the wrong timezone** for every contact whose `contacts.timezone` differs from the workspace default — emails fire inside the contact's local quiet window (up to ±14h off). This directly undermines the guarantee CR-02 (06-13) was supposed to restore: the mode vocabulary now matches, but the custom window is checked against the wrong clock. The CR-02 regression tests pass only because fixture contacts carry no timezone (the fallback masks the bug).
2. **`wait_until` delays (delay-node.ts) compute `next_wake_at` in the workspace default timezone**, never the contact's (D-08 contact-timezone-first requirement broken).

This pre-dates the gap plans (06-07) but sits in two of the reviewed files and partially re-opens CR-02, so the gap closure is incomplete without it.

**Fix:** Swap the parameter array in both files (and preferably consolidate the duplicated helper into one shared function so it cannot diverge again):
```ts
`SELECT timezone FROM contacts WHERE workspace_id = $1 AND id = $2`,
[workspaceId, contactId]
```
Add a regression test with a contact whose `timezone` places "now" inside its custom quiet window while the workspace default timezone places it outside (assert defer), which fails under the current code.

## Warnings

### WR-01: Forward-nudge (WR-08 fix) is enqueued inside the still-open transaction — under multi-worker concurrency the nudge can no-op against the uncommitted row and forward progress falls back to the 60s backstop

**File:** `apps/worker/src/queues/flows/flow-run-advance.worker.ts:241, 315` (also `handlers/send-node.ts:134`, `handlers/delay-node.ts:72`, but those enqueues carry a future delay that dwarfs commit time)
**Issue:** `enqueueFlowRunAdvance({ workspaceId, flowRunId })` runs inside `withTenantTransaction`, before COMMIT. The nudge has no delay, so a second worker process (or a worker with concurrency > 1) can pick it up immediately, hit `FOR UPDATE OF fr SKIP LOCKED` on the row still locked by the enqueuing transaction, return `null`, and complete as a successful no-op (`removeOnComplete: true` — the job is gone, no retry). The run then advances only when the 60s reconciliation scan re-nudges it — per-step latency of up to 60s per hop, which is exactly the degradation WR-08/CR-01 set out to eliminate. The new integration test cannot catch this: it runs one worker with default concurrency 1, so the nudge is never picked before the processor's own transaction commits.

Correctness is preserved (the backstop guarantees eventual progress), but the fix's stated goal — reliable prompt advancement — silently degrades in exactly the multi-worker production topology.

**Fix:** Enqueue the zero-delay forward nudge after the transaction commits (return a "nudge needed" flag from the transaction callback and enqueue in `processFlowRunAdvance` after `withTenantTransaction` resolves), or give the forward nudge a small delay (e.g., 250–500ms) so commit reliably precedes delivery.

### WR-02: Publish dialog and enroll-preview derive trigger type/segment from the live-pinned columns — after CR-03, a republish whose draft changed the trigger renders the wrong dialog variant and skips (or mis-targets) the D-04 enroll-existing choice

**File:** `apps/web/src/features/flows/detail/PublishEnrollDialog.tsx:62, 106-109`; `apps/api/src/modules/flows/flows.routes.ts:239-263` (enroll-preview)
**Issue:** `isSegmentTriggered = flow.triggerType === "segment"` and the preview endpoint's `flow.triggerSegmentId` now read the columns CR-03 deliberately pins to the **published** definition. For a live/paused flow whose unpublished draft changed the trigger:

- Event → segment: the dialog shows the simple event-confirm variant (describing the **old** event name), publishes with `enrollExisting: undefined`, and the route defaults to `false` — the marketer is never offered the enroll-existing back-fill for the newly segment-triggered flow, and existing segment members are silently seed-only'd.
- Segment A → segment B: the dialog previews **segment A's** member count while "Зачислить и опубликовать" will actually enroll **segment B's** members.

This is a direct, unhandled consequence of the CR-03 pinning inside 06-14's own UI addition.

**Fix:** Derive the dialog's trigger facts from the draft being published — `flow.definition` (the API already returns the working-draft definition) contains the draft's trigger node; use its `triggerType`/`segmentId`/`eventName` when `flow.draftVersionId !== null`. The enroll-preview endpoint likewise needs a draft-aware variant (accept a `segmentId` derived from the draft, or resolve the draft's trigger server-side).

### WR-03: `duplicateFlow` copies live-pinned trigger columns alongside the draft definition — the duplicate's `trigger_*` mismatch its own graph until first edit/publish

**File:** `apps/api/src/modules/flows/flow.repository.ts:485-518`
**Issue:** `duplicateFlow` copies `existing.triggerType/triggerEventName/triggerSegmentId` (post-CR-03: pinned to the source's **published** definition) but copies the **draft** definition (`existing.draftVersionId ?? existing.liveVersionId`). Duplicating a live flow whose draft changed the trigger produces a draft flow whose trigger columns describe a trigger its definition no longer contains: the flows list and publish dialog (WR-02) show the wrong trigger, and D-24 restrict-delete over-restricts on the stale segment. Pre-CR-03 the two were always in sync, so this inconsistency is new.

**Fix:** Derive the duplicate's trigger columns from the definition actually being copied:
```ts
const triggerColumns = extractTriggerColumns(definition);
// use triggerColumns.* instead of existing.trigger* in the INSERT
```

### WR-04: Publishing changes on a paused flow silently flips it to `live` — the new 06-14 UI exposes this with no warning that enrollment resumes

**File:** `apps/api/src/modules/flows/flow.repository.ts:386-396` (`status = 'live'` unconditional); `apps/web/src/features/flows/detail/FlowDetailPage.tsx:162-163` (`hasPublishableDraft` includes `paused`); `apps/web/src/features/flows/detail/PublishEnrollDialog.tsx:100-103`
**Issue:** `publishFlow` unconditionally sets `status = 'live'`. Before 06-14 this path was API-only; now the "Опубликовать изменения" button is deliberately shown for paused flows, and neither the button nor the dialog copy mentions that publishing will **resume enrollment and frozen in-flight runs** — the opposite of what the pause dialog promised ("остановятся … до возобновления"). A marketer who paused a misbehaving flow, edited the draft, and clicked "publish changes" gets live sends immediately, without ever clicking "Возобновить". Risk: unintended email sends.

**Fix:** Either preserve `paused` on publish when `existing.status === 'paused'` (publish the version, keep enrollment paused, let "Возобновить" stay the sole resume path), or add explicit dialog copy + confirmation for the paused case ("Цепочка возобновится и снова начнёт отправлять письма").

### WR-05: `flows.enroll_cursor` is never reset between publishes — a republished segment-triggered flow's "enroll existing" back-fill resumes from the previous pass's final cursor and skips lower-UUID contacts

**File:** `apps/worker/src/queues/flows/flow-enroll-existing.worker.ts:205-209, 139-142`; `apps/api/src/modules/flows/flow.repository.ts:386-405` (publish UPDATE does not touch `enroll_cursor`)
**Issue:** `processFlowEnrollExisting` seeds its keyset cursor from the persisted `flows.enroll_cursor`, which is only ever advanced (grep confirms no writer resets it). After a first full enroll pass the cursor sits at the max enrolled contact id. 06-14's republish UI makes a second `enrollExisting: true` publish a first-class path (including switching to a different trigger segment, per WR-02): the new back-fill only considers contacts with `id > stale_cursor` — in-segment contacts whose UUIDs sort at or below it are silently skipped by the explicit back-fill. The periodic segment sweep eventually enrolls them (they are in-segment and not in the snapshot), but the marketer's explicit "Зачислить и опубликовать" choice is partially deferred to the sweep cadence, non-deterministically by UUID ordering.

**Fix:** Reset `enroll_cursor = NULL` in `publishFlow`'s UPDATE (each publish starts a fresh pass; the membership snapshot already makes re-scanning previously-processed contacts a cheap skip), or key the cursor per `live_version_id`.

### WR-06: Unique-per-wake jobIds + 60s reconciliation = unbounded re-enqueue churn for a permanently failing run — no circuit breaker

**File:** `apps/worker/src/queues/flows/flow-queues.ts:85-93`; `apps/worker/src/queues/flows/flow-reconciliation.worker.ts:108-119`
**Issue:** A side effect of the CR-01 fix: pre-fix, the deterministic jobId capped a failing run at one (stuck) job; post-fix, a run whose advance always throws (e.g., the explicit `unsupported node type` data-integrity throw, or a corrupted pinned definition) stays `waiting` and due, so every 60s reconciliation tick enqueues a **fresh** 5-attempt job — ~1,440 jobs/day per stuck run, each retained 24h in the failed set, with continuous worker/Postgres churn and no terminal state ever reached. A handful of corrupted runs is fine; a bulk incident (bad definition published to a large flow) multiplies this by the run count.

**Fix:** Add a failure escape hatch: after the final BullMQ attempt fails, mark the run (`status = 'failed'` or a `stalled_at`/`failure_count` column) so the reconciliation scan's `status = 'waiting'` filter stops re-picking it; surface failed runs in the D-21 runs table for manual eject/retry.

## Info

### IN-01: `jobId: ${flowRunId}-${Date.now()}` collides for two wakes of the same run within one millisecond — second `add()` silently no-ops

**File:** `apps/worker/src/queues/flows/flow-queues.ts:90`
**Issue:** Millisecond resolution means e.g. a trigger-evaluator nudge and a reconciliation nudge for the same run in the same ms drop one job. Harmless today (payloads are identical and the backstop re-covers), but a delayed wake colliding with an immediate wake would drop the immediate one.
**Fix:** Append a monotonic counter or random suffix: `${flowRunId}-${Date.now()}-${nanoid(4)}`.

### IN-02: `void tickQueue.add(...)` floating promise — a Redis failure at worker boot becomes an unhandled rejection

**File:** `apps/worker/src/queues/flows/flow-reconciliation.worker.ts:102-106`
**Issue:** `void` discards the promise but does not handle rejection; if Redis is unavailable when the repeatable tick is registered, the process gets an unhandled rejection (fatal on modern Node) instead of a clear startup error.
**Fix:** `await` it in the caller or chain `.catch()` with a logged fatal.

### IN-03: Integration test Scenario B's "different job id" assertion depends on BullMQ `getJobs` default descending order

**File:** `apps/worker/src/queues/__tests__/flow-run-advance-integration.test.ts:288-291, 326-331`
**Issue:** After hop 2, TWO delayed jobs for the run coexist (delay-1's and delay-2's); `getDelayedAdvanceJobIdForRun` returns the first match, which is delay-2's only because `Queue.getJobs` defaults to descending score order. If that default changes, `jobIdAfterDelay2` resolves to delay-1's job and the `not.toBe` assertion fails (or worse, silently inverts what is being proven).
**Fix:** Filter for the job whose `delay`/`timestamp` is the newest, or exclude `jobIdAfterDelay1` explicitly: `jobs.find((j) => j.data?.flowRunId === flowRunId && j.id !== jobIdAfterDelay1)`.

### IN-04: PublishEnrollDialog never resets mutation state — a stale 422 blocker list is reshown on reopen after the nodes were fixed

**File:** `apps/web/src/features/flows/detail/PublishEnrollDialog.tsx:90-93`
**Issue:** `blockers` derives from `publishMutation.isError`, which persists across dialog close/reopen; after fixing the flagged nodes on the canvas and reopening, the old (now-invalid) blocker list still renders until the next publish attempt.
**Fix:** Call `publishMutation.reset()` in `handleOpenChange` when `next === true` (or on close).

### IN-05: Any non-definition PATCH (e.g., rename) of a live flow lazily creates a draft, making "Опубликовать изменения" appear for an unchanged graph

**File:** `apps/api/src/modules/flows/flow.repository.ts:243-260`; `apps/web/src/features/flows/detail/FlowDetailPage.tsx:162-163`
**Issue:** `updateFlowDraft` creates a working draft on *any* patch, including pure `name`/settings edits that are not part of the versioned definition. `hasPublishableDraft` then shows the publish-changes button even though the draft definition is byte-identical to live; publishing bumps `live_version_id` to an identical copy (and flips `onOldVersions` counters for in-flight runs pinned to the prior version).
**Fix:** Only lazily create the draft when `patch.definition !== undefined`, or suppress the button when the draft definition equals the live definition.

---

_Reviewed: 2026-07-10T09:41:04Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
