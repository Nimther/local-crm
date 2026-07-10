---
phase: 06-flows-triggered-chains
reviewed: 2026-07-10T15:06:08Z
depth: standard
files_reviewed: 111
files_reviewed_list:
  - apps/api/package.json
  - apps/api/src/modules/campaigns/__tests__/send-settings.test.ts
  - apps/api/src/modules/campaigns/send-settings.routes.ts
  - apps/api/src/modules/contacts/__tests__/contact-crud.test.ts
  - apps/api/src/modules/contacts/__tests__/csv-import.test.ts
  - apps/api/src/modules/contacts/contact.repository.ts
  - apps/api/src/modules/contacts/contacts.routes.ts
  - apps/api/src/modules/flows/__tests__/flow-enroll-atomic.test.ts
  - apps/api/src/modules/flows/__tests__/flow-lifecycle.test.ts
  - apps/api/src/modules/flows/__tests__/flow-run-management.test.ts
  - apps/api/src/modules/flows/flow-queues.ts
  - apps/api/src/modules/flows/flow-run.repository.ts
  - apps/api/src/modules/flows/flow-validation.ts
  - apps/api/src/modules/flows/flow-version.repository.ts
  - apps/api/src/modules/flows/flow.repository.ts
  - apps/api/src/modules/flows/flows.routes.ts
  - apps/api/src/modules/segments/__tests__/segment-delete-conflict.test.ts
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
  - apps/web/src/features/flows/canvas/__tests__/autosaveState.test.ts
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
  critical: 0
  warning: 6
  info: 7
  total: 13
status: issues_found
---

# Phase 06: Code Review Report (re-review after gap-closure round 3, plans 06-17..06-21)

**Reviewed:** 2026-07-10T15:06:08Z
**Depth:** standard
**Files Reviewed:** 111
**Status:** issues_found

## Summary

Re-review after gap-closure round 3 (commits 8985fc3..26f7bd0). All six remediated findings from the previous round were re-verified against current code and **hold**:

- **CR-01 (cycle detection + hot-loop backstop, plan 06-17):** `validateFlowDefinition` now runs a recursion-stack DFS from the trigger (`findCycleReachableFrom`, `flow-validate.ts:104-127`) and emits `cycle_detected`; `processFlowRunAdvance` independently enforces `MAX_STEPS_PER_RUN = 1000` before any node dispatch, force-exiting a run with `exit_reason = 'step_budget_exceeded'` (`flow-run-advance.worker.ts:170-177`). Both layers are test-pinned (`flow-validate.test.ts` cycle case; `flow-run-advance.test.ts` step-budget case pre-seeds exactly `MAX_STEPS_PER_RUN` rows and asserts the guard fires with no further dispatch).
- **CR-02 (atomic enrollExisting=false seed, plan 06-18):** `seedMembershipSnapshotAtomic` now runs *inside* `publishFlow`'s own transaction, immediately after the flows UPDATE and before commit (`flow.repository.ts:356-382, 480-482`), with a 60s bounded statement timeout. The route (`flows.routes.ts:295-306`) enqueues the async `flow-enroll-existing` job **only** for the `enrollExisting=true` back-fill. The race window and job-loss failure mode are both eliminated. Pinned by `flow-enroll-atomic.test.ts` (seed populated synchronously with no worker running, zero runs, non-matching contact untouched).
- **WR-01 (aborted-transaction 409, plan 06-20):** `deleteSegment` wraps the DELETE in `SAVEPOINT seg_delete` and does `ROLLBACK TO SAVEPOINT` in the 23503 catch before re-querying (`segment.repository.ts:378-415`), so the canceled-campaign/flow-FK 409 path works instead of surfacing a 25P02 500. Pinned by `segment-delete-conflict.test.ts`.
- **WR-02 (no_entry validation, plan 06-17):** a trigger with no outgoing edge now fails publish with `no_entry` (`flow-validate.ts:71-75`); `no_trigger` and `no_entry` are mutually exclusive, so the shared `"trigger"` field key in `shapeFlowValidationFields` cannot collide. UI copy exists in both `flow-validation.ts` and `NodeConfigPanel.tsx`.
- **WR-04 (segment re-entry snapshot staleness, plan 06-19):** the sweep now runs a bounded anti-join DELETE clearing snapshot rows for contacts who left the trigger segment, *before* the empty-membership early return (`flow-segment-sweep.worker.ts:106-119`), restoring leave→rejoin re-entry under `canEnterFlow`'s authority. Pinned by the two-scenario regression in `flow-segment-trigger.test.ts` (every_time re-enters; once_ever stays blocked).
- **WR-05 (autosave error state, plan 06-21):** `deriveAutosaveState` never reads "saved" while a failed save has unsaved changes pending; the toolbar renders «Не сохранено — повтор…» and a 4s delayed retry re-attempts the failed target without requiring a user edit (`useAutosaveDraft.ts:74-172`, `FlowCanvas.tsx:321-330`). The pure derivation is test-pinned (`autosaveState.test.ts`).

