---
phase: 06-flows-triggered-chains
reviewed: 2026-07-10T13:21:32Z
depth: standard
files_reviewed: 108
files_reviewed_list:
  - apps/api/package.json
  - apps/api/src/modules/campaigns/__tests__/send-settings.test.ts
  - apps/api/src/modules/campaigns/send-settings.routes.ts
  - apps/api/src/modules/contacts/__tests__/contact-crud.test.ts
  - apps/api/src/modules/contacts/__tests__/csv-import.test.ts
  - apps/api/src/modules/contacts/contact.repository.ts
  - apps/api/src/modules/contacts/contacts.routes.ts
  - apps/api/src/modules/flows/__tests__/flow-lifecycle.test.ts
  - apps/api/src/modules/flows/__tests__/flow-run-management.test.ts
  - apps/api/src/modules/flows/flow-queues.ts
  - apps/api/src/modules/flows/flow-run.repository.ts
  - apps/api/src/modules/flows/flow-validation.ts
  - apps/api/src/modules/flows/flow-version.repository.ts
  - apps/api/src/modules/flows/flow.repository.ts
  - apps/api/src/modules/flows/flows.routes.ts
  - apps/api/src/modules/segments/segment.repository.ts
  - apps/api/src/server.ts
  - apps/web/package.json
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
  - apps/worker/package.json
  - apps/worker/src/queues/__tests__/flow-run-advance-integration.test.ts
  - apps/worker/src/queues/__tests__/flow-run-advance.test.ts
  - apps/worker/src/queues/__tests__/flow-segment-trigger.test.ts
  - apps/worker/src/queues/__tests__/flow-send-idempotency.test.ts
  - apps/worker/src/queues/__tests__/flow-trigger-evaluator.test.ts
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
  - apps/worker/vitest.config.ts
  - packages/contacts-core/package.json
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
  - packages/db/migrations/0034_flows_quiet_hours_mode_canonical.sql
  - packages/db/migrations/meta/0034_snapshot.json
  - packages/db/migrations/meta/_journal.json
  - packages/db/src/index.ts
  - packages/db/src/schema/contacts.ts
  - packages/db/src/schema/flow-run-steps.ts
  - packages/db/src/schema/flow-runs.ts
  - packages/db/src/schema/flow-segment-membership-snapshot.ts
  - packages/db/src/schema/flow-versions.ts
  - packages/db/src/schema/flows.ts
  - packages/db/src/schema/sends.ts
  - packages/db/src/schema/workspace-send-settings.ts
  - packages/delivery-core/src/__tests__/pre-send-gate.test.ts
  - packages/delivery-core/src/__tests__/quiet-hours.test.ts
  - packages/delivery-core/src/contact-timezone.ts
  - packages/delivery-core/src/index.ts
  - packages/delivery-core/src/quiet-hours.ts
  - packages/delivery-core/src/send-ledger.ts
  - packages/delivery-core/src/send-mail.ts
  - packages/delivery-core/src/send-settings.ts
  - packages/flows-core/package.json
  - packages/flows-core/src/__tests__/flow-validate.test.ts
  - packages/flows-core/src/__tests__/wait-until.test.ts
  - packages/flows-core/src/flow-definition-schema.ts
  - packages/flows-core/src/flow-validate.ts
  - packages/flows-core/src/index.ts
  - packages/flows-core/src/wait-until.ts
  - packages/flows-core/tsconfig.json
  - packages/flows-core/vitest.config.ts
  - packages/shared-schemas/package.json
  - packages/shared-schemas/src/campaign.ts
  - packages/shared-schemas/src/contact.ts
  - packages/shared-schemas/src/flow.ts
  - packages/shared-schemas/src/index.ts
  - packages/shared-schemas/src/queues.ts
findings:
  critical: 2
  warning: 7
  info: 5
  total: 14
status: issues_found
---

# Phase 06: Code Review Report (re-review after gap-closure rounds 06-12..06-16)

**Reviewed:** 2026-07-10T13:21:32Z
**Depth:** standard
**Files Reviewed:** 108
**Status:** issues_found

## Summary

Re-review of the Phase 06 flows/triggered-chains implementation after two gap-closure rounds. All five previously remediated defects were re-verified against current code and **hold**:

