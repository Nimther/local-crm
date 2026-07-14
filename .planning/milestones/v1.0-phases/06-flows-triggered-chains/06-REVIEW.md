---
phase: 06-flows-triggered-chains
reviewed: 2026-07-13T16:57:08Z
depth: standard
files_reviewed: 117
files_reviewed_list:
  - apps/api/package.json
  - apps/api/src/modules/campaigns/__tests__/send-settings.test.ts
  - apps/api/src/modules/campaigns/send-settings.routes.ts
  - apps/api/src/modules/contacts/__tests__/contact-crud.test.ts
  - apps/api/src/modules/contacts/__tests__/csv-import.test.ts
  - apps/api/src/modules/contacts/contact.repository.ts
  - apps/api/src/modules/contacts/contacts.routes.ts
  - apps/api/src/modules/contacts/csv-import.repository.ts
  - apps/api/src/modules/contacts/csv-import.routes.ts
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
  - apps/worker/src/queues/imports-csv.worker.ts
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
  - packages/db/migrations/0035_csv_imports_default_timezone.sql
  - packages/db/migrations/meta/0034_snapshot.json
  - packages/db/migrations/meta/_journal.json
  - packages/db/src/index.ts
  - packages/db/src/schema/contacts.ts
  - packages/db/src/schema/csv-imports.ts
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
  - packages/shared-schemas/src/csv-import.ts
  - packages/shared-schemas/src/flow.ts
  - packages/shared-schemas/src/index.ts
  - packages/shared-schemas/src/queues.ts
findings:
  critical: 0
  warning: 7
  info: 8
  total: 15
status: issues_found
---

# Phase 06: Code Review Report (re-review after gap-closure round 4, plans 06-22..06-24)

**Reviewed:** 2026-07-13T16:57:08Z
**Depth:** standard
**Files Reviewed:** 117
**Status:** issues_found

## Summary

Re-review after gap-closure round 4 (commits 07239db..1bc6812). The source delta since the round-3 review is 12 files: the CSV-import default-timezone thread (06-22: migration 0035, `csv_imports.default_timezone`, `applyCsvRowMapping` options, dry-run route/repository, apply worker), the mapping-step `TimezoneCombobox` (06-23), and the offline-paused autosave state (06-24). All other files in scope are byte-identical to the round-3 review; their open findings were re-verified against current code and carried forward.

**Round-4 fixes verified as correct:**

- **06-22 (CSV default timezone):** the default is threaded through a single shared interpreter — `applyCsvRowMapping(raw, mapping, { defaultTimezone })` (`packages/contacts-core/src/csv-mapping.ts:96-101`) — used by BOTH the dry-run counter (`csv-import.routes.ts:106`) and the apply worker (`imports-csv.worker.ts:92-94`), and the worker reads the value the dry-run route persisted (`saveDryRunResult` → `default_timezone`), so dry-run and apply cannot drift on it. Precedence is correct (mapped per-row value always wins; only an undefined `input.timezone` is filled), the default is fail-closed through the same `isValidIanaTimezone` gate as mapped values, a blank mapped cell falls back to the default, and omitting the default on a later dry-run resets the column via `?? null` (no stale default). All five behaviors are test-pinned (`csv-import.test.ts` dtz-1..dtz-5).
- **06-23 (mapping-step combobox):** `TimezoneCombobox` is the same allowlist-only component used by the contact form and send settings (never free text, T-06-11-03); the wizard omits the key entirely when unset (`...(defaultTimezone ? { defaultTimezone } : {})`), keeping the request backward compatible.
- **06-24 (offline autosave):** `deriveAutosaveState` now checks `isPending && isPaused` FIRST and derives "error" (`useAutosaveDraft.ts:92`), so a mutation paused by TanStack Query's default `networkMode: 'online'` (offline: mutationFn never invoked, `isError` never true, `isPending` stuck true) reads «Не сохранено — повтор…» instead of an indefinite «Сохранение…». Verified against the actual mutation config: `useUpdateFlowDraft` (`apps/web/src/features/flows/api.ts:223-231`) sets no `networkMode` override and no global QueryClient override exists, so the `isPaused` assumption holds. The adversarial hypotheses were traced and disproven: the 4s retry effect keys on `mutation.isError`, which stays false while paused, so no offline retry loop forms; a paused mutation resumes automatically via `onlineManager` on reconnect and settles the indicator back to "idle"; a genuine network failure while the browser still reports online takes the `isError` path already covered by 06-21. Both new states are test-pinned (`autosaveState.test.ts`).