No new critical defects were found in the fixes themselves. The adversarial pass did surface **two new warnings in the validation/dispatch seam** (dangling edge targets are publishable; a `fromSenderId`-only send node validates but can never dispatch), one operational warning introduced by the CR-01 backstop (unindexed hot-path count), and confirmed that three warnings and five info items from the previous round remain unaddressed (they were not in scope for plans 06-17..06-21 and are carried forward below with fresh IDs).

## Warnings

### WR-01: Edges to nonexistent nodes pass both the Zod schema and publish validation — a dangling entry edge yields a run that throws on every advance, re-nudged by reconciliation every 60s forever

**File:** `packages/flows-core/src/flow-definition-schema.ts:107-113`, `packages/flows-core/src/flow-validate.ts:154-181`, `apps/worker/src/queues/flows/flow-trigger-evaluator.worker.ts:70-84`, `apps/worker/src/queues/flows/flow-run-advance.worker.ts:180-185`
**Issue:** `flowEdgeSchema` accepts any non-empty `source`/`target` string with no referential-integrity check against `nodes`, and `validateFlowDefinition` never verifies edge targets exist — worse, `pathReachesExit` explicitly treats a missing node as satisfied (`if (!node) return true`, line 164), so a dangling target also subverts `branch_missing_exit`. The canvas can't produce this (`serializeCanvas` filters edges to kept nodes), but the PATCH API accepts any schema-valid definition from any ordinary workspace member. A published `trigger → <ghost-id>` definition passes all five checks (`no_trigger`/`no_entry`/`empty_send`/`branch_missing_exit`/`cycle_detected`); `loadEntryNodeId` → `resolveNextNodeId` happily returns the ghost id; every enrolled contact gets a `flow_runs` row with `current_node_id` pointing at a node that doesn't exist. `processFlowRunAdvance` then throws `current_node_id ... not found in pinned definition` on every attempt — the BullMQ job fails through its 5 retries, the run stays `waiting` with a due `next_wake_at`, and the 60s reconciliation scan re-enqueues a fresh advance (which throws again) **every tick, forever, per enrolled contact**. The runs never reach a terminal state (blocking flow deletion) and pollute the failed-job set continuously.
**Fix:** Add edge referential integrity as a publish-time hard error in `validateFlowDefinition` (it already builds `nodesById`):

```ts
for (const edge of def.edges) {
  if (!nodesById.has(edge.source) || !nodesById.has(edge.target)) {
    errors.push({ code: "dangling_edge", nodeId: edge.id });
  }
}
```

and change `pathReachesExit`'s missing-node branch from `return true` to `return false` (fail closed). Optionally also enforce it in `flowDefinitionSchema` via `superRefine` so drafts can't persist dangling edges at all.

### WR-02: A send node configured with `fromSenderId` but no `fromEmail` passes `empty_send` validation but can never dispatch — the email silently never sends while the run advances past it