- **Advance-nudge delivery (old CR-01, plan 06-12):** `enqueueFlowRunAdvance` is the sole producer with a unique-per-wake jobId (`${flowRunId}-${Date.now()}`), `flowRunAdvanceQueue` uses `removeOnComplete: true`, and send/branch handlers forward-nudge non-terminal transitions. Covered by `flow-run-advance-integration.test.ts` with a real Queue/Worker pair.
- **Quiet-hours vocabulary (old CR-02, plan 06-13):** worker branches on the canonical `workspace_default`/`custom`/`disabled`; migration 0034 normalizes legacy `inherit`/`override` rows and the DB/Drizzle default; regression tests cover both `custom` and `workspace_default`-with-disabled-workspace paths.
- **Draft-trigger isolation (old CR-03, plan 06-14):** `updateFlowDraft` syncs `trigger_*` columns only while `status === 'draft'`; `publishFlow` is the single point re-deriving them for live/paused flows. Covered by the CR-03 regression test in `flow-lifecycle.test.ts`.
- **Contact-timezone bind order (plan 06-15):** the shared `loadContactTimezone` helper (`packages/delivery-core/src/contact-timezone.ts`) is used by both `send-node.ts` and `delay-node.ts` with correct `(workspaceId, contactId)` parameter order; divergence-proof tests exist.
- **Paused-flow publish (old WR-04, plan 06-16):** `publishFlow` computes `nextStatus = paused ? 'paused' : 'live'`; `PublishEnrollDialog` warns; covered by the 06-16 test.

The fresh adversarial pass found **two new critical defects** in the engine/enrollment layer (a publishable graph cycle that produces an unbounded hot loop in the advance worker, and a non-atomic snapshot seed that can mass-enroll an entire segment the marketer explicitly chose *not* to enroll), plus seven warnings and five informational items.

## Critical Issues

### CR-01: Graph cycles pass publish validation and the advance engine has no loop bound — unbounded hot loop per enrolled run

**File:** `packages/flows-core/src/flow-validate.ts:98-125`, `apps/worker/src/queues/flows/flow-run-advance.worker.ts:135-337`
**Issue:** `validateFlowDefinition` performs exactly three checks and none of them rejects a cycle. A definition like `trigger → send-A → send-B → send-A` validates clean (exactly one trigger, both sends configured, no branch nodes, so check 3 never runs; `pathReachesExit` additionally treats any revisited node as "already satisfied", so even branch paths that loop forever without an exit pass). The canvas permits drawing this cycle: `isValidConnection` (`FlowCanvas.tsx:233-242`) only blocks self-loops and duplicate `(source, sourceHandle)` edges — `A→B, B→A` is allowed — and the PATCH API accepts arbitrary schema-valid definitions regardless of the canvas.