The adversarial pass over the CSV module (its routes/repository/worker enter this review's scope for the first time this round) surfaced **one new warning** (no status-based ordering guards on the dry-run/apply routes — the seam 06-22 just widened by adding a second piece of persisted dry-run config) and **one new info** (the API accepts an arbitrary unbounded `defaultTimezone` string, persists it, and misattributes the config error as per-row data errors). Six warnings and seven info items from round 3 remain unaddressed (plans 06-22..06-24 did not target them; each was re-verified as still present) and are carried forward.

## Warnings

### WR-01: CSV dry-run/apply routes have no import-status ordering guards — a dry-run during apply reclassifies rows under the worker, clobbers `applying` → `ready`, and a `failed` (truncated) upload can still be dry-run and applied

**File:** `apps/api/src/modules/contacts/csv-import.routes.ts:246-291`, `apps/api/src/modules/contacts/csv-import.repository.ts:141-174`, `apps/worker/src/queues/imports-csv.worker.ts:45-96`
**Issue:** Neither route checks `csv_imports.status` before acting. (a) POST `/dry-run` on an import that is currently `applying` re-runs `setStagedRowClassification` over ALL rows — flipping rows the worker already resolved (`created`/`updated`) back to `pending`, which the worker's final recount then sees (`stillPending > 0` → job throws → BullMQ retry re-processes those rows with the config the worker loaded ONCE at job start, while the concurrent dry-run just persisted a DIFFERENT mapping/defaultTimezone) — and `saveDryRunResult` unconditionally overwrites `status = 'ready'`, which also stops the wizard's progress polling (`refetchInterval` only continues while `status === 'applying'`). (b) POST `/apply` only requires `existing.mapping`, so an import whose upload was marked `failed` mid-parse (malformed CSV, or silently truncated at `UPLOAD_MAX_BYTES`) can still be dry-run (which flips it to `ready`) and applied — silently importing a partial file the upload path deliberately fail-closed on. (c) `/apply` on an already-`applying` import enqueues a second concurrent job (row-level `FOR UPDATE` guards prevent double-writes, but the two jobs race the final recount/summary). None of this is reachable from the wizard UI; all of it is reachable by any ordinary authenticated workspace member via the API, and 06-22 widened the seam by adding a second piece of dry-run-persisted config (`default_timezone`) the in-flight worker will not re-read.
**Fix:** Gate both routes on status: reject dry-run with 409 when `existing.status === 'applying'` (and arguably `'failed'`), and reject apply unless `existing.status === 'ready'`:

```ts
if (existing.status === "applying") {
  return reply.code(409).send({ error: "Import is currently being applied" });
}
```

For apply: `if (existing.status !== "ready") return reply.code(409).send({ error: "Run the dry-run validation before applying" });` (this subsumes the current `!existing.mapping` check and closes the `failed`-import path).

### WR-02: Edges to nonexistent nodes pass both the Zod schema and publish validation — a dangling entry edge yields a run that throws on every advance, re-nudged by reconciliation every 60s forever

**File:** `packages/flows-core/src/flow-definition-schema.ts:107-113`, `packages/flows-core/src/flow-validate.ts:154-181`, `apps/worker/src/queues/flows/flow-trigger-evaluator.worker.ts:70-84`, `apps/worker/src/queues/flows/flow-run-advance.worker.ts:180-185`
**Issue:** Carried over from round 3 (verified still present: `pathReachesExit`'s missing-node branch still `return true` at `flow-validate.ts:164`; no `dangling_edge` check exists). `flowEdgeSchema` accepts any non-empty `source`/`target` string with no referential-integrity check against `nodes`, and `validateFlowDefinition` never verifies edge targets exist — worse, `pathReachesExit` explicitly treats a missing node as satisfied, so a dangling target also subverts `branch_missing_exit`. The canvas can't produce this (`serializeCanvas` filters edges to kept nodes), but the PATCH API accepts any schema-valid definition. A published `trigger → <ghost-id>` definition passes all five publish checks; every enrolled contact gets a `flow_runs` row whose `current_node_id` points at a node that doesn't exist; `processFlowRunAdvance` throws on every attempt, the run stays `waiting` with a due `next_wake_at`, and the 60s reconciliation scan re-enqueues a fresh (again-failing) advance every tick, forever, per enrolled contact — runs never reach a terminal state (blocking flow deletion) and pollute the failed-job set continuously.
**Fix:** Add edge referential integrity as a publish-time hard error in `validateFlowDefinition` (it already builds `nodesById`):

```ts
for (const edge of def.edges) {
  if (!nodesById.has(edge.source) || !nodesById.has(edge.target)) {
    errors.push({ code: "dangling_edge", nodeId: edge.id });
  }
}
```

and change `pathReachesExit`'s missing-node branch from `return true` to `return false` (fail closed). Optionally also enforce it in `flowDefinitionSchema` via `superRefine`.

### WR-03: A send node configured with `fromSenderId` but no `fromEmail` passes `empty_send` validation but can never dispatch — the email silently never sends while the run advances past it

**File:** `packages/flows-core/src/flow-validate.ts:58-65`, `apps/worker/src/queues/flows/flow-send.ts:92-98`, `apps/web/src/features/flows/canvas/NodeConfigPanel.tsx:443-453`
**Issue:** Carried over (verified still present: `hasSender = Boolean(node.fromSenderId || node.fromEmail)` at `flow-validate.ts:61` vs `if (!node.templateId || !node.fromEmail) throw` at `flow-send.ts:92`). The validator accepts `fromSenderId OR fromEmail`, but the dispatcher requires `fromEmail` and throws otherwise — it never resolves `fromSenderId` to an address. A `fromSenderId`-only node is publishable-but-undeliverable: `handleSendNode` records the step as `outcome: "enqueued"` and advances the run, then the `email-triggered` job fails all 5 attempts and the email is never sent, with no user-visible signal (the step log claims success). The UI normally writes `fromEmail` alongside `fromSenderId`, but a senders-cache miss yields `fromEmail: undefined`, and the PATCH API accepts the shape directly.
**Fix:** Align the validator to the dispatcher: require `fromEmail` in the `empty_send` check — or make `readFlowSendPrereqs` resolve `fromSenderId` → verified-sender email at dispatch time.

### WR-04: `flows.enroll_cursor` is never reset between enroll-existing passes — a re-publish with «Зачислить и опубликовать» silently skips most of the segment

**File:** `apps/worker/src/queues/flows/flow-enroll-existing.worker.ts:138-144, 205-228`, `apps/api/src/modules/flows/flow.repository.ts:418-490`, `packages/db/migrations/0033_flows_enroll_cursor.sql`
**Issue:** Carried over (verified: no `enroll_cursor` reset exists anywhere in `apps/` or `packages/`). `enrollBatch` persists the keyset cursor on the flows row; after the first pass completes it holds the segment's highest matched contact UUID. A later re-publish with `enrollExisting=true` produces a new jobId, but `processFlowEnrollExisting` resumes from the stale cursor — the first batch matches almost nothing, `processed === 0`, and the loop exits immediately. Contacts who joined the segment since the first publish but whose UUIDs sort below the cursor are never back-filled by the explicit enroll action (only the ≤15-min sweep eventually catches them). This contradicts migration 0033's documented semantics.
**Fix:** Reset the cursor when a new pass starts — `UPDATE flows SET enroll_cursor = NULL` inside `publishFlow`'s transaction (it already holds the row `FOR UPDATE`), or key the cursor by pass version id.

### WR-05: `deleteFlow` opens a nested pooled transaction while holding `FOR UPDATE` — pool-exhaustion stall pattern plus a TOCTOU count

**File:** `apps/api/src/modules/flows/flow.repository.ts:645`, `apps/api/src/modules/flows/flow-run.repository.ts:172-181`
**Issue:** Carried over (verified: `deleteFlow` still calls `activeRunCount(id)` at `flow.repository.ts:645` from inside its own `withTenantTransaction`, and `activeRunCount` still opens a second `withTenantTransaction`). N concurrent `deleteFlow` calls each hold one pooled connection while waiting for a second; once N reaches the pool max, the pool deadlocks (pg's default Pool has no acquisition timeout). The count also runs in a different transaction snapshot from the DELETE that acts on it, undermining the `FOR UPDATE` lock's purpose.
**Fix:** Query the count on the already-open `client`:

```ts
const { rows: countRows } = await client.query<{ count: string }>(
  `SELECT count(*) FROM flow_runs WHERE workspace_id = $1 AND flow_id = $2 AND status IN ('waiting','advancing')`,
  [workspaceId, id]
);
```

### WR-06: `enroll-preview` runs an unbounded segment count on a member-accessible route — the statement-timeout DoS bound applied everywhere else is missing here

**File:** `apps/api/src/modules/flows/flows.routes.ts:252`
**Issue:** Carried over (verified: `countSegmentMembers(segment.definition)` at line 252 still passes no `statementTimeoutMs`, unlike the segments module's own preview/save paths). A pathological segment definition holds a pooled RLS connection for the full query duration on an ordinary-member endpoint, and the publish dialog fires this on every open.
**Fix:** `countSegmentMembers(segment.definition, { statementTimeoutMs: 15_000 })` and a "count unavailable" fallback in the dialog on timeout.

### WR-07: The step-budget guard counts an unindexed, unbounded append-only table on every single advance — the backstop meant to protect engine liveness becomes its bottleneck

**File:** `apps/worker/src/queues/flows/flow-run-advance.worker.ts:97-103, 170-171`, `packages/db/migrations/0026_flows.sql:101-111`
**Issue:** Carried over (verified: migrations 0026-0035 still create no index on `flow_run_steps.flow_run_id` — Postgres FKs do not auto-index the referencing side). `countFlowRunSteps` runs `SELECT count(*) FROM flow_run_steps WHERE flow_run_id = $1 AND workspace_id = $2` on every advance, sequential-scanning the fastest-growing table in the flow engine. At target volume this degrades every advance linearly with total history, delaying `next_wake_at` deadlines platform-wide — the guard added to prevent worker stalls becomes the thing stalling it. The missing index also makes `deleteFlow`'s `ON DELETE CASCADE` into `flow_run_steps` a per-run seq scan.
**Fix:** Add a migration: `CREATE INDEX idx_flow_run_steps_workspace_run ON flow_run_steps (workspace_id, flow_run_id);` — or replace the per-advance `count(*)` with a `step_count` integer on `flow_runs` incremented in the same UPDATE that moves the pointer.

## Info

### IN-01: `defaultTimezone` is accepted unbounded and unvalidated at the dry-run route — an invalid default is persisted to `csv_imports.default_timezone` and misattributed as a per-row "Invalid timezone" data error on every row lacking its own timezone

**File:** `packages/shared-schemas/src/csv-import.ts:39`, `apps/api/src/modules/contacts/csv-import.routes.ts:246-272`, `packages/contacts-core/src/csv-mapping.ts:96-118`
**Issue:** New (06-22). The zod schema is deliberately format-only (`z.string().min(1).nullish()` — no `.max()`, no IANA check), and the route never validates the default itself; instead each row that would receive it fails `isValidIanaTimezone` individually. The design is fail-closed (an invalid default can never land on a contact — correct and test-pinned), but two rough edges remain: (a) a dry-run with a bad default (API-supplied, or a browser-vs-server ICU skew through the combobox) marks every timezone-less row `error` with reason "Invalid timezone" — the D-18 error-report CSV then blames N data rows for what is one config error, with no hint the default (not the data) is at fault; and (b) the arbitrary string (bounded only by the body-size limit, not by any schema `.max()`) IS persisted verbatim into `csv_imports.default_timezone` with `status = 'ready'`, slightly contradicting the "never stored" phrasing in the csv-mapping docstring (accurate for contacts, not for the config column).
**Fix:** Validate once at the route before `computeDryRunSummary` — `if (parsed.data.defaultTimezone && !isValidIanaTimezone(parsed.data.defaultTimezone)) return reply.code(400).send({ error: "Invalid default timezone" });` (apps/api already depends on `@mega-crm/delivery-core`) — and add `.max(64)` to the schema. Keep the per-row check as defense-in-depth.

### IN-02: `getRunCounts` is exported but has no callers

**File:** `apps/api/src/modules/flows/flow-run.repository.ts:78-83`
**Issue:** Carried over (verified: no references outside this file). `listRuns` uses the internal `queryRunCounts`; the exported wrapper is dead code.
**Fix:** Remove the export, or wire the FlowDetailPage header (currently a `pageSize: 1` runs fetch) to a dedicated counts endpoint using it.

### IN-03: Contact email-uniqueness pre-checks race the unique constraint — concurrent duplicate create surfaces as a raw 500

**File:** `apps/api/src/modules/contacts/contact.repository.ts:229-234, 291-299`
**Issue:** Carried over (verified: `isEmailTaken` pre-check throws `email_taken`, but no 23505 catch exists). The loser of a concurrent race hits `contacts_workspace_email_unique` (23505), which `createContact`/`updateContact` don't map — the client gets a 500 instead of the `email_taken` 409.
**Fix:** Catch 23505 and rethrow as `ContactConflictError("...", "email_taken")`.

### IN-04: Flow handlers enqueue BullMQ jobs inside the open advance transaction

**File:** `apps/worker/src/queues/flows/handlers/send-node.ts:127-139`, `apps/worker/src/queues/flows/handlers/delay-node.ts:64-67`
**Issue:** Carried over (verified still present). The `emailTriggeredQueue.add` / `enqueueFlowRunAdvance` side effects happen before the surrounding transaction commits; a rollback after the enqueue leaves a dispatched job with no committed state change. The `claimFlowSend` ledger and the queue-as-doorbell guards make both harmless in practice (bookkeeping drift only).
**Fix:** Acceptable as-is; if hardening, return enqueue instructions from the handlers and perform the Redis adds after commit.

### IN-05: `void tickQueue.add(...)` swallows the repeatable-registration promise — a boot-time Redis failure becomes an unhandled rejection

**File:** `apps/worker/src/queues/flows/flow-reconciliation.worker.ts:102-106`, `apps/worker/src/queues/flows/flow-segment-sweep.worker.ts:180-184`
**Issue:** Carried over (verified still present in both workers). A rejected registration promise is discarded with `void` and surfaces as an unhandled rejection (fatal by default on Node 22) instead of a logged, retryable failure.
**Fix:** Append `.catch((err) => console.error("failed to register repeatable tick", err))` or await it in `buildWorker`.

### IN-06: The enroll-existing worker never re-checks flow status — batches keep enrolling into a paused flow, and publishing a paused flow with «Зачислить и опубликовать» enrolls the whole segment into a paused flow

**File:** `apps/worker/src/queues/flows/flow-enroll-existing.worker.ts:32-40, 187-229`, `apps/api/src/modules/flows/flows.routes.ts:295-306`
**Issue:** Carried over (verified: `loadFlow`'s SELECT at lines 34-37 still reads trigger/reentry config but not `status`). A flow paused mid-back-fill keeps receiving `flow_runs` inserts batch after batch, and the publish route still enqueues the enroll job for a paused segment-triggered flow when `enrollExisting=true` — the entire current segment is enrolled into a paused flow (runs frozen by the D-18 guard, all releasing at once on resume). The dialog's paused-copy does not mention that enrollment itself still happens.
**Fix:** Include `status` in `loadFlow` and stop (without clearing the cursor) when the flow is no longer `live`; either suppress the enroll option for a paused flow's publish dialog or state explicitly that contacts will be enrolled now and mailed on resume.

### IN-07: Autosave residual honesty gaps — «Сохранено» during the pre-debounce dirty window, and the "single bounded retry" is actually an every-4s retry loop

**File:** `apps/web/src/features/flows/canvas/useAutosaveDraft.ts:91-96, 98, 163-178`
**Issue:** Carried over, updated for 06-24 (which correctly closed the paused-offline case; items (a)-(c) remain). (a) `deriveAutosaveState` still returns `idle` («Сохранено») when `!isPending && !isError` even while `dirty` is true — for up to ~1s of debounce after every edit (including the window before an offline save even pauses) the toolbar asserts the canvas is saved when it isn't; a user who edits and immediately closes the tab loses that edit while the UI claimed otherwise. (b) The retry constant's comment still claims "Bounded single delayed retry ... never a hot loop", but each failed retry re-triggers the effect (isError flips per mutate cycle), producing an indefinite retry every ~4s while the tab is open — safe (never a hot loop, and correctly inert while paused-offline) but mislabeled; a permanently-rejected payload will PATCH forever. (c) Concurrent in-flight PATCHes remain possible (a new debounced save can start while a slow prior one is pending), so an out-of-order arrival can transiently persist a stale draft server-side; the next change re-converges.
**Fix:** (a) treat `dirty && !isPending` as a distinct "pending" (or reuse "saving") state; (b) either cap retries or fix the comment; (c) acceptable at 1s debounce, note only.

### IN-08: The atomic publish seed runs a potentially 60-second INSERT inside the publish HTTP request while holding the flows row lock

**File:** `apps/api/src/modules/flows/flow.repository.ts:356-382, 480-482`
**Issue:** Carried over (accepted cost of the correct CR-02 fix from round 2). For a large segment the `INSERT ... SELECT` seed runs inside `publishFlow`'s transaction — the publish request holds a pooled RLS connection plus the `FOR UPDATE` lock on the flows row for up to 60s, during which any concurrent draft-update/pause/publish on the same flow blocks. On statement timeout the whole publish correctly rolls back (fail closed), but the marketer sees a generic error.
**Fix:** No change required for correctness. Operationally: monitor publish latency; if it becomes a problem, the documented alternative (a `flows.enroll_seeded_at` gate plus an async seed) preserves atomicity semantics without the in-request wait.

---

_Reviewed: 2026-07-13T16:57:08Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