**File:** `packages/flows-core/src/flow-validate.ts:58-65`, `apps/worker/src/queues/flows/flow-send.ts:92-98`, `apps/web/src/features/flows/canvas/NodeConfigPanel.tsx:443-453`
**Issue:** The validator accepts `fromSenderId OR fromEmail` (`hasSender = Boolean(node.fromSenderId || node.fromEmail)`), but the dispatcher (`readFlowSendPrereqs`) requires `node.templateId && node.fromEmail` and **throws** otherwise — it never resolves `fromSenderId` to an address. A `fromSenderId`-only node is therefore publishable-but-undeliverable: at dispatch time `handleSendNode` has already enqueued the send job and advanced the run (step recorded as `outcome: "enqueued"`), then the `email-triggered` job fails all 5 attempts and the email is **never sent**, with no user-visible signal anywhere (the flow_run_steps log claims the step succeeded). The UI normally writes `fromEmail` alongside `fromSenderId`, but `SendConfigSection`'s `fromEmail: sender?.fromEmail ?? config.fromEmail` yields `undefined` whenever the senders lookup cache misses the picked id, and the PATCH API accepts the shape directly regardless.
**Fix:** Align the validator to the dispatcher: require `fromEmail` (not `fromSenderId || fromEmail`) in the `empty_send` check — or make `readFlowSendPrereqs` resolve `fromSenderId` → verified-sender email at dispatch time. Either side works; today they contradict each other across the trust boundary.

### WR-03: `flows.enroll_cursor` is never reset between enroll-existing passes — a re-publish with «Зачислить и опубликовать» silently skips most of the segment

**File:** `apps/worker/src/queues/flows/flow-enroll-existing.worker.ts:138-144, 205-228`, `apps/api/src/modules/flows/flow.repository.ts:418-490`, `packages/db/migrations/0033_flows_enroll_cursor.sql`
**Issue:** Carried over from the previous round (unaddressed by plans 06-17..06-21; verified still present — no `enroll_cursor` reset exists anywhere in `apps/` or `packages/`). `enrollBatch` persists the keyset cursor on the flows row; after the first pass completes it holds the segment's highest matched contact UUID. A later re-publish with `enrollExisting=true` produces a new jobId (new `liveVersionId`), the job runs, but `processFlowEnrollExisting` resumes from the stale cursor — the first batch's `c.id > $cursor` matches almost nothing, `processed === 0`, and the loop exits immediately. Contacts who joined the segment since the first publish but whose UUIDs sort below the cursor are never back-filled by the explicit enroll action (only the ≤15-min sweep eventually catches them). This contradicts migration 0033's documented semantics ("NULL means no batch has run yet for this flow's **current** enroll-existing pass").
**Fix:** Reset the cursor when a new pass starts — `UPDATE flows SET enroll_cursor = NULL` inside `publishFlow`'s transaction (it already holds the row `FOR UPDATE`), or key the cursor by pass (store the pass's version id alongside; treat a mismatch as NULL).

### WR-04: `deleteFlow` opens a nested pooled transaction while holding `FOR UPDATE` — pool-exhaustion stall pattern plus a TOCTOU count

**File:** `apps/api/src/modules/flows/flow.repository.ts:627-660`, `apps/api/src/modules/flows/flow-run.repository.ts:172-181`
**Issue:** Carried over (still present). Inside `deleteFlow`'s `withTenantTransaction` (holding the flows row `FOR UPDATE`), `activeRunCount(id)` opens a **second** `withTenantTransaction`, checking out another connection from the same pool. N concurrent `deleteFlow` calls each hold one connection while waiting for a second; once N reaches the pool max, the pool deadlocks (pg's default Pool has no acquisition timeout). The count also runs in a different transaction snapshot from the DELETE that acts on it, undermining the `FOR UPDATE` lock's purpose.
**Fix:** Query the count on the already-open `client`:

```ts
const { rows: countRows } = await client.query<{ count: string }>(
  `SELECT count(*) FROM flow_runs WHERE workspace_id = $1 AND flow_id = $2 AND status IN ('waiting','advancing')`,
  [workspaceId, id]
);
```