Once published and a run enters the cycle, `processFlowRunAdvance` executes an **unbounded hot loop**: each send-node hop sets `next_wake_at = now()` and immediately forward-nudges (`flow-run-advance.worker.ts:235-242`), the next hop does the same, forever. Duplicate *emails* are prevented by the deterministic send jobId and the `sends_flow_run_node_unique` ledger claim, but per iteration the loop inserts a `flow_run_steps` row, runs several queries under `FOR UPDATE`, and enqueues a fresh advance job — at full worker speed, per enrolled contact. Consequences: unbounded `flow_run_steps` growth, Redis/queue saturation, worker CPU pinning, and runs that can never complete. There is no hop counter, no per-run step budget, and no cycle rejection anywhere in the path.
**Fix:** Two independent layers (do both — publish validation alone doesn't protect against definitions written before the fix or future validator gaps):

1. Reject cycles reachable from the trigger at publish time in `validateFlowDefinition` (DFS with a recursion stack; new error code e.g. `cycle_detected`).
2. Add a defensive per-run budget in `processFlowRunAdvance`, e.g.:

```ts
// inside the transaction, before node dispatch
const { rows } = await client.query<{ count: string }>(
  `SELECT count(*) FROM flow_run_steps WHERE flow_run_id = $1 AND workspace_id = $2`,
  [flowRunId, workspaceId]
);
if (Number(rows[0].count) >= MAX_STEPS_PER_RUN) { // e.g. 1000
  await client.query(
    `UPDATE flow_runs SET status = 'exited', exited_at = now(), exit_reason = 'step_budget_exceeded'
     WHERE id = $1 AND workspace_id = $2`,
    [flowRunId, workspaceId]
  );
  return;
}
```

### CR-02: `enrollExisting=false` snapshot seed is asynchronous and can fail open — the sweep can mass-enroll the entire existing segment the marketer chose NOT to enroll

**File:** `apps/api/src/modules/flows/flows.routes.ts:291-301`, `apps/worker/src/queues/flows/flow-enroll-existing.worker.ts:157-217`, `apps/worker/src/queues/flows/flow-segment-sweep.worker.ts:94-149`
**Issue:** When the marketer publishes a segment-triggered flow choosing «Опубликовать только для новых» (`enrollExisting=false`), the *only* thing that prevents every current segment member from being enrolled is `seedSnapshotOnly` marking them "seen" — and that seed runs in a **separate BullMQ job after the publish transaction commits**. Two failure modes turn this choice into its opposite:

1. **Race:** the flow becomes discoverable by `flow-segment-sweep` (and by `checkSegmentEntryForContact` on every ingested event) the instant `publishFlow` commits. If a sweep tick is running (or fires) in the window before `seedSnapshotOnly` commits, `sweepOneFlow` diffs the full membership against an *empty* snapshot and enrolls **all current members**, each of which immediately dispatches the flow's first send.
2. **Job loss:** if the `flow-enroll-existing` job exhausts its 5 attempts (Redis blip, DB slowness, worker crash-loop), the snapshot is never seeded and the next sweep tick (≤15 min later) mass-enrolls the whole segment.

For an email-marketing platform this is a compliance/reputation-grade failure: potentially 100k+ unsolicited flow emails sent against the operator's explicit choice, with no way to undo the sends. The `enrollExisting=true` path is safe under the same race (both paths dedupe via `canEnterFlow` + the partial unique index), which makes the asymmetry easy to miss.
**Fix:** Make the `enrollExisting=false` seed synchronous and atomic with publish: `seedSnapshotOnly` is a single bounded `INSERT ... SELECT` — run it inside the `publishFlow` transaction (or in the route's `withTenant` scope immediately after publish, *before* the flow can be swept) when `enrollExisting !== true`, and drop the job for that branch. Alternatively, gate the sweep/event re-check on a `flows.enroll_seeded_at` column set by the seed — but the synchronous seed is simpler and removes both failure modes.

## Warnings

### WR-01: `deleteSegment`'s 23503 catch block queries an aborted transaction — guaranteed 25P02 and a 500 instead of the intended 409

**File:** `apps/api/src/modules/segments/segment.repository.ts:376-402`
**Issue:** After the DELETE trips a 23503 (the canceled-campaign FK case the Rule-1 fix exists for, or a concurrent flow-reference race), the transaction is aborted. The catch block then calls `findReferencingFlowName(client, ...)` on the **same aborted connection** — Postgres rejects every further statement with `25P02 current transaction is aborted`, so the intended `SegmentConflictError` (409) is never thrown; the 25P02 error propagates and the route returns a raw 500. `withTenantTransaction` (`packages/tenant-context/src/index.ts`) uses no savepoints, so this re-query can never succeed. The D-24 flow re-check added in this phase regressed the previously working canceled-campaign 409 path.
**Fix:** Don't query inside the aborted transaction. Either (a) resolve the flow name *before* the DELETE and use the cached value in the catch, or (b) wrap the DELETE in a `SAVEPOINT`/`ROLLBACK TO SAVEPOINT` so the catch block's queries run in a live transaction:

```ts
await client.query("SAVEPOINT seg_delete");
try {
  const { rows } = await client.query(`DELETE FROM segments ...`);
  return rows.length > 0;
} catch (err) {
  if ((err as { code?: string })?.code === "23503") {
    await client.query("ROLLBACK TO SAVEPOINT seg_delete");
    const flowName = await findReferencingFlowName(client, workspaceId, id);
    // ... existing conflict mapping
  }
  throw err;
}
```

### WR-02: A trigger with no outgoing edge is publishable — enrolled runs are created with `current_node_id = NULL` and reconciliation nudges them forever

**File:** `packages/flows-core/src/flow-validate.ts:34-71`, `apps/worker/src/queues/flows/flow-trigger-evaluator.worker.ts:174-190`, `apps/worker/src/queues/flows/flow-reconciliation.worker.ts:97-120`
**Issue:** `validateFlowDefinition` never checks that the trigger has an outgoing edge (a trigger-plus-orphan-exit definition passes all three checks). `loadEntryNodeId` then returns `null`, but `enterSegmentTriggeredFlow`/`processFlowTriggerCheck`/`enrollBatch` **still insert the `flow_runs` row** with `current_node_id = NULL`, `status = 'waiting'`, `next_wake_at = now()`. `processFlowRunAdvance` no-ops on `!run.currentNodeId` without touching the row, so the run is permanently "waiting and due": the 60s reconciliation scan re-selects it and enqueues a fresh no-op advance job **every tick, forever, per enrolled contact**. The runs also never reach a terminal state (blocking flow deletion until manually ejected) and count as "active" in the D-21 header.
**Fix:** (1) Add a publish-time hard error when the trigger node has no outgoing edge (e.g. a `no_entry` code). (2) Defensively, when `entryNodeId` is `null`, skip the `flow_runs` INSERT entirely (still mark the snapshot seen) or insert the run directly as `status='completed', exit_reason='no_entry_node'` so it never enters the reconciliation scan.

### WR-03: `flows.enroll_cursor` is never reset between enroll-existing passes — a re-publish back-fill silently skips most of the segment

**File:** `apps/worker/src/queues/flows/flow-enroll-existing.worker.ts:138-144, 205-228`, `packages/db/migrations/0033_flows_enroll_cursor.sql`
**Issue:** `enrollBatch` persists the keyset cursor on the flows row and nothing ever resets it. After the first enroll-existing pass completes, `enroll_cursor` holds the segment's highest matched contact UUID. When the flow is later re-published with «Зачислить и опубликовать» (new `flowVersionId` → new jobId, so the job *does* run), `processFlowEnrollExisting` resumes from that stale cursor: the first batch's `c.id > $cursor` predicate matches almost nothing, `processed === 0`, and the loop exits immediately — contacts who joined the segment since the first publish but whose UUIDs sort below the cursor are **never back-filled by the explicit enroll action**. The 15-minute sweep eventually enrolls them, but the marketer's "enroll now" choice is silently a partial no-op, and the behavior contradicts migration 0033's own documented semantics ("NULL means no batch has run yet for this flow's **current** enroll-existing pass").
**Fix:** Reset the cursor when a new pass starts — e.g. `UPDATE flows SET enroll_cursor = NULL` inside `publishFlow` (or in the publish route before enqueuing), or key the cursor by pass (store the pass's version id alongside and treat a mismatch as `NULL`).

### WR-04: Segment-triggered flows can never re-enroll a contact — the snapshot is never cleared on segment exit, making the re-entry settings dead controls for this trigger type

**File:** `apps/worker/src/queues/flows/flow-trigger-evaluator.worker.ts:127-147, 206-217`, `apps/worker/src/queues/flows/flow-segment-sweep.worker.ts:110-131`
**Issue:** `flow_segment_membership_snapshot` rows are only ever inserted, never deleted. A contact who leaves the trigger segment and later re-enters it is still `hasSeenSnapshot === true` and is skipped by both the event-driven re-check and the sweep — **regardless of the flow's `reentry_mode`**. Consequently `every_time` and `once_per_n_days` are unreachable for segment-triggered flows (the `canEnterFlow` re-entry logic on that path can only ever run once per contact per flow, ever), while `FlowLifecycleSettings` still presents all three re-entry modes for such flows as if they worked. The in-code comment frames this as "one-shot per D-02's snapshot semantics", but the shipped semantics make a documented, user-visible configuration surface a silent no-op.
**Fix:** Either (a) have the sweep also delete snapshot rows for contacts no longer matching the segment (making "seen" mean "currently in this membership episode", restoring leave→rejoin re-entry subject to `canEnterFlow`), or (b) if one-shot is genuinely the v1 contract, hide/disable the re-entry controls for segment-triggered flows in the UI and document the limitation.

### WR-05: Autosave shows «Сохранено» after a failed save and never retries without a further edit — silent draft loss

**File:** `apps/web/src/features/flows/canvas/useAutosaveDraft.ts:101-119`
**Issue:** `saveState` is derived solely from `mutation.isPending`, so the moment a PATCH **fails**, the toolbar flips back to «Сохранено» — asserting the opposite of reality. The `onError` handler clears `lastSavedRef`, but the retry only fires when `debouncedJson` next *changes*; if the user makes no further edits (finish editing, watch the indicator, close the tab), the failed save is never retried and the canvas changes are lost while the UI claimed they were saved.
**Fix:** Track an error state: render a "not saved, retrying" indicator when the last mutation failed and schedule an automatic retry (retry counter / timeout) instead of waiting for the next user edit. At minimum, `saveState` must not read "saved" while `mutation.isError` and `lastSavedRef.current !== json`.

### WR-06: `deleteFlow` opens a nested pooled transaction while holding `FOR UPDATE` — pool-exhaustion stall pattern plus a TOCTOU count

**File:** `apps/api/src/modules/flows/flow.repository.ts:557-590`, `apps/api/src/modules/flows/flow-run.repository.ts:172-181`
**Issue:** Inside `deleteFlow`'s `withTenantTransaction` (which holds the `flows` row `FOR UPDATE`), it calls `activeRunCount(id)` — which itself calls `withTenantTransaction`, checking out a **second** connection from the same pool. Under concurrent load, N in-flight `deleteFlow` calls each hold one connection while waiting for another; with pg's default `Pool` (no acquisition timeout) this can stall the whole pool once N reaches `max`. Additionally, the count runs in a *different* transaction from the DELETE, so it observes a different snapshot than the transaction that acts on it — undermining the purpose of the `FOR UPDATE` lock the function takes.
**Fix:** Query the count on the already-open `client`:

```ts
const { rows: countRows } = await client.query<{ count: string }>(
  `SELECT count(*) FROM flow_runs WHERE workspace_id = $1 AND flow_id = $2 AND status IN ('waiting','advancing')`,
  [workspaceId, id]
);
```

(Extract an `activeRunCountWithClient(client, workspaceId, flowId)` helper if reuse is wanted.)

### WR-07: `enroll-preview` runs an unbounded segment count on a user-facing route — the statement-timeout DoS bound applied everywhere else is missing here

**File:** `apps/api/src/modules/flows/flows.routes.ts:252`
**Issue:** The D-04 enroll-preview route calls `countSegmentMembers(segment.definition)` with **no** `statementTimeoutMs`, unlike the segments module's own preview/save paths which explicitly bound evaluation (D-08/WR-03/T-03-04). A pathological segment definition (or a very large contact table) holds a pooled RLS connection for the full query duration on an ordinary-member-accessible endpoint, and the publish dialog fires this on every open.
**Fix:** Pass the same bound the segments routes use, e.g. `countSegmentMembers(segment.definition, { statementTimeoutMs: 15_000 })`, and surface a "count unavailable" fallback in the dialog on timeout.

## Info

### IN-01: `getRunCounts` is exported but has no callers

**File:** `apps/api/src/modules/flows/flow-run.repository.ts:78-83`
**Issue:** `listRuns` uses the internal `queryRunCounts`; the exported `getRunCounts` wrapper is referenced nowhere in `apps/` source.
**Fix:** Remove the export, or wire the FlowDetailPage header to a dedicated counts endpoint using it instead of the current `pageSize: 1` runs fetch.

### IN-02: Contact email-uniqueness pre-checks race the unique constraint — concurrent duplicate create surfaces as a raw 500

**File:** `apps/api/src/modules/contacts/contact.repository.ts:229-234, 291-299`
**Issue:** `isEmailTaken` + INSERT/UPDATE is not atomic; two concurrent creates with the same email both pass the check and the loser hits `contacts_workspace_email_unique` (23505), which the routes don't map — the client gets a 500 instead of the `email_taken` 409.
**Fix:** Catch 23505 in `createContact`/`updateContact` and rethrow as `ContactConflictError("...", "email_taken")`.

### IN-03: `handleSendNode` enqueues the email job inside the open advance transaction

**File:** `apps/worker/src/queues/flows/handlers/send-node.ts:135-139`
**Issue:** The `emailTriggeredQueue.add` side effect happens before the surrounding transaction commits; a rollback after the enqueue leaves a dispatched send job with no committed step/pointer advance. The `claimFlowSend` ledger prevents duplicate SendGrid calls, so impact is limited to bookkeeping drift (a send can be dispatched for a step whose `flow_run_steps` row was rolled back).
**Fix:** Acceptable as-is given the ledger; if hardening, return an "enqueue send" instruction from the handler and perform the Redis add in the caller after the transaction commits.

### IN-04: `void tickQueue.add(...)` swallows the repeatable-registration promise — a rejection becomes an unhandled rejection

**File:** `apps/worker/src/queues/flows/flow-reconciliation.worker.ts:102-106`, `apps/worker/src/queues/flows/flow-segment-sweep.worker.ts:163-167`
**Issue:** If registering the repeatable tick fails (Redis unavailable at boot), the rejected promise is discarded with `void` and surfaces as an unhandled rejection (fatal by default on Node 22) instead of a logged, retryable failure.
**Fix:** Append `.catch((err) => console.error("failed to register repeatable tick", err))` (or await it in `buildWorker`).

### IN-05: The enroll-existing worker never re-checks flow status — batches keep enrolling into a paused flow

**File:** `apps/worker/src/queues/flows/flow-enroll-existing.worker.ts:32-40, 187-229`
**Issue:** `loadFlow` reads trigger/reentry config but not `status`; a flow paused (or in the process of being deleted) mid-back-fill continues to receive `flow_runs` inserts batch after batch. The runs correctly freeze (D-18 guard in the advance worker) and D-22's delete guard counts them, but the operator's pause does not stop the enrollment they may have paused specifically to prevent.
**Fix:** Include `status` in `loadFlow` and re-check it per batch, stopping (without clearing the cursor) when the flow is no longer `live`.

---

_Reviewed: 2026-07-10T13:21:32Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