### WR-05: `enroll-preview` runs an unbounded segment count on a member-accessible route — the statement-timeout DoS bound applied everywhere else is missing here

**File:** `apps/api/src/modules/flows/flows.routes.ts:252`
**Issue:** Carried over (still present). The D-04 enroll-preview route calls `countSegmentMembers(segment.definition)` with no `statementTimeoutMs`, unlike the segments module's own preview/save paths which bound evaluation (the option exists on the function signature and is simply not passed). A pathological segment definition holds a pooled RLS connection for the full query duration on an ordinary-member endpoint, and the publish dialog fires this on every open.
**Fix:** `countSegmentMembers(segment.definition, { statementTimeoutMs: 15_000 })` and a "count unavailable" fallback in the dialog on timeout.

### WR-06: The CR-01 step-budget guard counts an unindexed, unbounded append-only table on every single advance — the backstop meant to protect engine liveness becomes its bottleneck

**File:** `apps/worker/src/queues/flows/flow-run-advance.worker.ts:97-103, 170-171`, `packages/db/migrations/0026_flows.sql:101-111`
**Issue:** `countFlowRunSteps` runs `SELECT count(*) FROM flow_run_steps WHERE flow_run_id = $1 AND workspace_id = $2` on **every** advance, but `flow_run_steps` has no index on `flow_run_id` (migration 0026 creates only the PK; 0027-0034 add none) — Postgres FKs do not auto-index the referencing side. Every advance therefore sequential-scans the fastest-growing table in the flow engine (one row per node visit per run, append-only, never pruned). At the platform's stated target (hundreds of thousands of sends/day) this degrades every advance linearly with total history, delaying `next_wake_at` deadlines platform-wide — late emails are a direct violation of the core "вовремя доходят" requirement, and the guard added specifically to prevent worker stalls becomes the thing stalling it. The missing index also makes `deleteFlow`'s `ON DELETE CASCADE` into `flow_run_steps` a per-run seq scan.
**Fix:** Add a migration: `CREATE INDEX idx_flow_run_steps_workspace_run ON flow_run_steps (workspace_id, flow_run_id);`. Alternatively (cheaper still), replace the per-advance `count(*)` with a `step_count` integer on `flow_runs` incremented in the same UPDATE that moves the pointer.

## Info

### IN-01: `getRunCounts` is exported but has no callers

**File:** `apps/api/src/modules/flows/flow-run.repository.ts:78-83`
**Issue:** Carried over (verified: no non-dist references outside this file). `listRuns` uses the internal `queryRunCounts`; the exported wrapper is dead code.
**Fix:** Remove the export, or wire the FlowDetailPage header (currently a `pageSize: 1` runs fetch) to a dedicated counts endpoint using it.

### IN-02: Contact email-uniqueness pre-checks race the unique constraint — concurrent duplicate create surfaces as a raw 500

**File:** `apps/api/src/modules/contacts/contact.repository.ts:229-234, 291-299`
**Issue:** Carried over (still present). `isEmailTaken` + INSERT/UPDATE is not atomic; the loser of a concurrent race hits `contacts_workspace_email_unique` (23505), which `createContact`/`updateContact` don't map — the client gets a 500 instead of the `email_taken` 409.
**Fix:** Catch 23505 and rethrow as `ContactConflictError("...", "email_taken")`.

### IN-03: Flow handlers enqueue BullMQ jobs inside the open advance transaction

**File:** `apps/worker/src/queues/flows/handlers/send-node.ts:126-139`, `apps/worker/src/queues/flows/handlers/delay-node.ts:64-67`
**Issue:** Carried over. The `emailTriggeredQueue.add` / `enqueueFlowRunAdvance` side effects happen before the surrounding transaction commits; a rollback after the enqueue leaves a dispatched job with no committed state change. The `claimFlowSend` ledger and the queue-as-doorbell guards make both harmless in practice (bookkeeping drift only).
**Fix:** Acceptable as-is; if hardening, return enqueue instructions from the handlers and perform the Redis adds after commit.

### IN-04: `void tickQueue.add(...)` swallows the repeatable-registration promise — a boot-time Redis failure becomes an unhandled rejection

**File:** `apps/worker/src/queues/flows/flow-reconciliation.worker.ts:102-106`, `apps/worker/src/queues/flows/flow-segment-sweep.worker.ts:180-184`
**Issue:** Carried over (still present in both workers). A rejected registration promise is discarded with `void` and surfaces as an unhandled rejection (fatal by default on Node 22) instead of a logged, retryable failure.
**Fix:** Append `.catch((err) => console.error("failed to register repeatable tick", err))` or await it in `buildWorker`.

### IN-05: The enroll-existing worker never re-checks flow status — batches keep enrolling into a paused flow, and publishing a paused flow with «Зачислить и опубликовать» enrolls the whole segment into a paused flow

**File:** `apps/worker/src/queues/flows/flow-enroll-existing.worker.ts:32-40, 187-229`, `apps/api/src/modules/flows/flows.routes.ts:295-306`
**Issue:** Carried over, with a new interplay: `loadFlow` reads trigger/reentry config but not `status`, so a flow paused mid-back-fill keeps receiving `flow_runs` inserts batch after batch. Additionally, since 06-16 keeps a paused flow paused on publish, the publish route still enqueues the enroll job for a paused segment-triggered flow when `enrollExisting=true` — the entire current segment is enrolled into a **paused** flow (runs frozen by the D-18 guard, all releasing at once on resume). The dialog's paused-copy («публикация не возобновит отправку») does not mention that enrollment itself still happens.
**Fix:** Include `status` in `loadFlow` and stop (without clearing the cursor) when the flow is no longer `live`; either suppress the enroll option for a paused flow's publish dialog or state explicitly that contacts will be enrolled now and mailed on resume.

### IN-06: Autosave residual honesty gaps — «Сохранено» during the pre-debounce dirty window, and the "single bounded retry" is actually an every-4s retry loop

**File:** `apps/web/src/features/flows/canvas/useAutosaveDraft.ts:74-172`
**Issue:** (a) `deriveAutosaveState` returns `idle` («Сохранено») when `!isPending && !isError` even while `dirty` is true — i.e. for up to ~1s of debounce after every edit the toolbar asserts the canvas is saved when it isn't; a user who edits and immediately closes the tab loses that edit while the UI claimed otherwise. (b) The retry effect's comment claims "a single bounded retry", but each failed retry re-triggers the effect (isError flips false→true per mutate cycle), producing an indefinite retry every ~4s while the tab is open — safe (never a hot loop) but mislabeled; a permanently-rejected payload will PATCH forever. (c) Concurrent in-flight PATCHes are possible (a new debounced save can start while a slow prior one is pending), so an out-of-order arrival can transiently persist a stale draft server-side; the next change re-converges.
**Fix:** (a) treat `dirty && !isPending` as a distinct "pending" (or reuse "saving") state; (b) either cap retries or fix the comment; (c) acceptable at 1s debounce, note only.

### IN-07: The atomic CR-02 seed runs a potentially 60-second INSERT inside the publish HTTP request while holding the flows row lock

**File:** `apps/api/src/modules/flows/flow.repository.ts:356-382, 480-482`
**Issue:** The accepted cost of the (correct) CR-02 fix: for a large segment (100k-1M contacts) the `INSERT ... SELECT` seed runs inside `publishFlow`'s transaction — the publish request holds a pooled RLS connection plus the `FOR UPDATE` lock on the flows row for up to `PUBLISH_SEED_STATEMENT_TIMEOUT_MS` (60s), during which any concurrent draft-update/pause/publish on the same flow blocks and the HTTP client waits. On statement timeout the whole publish correctly rolls back (fail closed), but the marketer just sees a generic error.
**Fix:** No change required for correctness. Operationally: monitor publish latency; if it becomes a problem, the documented alternative (a `flows.enroll_seeded_at` gate on the sweep/event re-check plus an async seed) preserves atomicity semantics without the in-request wait.

---

_Reviewed: 2026-07-10T15:06:08Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
