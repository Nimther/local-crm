---
status: testing
phase: 06-flows-triggered-chains
source: 06-01-SUMMARY.md, 06-02-SUMMARY.md, 06-03-SUMMARY.md, 06-04-SUMMARY.md, 06-05-SUMMARY.md, 06-06-SUMMARY.md, 06-07-SUMMARY.md, 06-08-SUMMARY.md, 06-09-SUMMARY.md, 06-10-SUMMARY.md, 06-11-SUMMARY.md, 06-12-SUMMARY.md, 06-13-SUMMARY.md, 06-14-SUMMARY.md, 06-15-SUMMARY.md, 06-16-SUMMARY.md, 06-17-SUMMARY.md, 06-18-SUMMARY.md, 06-19-SUMMARY.md, 06-20-SUMMARY.md, 06-21-SUMMARY.md, 06-22-SUMMARY.md, 06-23-SUMMARY.md, 06-24-SUMMARY.md
started: 2026-07-13T09:04:39.797Z
updated: 2026-07-13T17:08:09.000Z
mode: mvp
user_story: "As a marketer, I want to visually build, publish, and run automated triggered chains that reuse the proven send pipeline, suppression, and frequency cap, so that the right email reaches the right contact at the right time."
---

## Current Test

number: 10
name: Timezone & Quiet Hours Settings (re-walk after 06-22/06-23)
expected: |
  Open /w/{slug}/contacts/import, upload a CSV, reach the column-mapping step. A «Часовой пояс по умолчанию» combobox is visible, searchable, lists real IANA zones (via Intl.supportedValuesOf), can be cleared, and choosing a zone is reflected in the dry-run result (rows without their own timezone get the chosen default).
awaiting: user response

## Tests

<!-- Section A: User-flow walk-through (MVP mode — halt on failure) -->

### 1. Cold Start Smoke Test
section: user-flow
expected: Kill any running server/worker. Start the application from scratch (API, worker, web). Everything boots without errors, flow migrations are applied, and login + workspace home load live data.
result: pass

### 2. Flows List Page
section: user-flow
expected: Open /w/{slug}/flows. The flows list renders with a status badge per flow (draft/live/paused), a create action, open-canvas navigation, duplicate action, and delete available only for deletable flows (never-published or paused with zero active runs).
result: pass

### 3. Build a Flow on the Canvas
section: user-flow
expected: Create a new flow and open its canvas. All five node types (trigger, delay/wait, conditional branch, send-email, exit) are draggable from the palette onto the canvas, connectable with edges, and each opens a side config panel. The branch node exposes exactly two labelled outgoing edges (Да / Нет).
result: pass

### 4. Autosave Status
section: user-flow
expected: Make a change on the canvas (move a node, edit config). Within ~1s the toolbar shows «Сохранение…» then «Сохранено». There is no manual save button. Reloading the page shows the saved draft.
result: pass

### 5. Publish Validation Blockers
section: user-flow
expected: Leave a node unconfigured (e.g. a send node without a template) and try to publish. The invalid node renders a destructive ring + «Не настроено», and the server 422 blocker list renders in the UI and selects the offending node when clicked.
result: pass

### 6. Publish the Flow
section: user-flow
expected: Fix the blockers and publish. An event-triggered flow shows a simple confirm; a segment-triggered flow shows the enroll dialog («Зачислить и опубликовать» with ~N current-member count / future-entrants-only choice). After publish the flow status badge becomes live.
result: pass

### 7. Trigger Entry & Email Delivery
section: user-flow
expected: Fire the trigger (send the matching event via the events API, or add a contact to the trigger segment). The contact enters the flow — the detail page run counter shows «N in flow» — and the send node's email is actually dispatched through SendGrid to the right contact, respecting any delay you configured.
result: pass

<!-- Section B: Technical checks (run only after Section A passes) -->

### 8. Pause / Resume / Eject
section: technical
expected: Pause the live flow — mid-flight runs freeze (no sends while paused). Resume — overdue steps execute on the next tick. Ejecting a contact (per-row eject in the runs table) marks the run ejected and stops further sends to that contact.
result: pass

### 9. Live-Flow Draft Editing & Publish Changes
section: technical
expected: Edit a live flow — changes accumulate in a draft without affecting the live version or in-flight runs; the detail page offers a «publish changes» action. Publishing changes on a paused flow keeps it paused, and the publish dialog says so.
result: pass

### 10. Timezone & Quiet Hours Settings
section: technical
expected: Workspace send settings expose a default timezone (IANA combobox) + quiet-hours window (start/end/enabled). The contact form exposes a constrained IANA timezone combobox; an invalid zone is rejected. The CSV column-mapping step exposes a «Часовой пояс по умолчанию» combobox (constrained IANA, searchable, clearable) whose chosen zone is applied by dry-run/apply to rows without their own timezone. A flow send inside the quiet window is deferred until the window ends.
result: pending
retest: round 4 re-walk — fix landed in 06-22 (server default-timezone contract) + 06-23 (combobox rendered in CsvImportWizard mapping step)
prior_issue: "выпадающий список со списком часовых поясов отсутствует (2026-07-13, severity major)"

### 11. Autosave Error State & Retry
section: technical
expected: With a flow canvas open, go offline in devtools and make an edit. The toolbar shows «Не сохранено — повтор…» while offline (never a stuck «Сохранение…» or a false «Сохранено»). Restore connectivity: TanStack automatically resumes the paused mutation, the PATCH re-fires, and the toolbar returns to «Сохранено» with no further user edit. Also verify the settled-error case (API stopped, browser online) still shows the honest error state with bounded retry.
result: pending
retest: round 4 re-walk — fix landed in 06-24 (deriveAutosaveState models isPaused; offline pause maps to error state, checked before isPending)
prior_issue: "ошибка не показывается. Просто висит статус «Сохранение...» (2026-07-13, severity major)"

### 12. Shared Timezone Helper (static check)
section: technical
expected: No local loadContactTimezone definition remains in send-node.ts / delay-node.ts; the single shared helper is exported from @mega-crm/delivery-core (grep evidence will be shown for confirmation).
result: pass
source: automated
note: |
  Verified via grep (2026-07-13): `grep -rn "function loadContactTimezone" apps/worker/src/queues/flows/handlers/` -> 0 matches.
  send-node.ts:7,86 and delay-node.ts:3,56 both import loadContactTimezone from "@mega-crm/delivery-core".
  packages/delivery-core/src/contact-timezone.ts:11 is the single definition; re-exported at packages/delivery-core/src/index.ts:69.
  No local duplicate remains in either handler -- matches expected exactly.

<!-- Section C: Coverage check (goal-backward, always last) -->

### 13. Coverage Confirmation
section: coverage
expected: Confirm the outcome clause — "the right email reaches the right contact at the right time" — is delivered: 63 deliverables across 21 summaries are auto-covered by passing tests (idempotent flow sends, shared send pipeline/rate limiter/pre-send gate, version pinning, re-entry control, quiet hours, reconciliation). Summary of auto-covered items will be presented for confirmation.
result: pass

## Auto-Covered Deliverables (source: automated)

<!-- Appended programmatically from coverage blocks -->

### 14. [06-01 D1] Five flow tables (flows, flow_versions, flow_runs, flow_run_steps, flow_segment_membership_snapshot)…
expected: Five flow tables (flows, flow_versions, flow_runs, flow_run_steps, flow_segment_membership_snapshot) exist in the live database with RLS ENABLE+FORCE and NULLIF-guarded workspace_isolation policy
result: pass
source: automated
coverage_id: 06-01-D1
verification: psql information_schema.tables count query + pg_class.relrowsecurity/relforcerowsecurity + pg_policies query (see Task 3 verification transcript)

### 15. [06-01 D2] Immutable published-version storage model: flows.live_version_id references a flow_versions row whos…
expected: Immutable published-version storage model: flows.live_version_id references a flow_versions row whose definition jsonb is never re-pointed for an in-flight run
result: pass
source: automated
coverage_id: 06-01-D2
verification: packages/db/migrations/0026_flows.sql (flow_versions table, flow_runs.flow_version_id ON DELETE RESTRICT FK) + npm run build -w packages/db

### 16. [06-01 D3] A flow-step send can be inserted into sends with kind='flow', a non-null flow_run_id and node_id, an…
expected: A flow-step send can be inserted into sends with kind='flow', a non-null flow_run_id and node_id, and a redelivered identical insert is rejected by the sends_flow_run_node_unique partial index
result: pass
source: automated
coverage_id: 06-01-D3
verification: psql pg_indexes query confirming sends_flow_run_node_unique exists WHERE kind='flow' (see Task 3 verification transcript)

### 17. [06-01 D4] contacts.timezone and workspace_send_settings default-timezone/quiet-hours columns exist for later d…
expected: contacts.timezone and workspace_send_settings default-timezone/quiet-hours columns exist for later dispatch-time resolution
result: pass
source: automated
coverage_id: 06-01-D4
verification: psql information_schema.columns query confirming timezone, default_timezone, quiet_hours_start, quiet_hours_end, quiet_hours_enabled columns (see Task 3 verification transcript)

### 18. [06-02 D1] flowDefinitionSchema parses a well-formed trigger/delay/branch/send/exit node+edge JSON and rejects …
expected: flowDefinitionSchema parses a well-formed trigger/delay/branch/send/exit node+edge JSON and rejects an unknown node type
result: pass
source: automated
coverage_id: 06-02-D1
verification: packages/flows-core/src/__tests__/flow-validate.test.ts#flowDefinitionSchema -- parsing

### 19. [06-02 D2] validateFlowDefinition returns the three D-17 hard errors (no_trigger, empty_send, branch_missing_ex…
expected: validateFlowDefinition returns the three D-17 hard errors (no_trigger, empty_send, branch_missing_exit) for their respective malformed flows, [] for a well-formed flow, and [] for an orphan/dead branch that still satisfies the three hard requirements
result: pass
source: automated
coverage_id: 06-02-D2
verification: packages/flows-core/src/__tests__/flow-validate.test.ts#validateFlowDefinition -- D-17 hard errors

### 20. [06-02 D3] emailTriggeredJobSchema accepts a kind:'flow' variant (flowRunId+nodeId+contactId, no campaignId) al…
expected: emailTriggeredJobSchema accepts a kind:'flow' variant (flowRunId+nodeId+contactId, no campaignId) alongside the existing campaign/test variants, and shared-schemas/apps/worker/apps/api all build clean against the new discriminated union
result: pass
source: automated
coverage_id: 06-02-D3
verification: npm run build -w packages/shared-schemas && npm run build -w apps/worker (both exit 0)

### 21. [06-03 D1] A flow send-node dispatch claims the sends ledger via ON CONFLICT (workspace_id, flow_run_id, node_i…
expected: A flow send-node dispatch claims the sends ledger via ON CONFLICT (workspace_id, flow_run_id, node_id) DO NOTHING, so a redelivered identical job never double-sends
result: pass
source: automated
coverage_id: 06-03-D1
verification: apps/worker/src/queues/__tests__/flow-send-idempotency.test.ts#T-06-03-01: a redelivered flow-step job sends exactly once and inserts exactly one kind='flow' sends row

### 22. [06-03 D2] A kind:'flow' job routes through the SAME email-triggered queue, the SAME per-tenant token bucket, a…
expected: A kind:'flow' job routes through the SAME email-triggered queue, the SAME per-tenant token bucket, and the SAME pre-send gate as campaigns -- no forked dispatch path, no second rate limiter
result: pass
source: automated
coverage_id: 06-03-D2
verification: apps/worker/src/queues/__tests__/flow-send-idempotency.test.ts#T-06-03-02: the flow path consumes the SAME per-tenant token bucket key as campaign/test dispatch (no second limiter)

### 23. [06-03 D3] processSendJob resolves template + sender for a flow send from the pinned flow_versions.definition s…
expected: processSendJob resolves template + sender for a flow send from the pinned flow_versions.definition send-node config (not from a campaigns row)
result: pass
source: automated
coverage_id: 06-03-D3
verification: grep confirms flow-send.ts joins flow_runs.flow_version_id (never flows.live_version_id); npm run build -w apps/worker exits 0

### 24. [06-03 D4] D-05: a flow send blocked by the pre-send gate (suppressed/unsubscribed/frequency-capped) is recorde…
expected: D-05: a flow send blocked by the pre-send gate (suppressed/unsubscribed/frequency-capped) is recorded excluded in the ledger and skipped -- same disposition as broadcast; the gate is re-evaluated at EVERY dispatch so a contact re-subscribed mid-flow has its subsequent sends go out
result: pass
source: automated
coverage_id: 06-03-D4
verification: apps/worker/src/queues/__tests__/flow-send-idempotency.test.ts#T-06-03-03/D-05: a suppressed contact's flow send is recorded excluded and SendGrid is never called

### 25. [06-04 D1] A Member can create a flow and save its draft (nodes/edges + reentry + quiet-hours-override + exit-c…
expected: A Member can create a flow and save its draft (nodes/edges + reentry + quiet-hours-override + exit-conditions) via POST /flows + PATCH /flows/:id
result: pass
source: automated
coverage_id: 06-04-D1
verification: apps/api/src/modules/flows/__tests__/flow-lifecycle.test.ts#publish rejects an incomplete definition server-side (422 + fields) and succeeds once valid (D-17)

### 26. [06-04 D2] publishFlow re-runs validateFlowDefinition server-side inside the publish transaction and rejects th…
expected: publishFlow re-runs validateFlowDefinition server-side inside the publish transaction and rejects the D-17 hard errors with a 422 {fields} breakdown -- never trusts a client isValid flag
result: pass
source: automated
coverage_id: 06-04-D2
verification: apps/api/src/modules/flows/__tests__/flow-lifecycle.test.ts#publish rejects an incomplete definition server-side (422 + fields) and succeeds once valid (D-17)

### 27. [06-04 D3] Publish atomically snapshots the draft into an immutable flow_versions row (published_at stamped) an…
expected: Publish atomically snapshots the draft into an immutable flow_versions row (published_at stamped) and points flows.live_version_id at it; draft_version_id is cleared for D-20's lazy single-working-draft model
result: pass
source: automated
coverage_id: 06-04-D3
verification: apps/api/src/modules/flows/__tests__/flow-lifecycle.test.ts#pause/resume enforce legal transitions (live<->paused) and D-20 lazily recreates a draft on first post-publish edit

### 28. [06-04 D4] Publish/pause/resume are Owner/Admin-only (D-23); draft CRUD + duplicate remain Member-allowed
expected: Publish/pause/resume are Owner/Admin-only (D-23); draft CRUD + duplicate remain Member-allowed
result: pass
source: automated
coverage_id: 06-04-D4
verification: apps/api/src/modules/flows/__tests__/flow-lifecycle.test.ts#D-23: publish/pause/resume are Owner/Admin-only; draft CRUD + duplicate remain Member-allowed

### 29. [06-04 D5] Deleting a segment referenced by a flow trigger/branch/exit is blocked (409 conflict, code reference…
expected: Deleting a segment referenced by a flow trigger/branch/exit is blocked (409 conflict, code referenced_by_flow)
result: pass
source: automated
coverage_id: 06-04-D5
verification: apps/api/src/modules/flows/__tests__/flow-lifecycle.test.ts#D-24: a segment referenced by a flow trigger cannot be deleted

### 30. [06-05 D1] A waiting flow_run whose next_wake_at has elapsed is advanced by re-reading the run's current DB sta…
expected: A waiting flow_run whose next_wake_at has elapsed is advanced by re-reading the run's current DB state and resolving the next node against the run's PINNED flow_version_id (FLOW-07), never flows.live_version_id
result: pass
source: automated
coverage_id: 06-05-D1
verification: apps/worker/src/queues/__tests__/flow-run-advance.test.ts#a due send node enqueues exactly one kind:'flow' send job and advances current_node_id to the exit node

### 31. [06-05 D2] Exit conditions are evaluated at step boundaries BEFORE any send -- a satisfied condition marks the …
expected: Exit conditions are evaluated at step boundaries BEFORE any send -- a satisfied condition marks the run exited and no send job is ever enqueued (D-14)
result: pass
source: automated
coverage_id: 06-05-D2
verification: apps/worker/src/queues/__tests__/flow-run-advance.test.ts#D-14: an exit condition satisfied at the boundary exits the run and enqueues NO send job

### 32. [06-05 D3] A send node enqueues a kind:'flow' job onto the existing email-triggered queue and advances the run …
expected: A send node enqueues a kind:'flow' job onto the existing email-triggered queue and advances the run in the same wake cycle; an exit node marks the path terminal
result: pass
source: automated
coverage_id: 06-05-D3
verification: apps/worker/src/queues/__tests__/flow-run-advance.test.ts#a due send node enqueues exactly one kind:'flow' send job and advances current_node_id to the exit node

### 33. [06-05 D4] A durable reconciliation scan (repeatable tick, admin-scoped discovery + tenant-rescoped FOR UPDATE …
expected: A durable reconciliation scan (repeatable tick, admin-scoped discovery + tenant-rescoped FOR UPDATE SKIP LOCKED) catches any waiting run whose BullMQ wake nudge was lost
result: pass
source: automated
coverage_id: 06-05-D4
verification: grep confirms createFlowReconciliationWorker/createFlowRunAdvanceWorker both registered in apps/worker/src/server.ts; findDueFlowRunCandidates is SELECT-only under app.admin_scan (no FOR UPDATE); transitionAndNudge re-verifies FOR UPDATE OF fr SKIP LOCKED joined to flows.status<>'paused'

### 34. [06-05 D5] Pause freezes execution: the advance worker no-ops for a run whose flow is paused, and the reconcili…
expected: Pause freezes execution: the advance worker no-ops for a run whose flow is paused, and the reconciliation scan's per-tenant re-verification excludes paused flows; on resume, overdue runs execute on the very next tick (D-18/D-19)
result: pass
source: automated
coverage_id: 06-05-D5
verification: processFlowRunAdvance's guard `if (run.flowStatus === \"paused\") return;` leaves the run untouched (still waiting, unchanged next_wake_at); flow-reconciliation.worker.ts's transitionAndNudge re-verifies f.status<>'paused' in the SAME query on every tick, requiring no separate resume code path

### 35. [06-06 D1] An ingested event enqueues a flow-trigger-check job which matches live event-triggered flows by even…
expected: An ingested event enqueues a flow-trigger-check job which matches live event-triggered flows by event name and creates a version-pinned flow_run + enqueues an advance job
result: pass
source: automated
coverage_id: 06-06-D1
verification: apps/worker/src/queues/__tests__/flow-trigger-evaluator.test.ts#a live event-triggered flow + a matching event -> exactly one run pinned to live_version_id + an advance job enqueued

### 36. [06-06 D2] Re-entry control (once_ever / once_per_n_days / every_time) gates re-entry per FLOW-04/D-06, measure…
expected: Re-entry control (once_ever / once_per_n_days / every_time) gates re-entry per FLOW-04/D-06, measured from the contact's last entry
result: pass
source: automated
coverage_id: 06-06-D2
verification: apps/worker/src/queues/__tests__/flow-trigger-evaluator.test.ts#once_ever: a second matching event after the first run -> no new run

### 37. [06-06 D3] At most one active run exists per contact x flow -- a trigger firing while a run is active is ignore…
expected: At most one active run exists per contact x flow -- a trigger firing while a run is active is ignored (D-07), backed by the flow_runs_one_active_per_contact partial index
result: pass
source: automated
coverage_id: 06-06-D3
verification: apps/worker/src/queues/__tests__/flow-trigger-evaluator.test.ts#one-active-run: two concurrent matching events while a run is active -> exactly one active run

### 38. [06-07 D1] isValidIanaTimezone/resolveTimezone/isInsideQuietHours/nextQuietWindowEnd implemented with native In…
expected: isValidIanaTimezone/resolveTimezone/isInsideQuietHours/nextQuietWindowEnd implemented with native Intl only, covering a midnight-wrapping quiet window and a real IANA zone/fake zone allowlist check
result: pass
source: automated
coverage_id: 06-07-D1
verification: packages/delivery-core/src/__tests__/quiet-hours.test.ts (16 tests: isValidIanaTimezone, resolveTimezone, isInsideQuietHours incl. midnight-wrap + zero-width window, nextQuietWindowEnd incl. non-UTC zone)

### 39. [06-07 D2] computeNextWaitUntil resolves the next local time-of-day/day-of-week match, DST-correct across a rea…
expected: computeNextWaitUntil resolves the next local time-of-day/day-of-week match, DST-correct across a real spring-forward transition
result: pass
source: automated
coverage_id: 06-07-D2
verification: packages/flows-core/src/__tests__/wait-until.test.ts#DST spring-forward boundary (America/New_York, 2026-03-08): lands on the correct absolute instant when the wait crosses the spring-forward transition

### 40. [06-07 D3] A due delay node (fixed or wait_until) sets flow_runs.next_wake_at durably, advances current_node_id…
expected: A due delay node (fixed or wait_until) sets flow_runs.next_wake_at durably, advances current_node_id past the delay node, and enqueues a BullMQ delayed nudge -- no setTimeout
result: pass
source: automated
coverage_id: 06-07-D3
verification: apps/worker/src/queues/__tests__/flow-run-advance.test.ts#a due fixed-duration delay node sets a future next_wake_at, advances to the next node, and enqueues NO send

### 41. [06-07 D4] At dispatch time, a send node whose flow's effective quiet-hours window contains 'now' defers the se…
expected: At dispatch time, a send node whose flow's effective quiet-hours window contains 'now' defers the send (no send job enqueued), setting next_wake_at to the window end with no added jitter (D-10); resolved in the recipient's timezone (contact -> workspace default -> UTC)
result: pass
source: automated
coverage_id: 06-07-D4
verification: apps/worker/src/queues/__tests__/flow-run-advance.test.ts#a send node inside its flow's override quiet-hours window defers -- NO send job, next_wake_at = window end

### 42. [06-07 D5] contacts.timezone is validated against the IANA allowlist on every write path with a response cycle …
expected: contacts.timezone is validated against the IANA allowlist on every write path with a response cycle (API create/update, CSV import) and is a recognized standard field (not freeform properties); an invalid zone is rejected, never stored
result: pass
source: automated
coverage_id: 06-07-D5
verification: apps/api/src/modules/contacts/__tests__/contact-crud.test.ts (3 tests: valid timezone persists on create; invalid timezone rejected 400 on create; invalid timezone rejected 400 on update, existing value untouched)

### 43. [06-07 D6] Workspace default timezone + quiet-hours window (start/end/enabled) are settable and validated via P…
expected: Workspace default timezone + quiet-hours window (start/end/enabled) are settable and validated via PUT send-settings, alongside the pre-existing frequency-cap/rps fields
result: pass
source: automated
coverage_id: 06-07-D6
verification: apps/api/src/modules/campaigns/__tests__/send-settings.test.ts (3 tests: persists default_timezone + quiet_hours_start/end/enabled; rejects invalid IANA defaultTimezone with 400; frequency cap/rps unaffected)

### 44. [06-08 D1] A conditional branch node routes the contact down the yes or no edge based on isContactInSegment-sha…
expected: A conditional branch node routes the contact down the yes or no edge based on isContactInSegment-shaped point-check at the step boundary (binary, D-12/D-13)
result: pass
source: automated
coverage_id: 06-08-D1
verification: apps/worker/src/queues/__tests__/flow-segment-trigger.test.ts#a branch routes the 'yes' edge for a contact currently in the segment

### 45. [06-08 D2] A contact entering a trigger segment is detected via event-driven re-check after a contact change (D…
expected: A contact entering a trigger segment is detected via event-driven re-check after a contact change (D-02a)
result: pass
source: automated
coverage_id: 06-08-D2
verification: apps/worker/src/queues/__tests__/flow-segment-trigger.test.ts#D-02a: the event-driven flow-trigger-check job also enrolls a contact newly matching a segment-triggered flow

### 46. [06-08 D3] A contact entering a trigger segment is ALSO detected via a periodic bulk-diff sweep as the time-bas…
expected: A contact entering a trigger segment is ALSO detected via a periodic bulk-diff sweep as the time-based safety net (D-02b), and does not re-enroll an already-seen contact
result: pass
source: automated
coverage_id: 06-08-D3
verification: apps/worker/src/queues/__tests__/flow-segment-trigger.test.ts#the sweep enrolls a contact newly matching the trigger segment and records the snapshot

### 47. [06-08 D4] Publishing a segment-triggered flow can enroll current segment members (batch, respecting canEnterFl…
expected: Publishing a segment-triggered flow can enroll current segment members (batch, respecting canEnterFlow) or seed the snapshot only (future entrants only), D-04
result: pass
source: automated
coverage_id: 06-08-D4
verification: apps/worker/src/queues/__tests__/flow-segment-trigger.test.ts#enrollExisting=true creates a run for every current segment member

### 48. [06-08 D5] The sweep uses a bulk per-segment query diffed against the snapshot, not an O(flows x contacts) poin…
expected: The sweep uses a bulk per-segment query diffed against the snapshot, not an O(flows x contacts) point-check loop
result: pass
source: automated
coverage_id: 06-08-D5
verification: grep confirms flow-segment-sweep.worker.ts issues ONE compileSegmentDefinition-derived bulk contacts query per flow, diffed in-process against flow_segment_membership_snapshot; no isContactInSegment-shaped per-contact loop present

### 49. [06-09 D1] GET /flows/:id/runs reports active-run count and how many of those are pinned to a non-live version …
expected: GET /flows/:id/runs reports active-run count and how many of those are pinned to a non-live version ('N in flow (M on old versions)', D-21/FLOW-07)
result: pass
source: automated
coverage_id: 06-09-D1
verification: apps/api/src/modules/flows/__tests__/flow-run-management.test.ts#D-21: run counts + list surface active runs and how many are on old (non-live) versions

### 50. [06-09 D2] Eject (single via runIds, bulk via contactIds) marks matching active runs 'ejected' without ever re-…
expected: Eject (single via runIds, bulk via contactIds) marks matching active runs 'ejected' without ever re-pointing flow_version_id, and is Owner/Admin-gated (D-21/D-23/FLOW-07)
result: pass
source: automated
coverage_id: 06-09-D2
verification: apps/api/src/modules/flows/__tests__/flow-run-management.test.ts#D-21/D-23: eject (single via runIds, bulk via contactIds) marks matching active runs 'ejected' and is Owner/Admin-gated

### 51. [06-09 D3] A flow is deletable only if never-published or paused with zero active runs; deleting otherwise is b…
expected: A flow is deletable only if never-published or paused with zero active runs; deleting otherwise is blocked with 409, and delete is Owner/Admin-gated (D-22/D-23)
result: pass
source: automated
coverage_id: 06-09-D3
verification: apps/api/src/modules/flows/__tests__/flow-run-management.test.ts#D-22/D-23: delete is blocked for a live flow, blocked for paused-with-active-runs, and Owner/Admin-gated

### 52. [06-12 D1] flowRunAdvanceQueue never retains a completed/failed job under an id that can shadow a future wake f…
expected: flowRunAdvanceQueue never retains a completed/failed job under an id that can shadow a future wake for the same run (CR-01 closed)
result: pass
source: automated
coverage_id: 06-12-D1
verification: apps/worker/src/queues/__tests__/flow-run-advance-integration.test.ts#Scenario B (2+ delay chain)

### 53. [06-12 D2] Every non-terminal send-node and branch-node transition enqueues a forward advance nudge (WR-08 clos…
expected: Every non-terminal send-node and branch-node transition enqueues a forward advance nudge (WR-08 closed)
result: pass
source: automated
coverage_id: 06-12-D2
verification: apps/worker/src/queues/__tests__/flow-run-advance-integration.test.ts#Scenario A (automatic send chain)

### 54. [06-12 D3] A real BullMQ Queue/Worker pair advances a multi-step flow run (2+ non-trigger steps) through every …
expected: A real BullMQ Queue/Worker pair advances a multi-step flow run (2+ non-trigger steps) through every step to a terminal state
result: pass
source: automated
coverage_id: 06-12-D3
verification: apps/worker/src/queues/__tests__/flow-run-advance-integration.test.ts

### 55. [06-13 D1] A flow saved with quiet_hours_mode 'custom' (the exact value the API/UI persist) defers sends inside…
expected: A flow saved with quiet_hours_mode 'custom' (the exact value the API/UI persist) defers sends inside its configured window -- closes CR-02 / roadmap success criterion 3
result: pass
source: automated
coverage_id: 06-13-D1
verification: apps/worker/src/queues/__tests__/flow-run-advance.test.ts#06-07/06-13/D-08/D-14/Pitfall 4/CR-02: a send node inside its flow's custom quiet-hours window defers -- NO send job, next_wake_at = window end

### 56. [06-13 D2] quiet_hours_mode 'workspace_default' (with the workspace default disabled) does NOT defer -- only 'c…
expected: quiet_hours_mode 'workspace_default' (with the workspace default disabled) does NOT defer -- only 'custom' engages a flow's own window, proving the fix is value-specific
result: pass
source: automated
coverage_id: 06-13-D2
verification: apps/worker/src/queues/__tests__/flow-run-advance.test.ts#06-13/CR-02 regression: quiet_hours_mode 'workspace_default' with the workspace default disabled does NOT defer

### 57. [06-13 D3] flows.quiet_hours_mode DB default corrected to 'workspace_default'; migration 0034 data-migrates any…
expected: flows.quiet_hours_mode DB default corrected to 'workspace_default'; migration 0034 data-migrates any stray legacy rows (inherit->workspace_default, override->custom)
result: pass
source: automated
coverage_id: 06-13-D3
verification: drizzle-kit migrate exit 0 against local dev DB; information_schema.columns.column_default = 'workspace_default'::text (verified via psql)

### 58. [06-14 D1] Editing a live/paused flow's draft trigger does NOT change flows.trigger_type/trigger_event_name/tri…
expected: Editing a live/paused flow's draft trigger does NOT change flows.trigger_type/trigger_event_name/trigger_segment_id before publish (CR-03 closed)
result: pass
source: automated
coverage_id: 06-14-D1
verification: apps/api/src/modules/flows/__tests__/flow-lifecycle.test.ts#CR-03: a live flow's unpublished draft trigger edit does not change trigger_* until re-published

### 59. [06-14 D2] publishFlow re-derives the trigger columns from the version being published, so publishing is the ON…
expected: publishFlow re-derives the trigger columns from the version being published, so publishing is the ONLY action that changes live enrollment targeting
result: pass
source: automated
coverage_id: 06-14-D2
verification: apps/api/src/modules/flows/__tests__/flow-lifecycle.test.ts#CR-03 test's second-publish assertion (triggerEventName becomes 'signup' only after re-publish)

### 60. [06-15 D1] A contact with a stored timezone differing from the workspace default has its custom quiet-hours win…
expected: A contact with a stored timezone differing from the workspace default has its custom quiet-hours window evaluated in the CONTACT's timezone -- a send inside the contact's local quiet window defers (outcome deferred_quiet_hours), never enqueued
result: pass
source: automated
coverage_id: 06-15-D1
verification: apps/worker/src/queues/__tests__/flow-run-advance.test.ts#06-15/D-08/FLOW-05: a custom quiet-hours window is evaluated in the CONTACT's timezone -- a send inside the contact's local window defers even when the workspace default timezone places now outside it

### 61. [06-15 D2] A wait_until delay computes next_wake_at at the configured local time-of-day in the CONTACT's timezo…
expected: A wait_until delay computes next_wake_at at the configured local time-of-day in the CONTACT's timezone, not the workspace default timezone
result: pass
source: automated
coverage_id: 06-15-D2
verification: apps/worker/src/queues/__tests__/flow-run-advance.test.ts#06-15/D-08/FLOW-05: a wait_until delay computes next_wake_at at the contact's local time-of-day, not the workspace default timezone

### 62. [06-16 D1] publishFlow keeps a paused flow paused when publishing accumulated draft changes (does not silently …
expected: publishFlow keeps a paused flow paused when publishing accumulated draft changes (does not silently resume enrollment/sends)
result: pass
source: automated
coverage_id: 06-16-D1
verification: apps/api/src/modules/flows/__tests__/flow-lifecycle.test.ts#06-16/WR-04/D-18: publishing accumulated draft changes on a paused flow keeps it paused (does not silently resume)

### 63. [06-16 D2] Publishing a DRAFT flow or a LIVE flow still results in status 'live' (no regression to existing pub…
expected: Publishing a DRAFT flow or a LIVE flow still results in status 'live' (no regression to existing publish paths)
result: pass
source: automated
coverage_id: 06-16-D2
verification: apps/api/src/modules/flows/__tests__/flow-lifecycle.test.ts#publish rejects an incomplete definition server-side (422 + fields) and succeeds once valid (D-17)

### 64. [06-17 D1] A graph cycle reachable from the trigger (trigger->send-A->send-B->send-A) is rejected at publish vi…
expected: A graph cycle reachable from the trigger (trigger->send-A->send-B->send-A) is rejected at publish via a new cycle_detected validation error
result: pass
source: automated
coverage_id: 06-17-D1
verification: packages/flows-core/src/__tests__/flow-validate.test.ts#06-17/CR-01: a cycle reachable from the trigger returns cycle_detected

### 65. [06-17 D2] A trigger with no outgoing edge is rejected at publish via a new no_entry validation error
expected: A trigger with no outgoing edge is rejected at publish via a new no_entry validation error
result: pass
source: automated
coverage_id: 06-17-D2
verification: packages/flows-core/src/__tests__/flow-validate.test.ts#06-17/WR-02: a trigger with no outgoing edge returns no_entry

### 66. [06-17 D3] A run whose flow_run_steps count has already reached MAX_STEPS_PER_RUN is force-exited (status exite…
expected: A run whose flow_run_steps count has already reached MAX_STEPS_PER_RUN is force-exited (status exited, exit_reason step_budget_exceeded) before any further node dispatch, with no new step appended and no send enqueued
result: pass
source: automated
coverage_id: 06-17-D3
verification: apps/worker/src/queues/__tests__/flow-run-advance.test.ts#06-17/CR-01: a run at the step budget is terminated (exited/step_budget_exceeded) with no further dispatch

### 67. [06-17 D4] The three pre-existing hard-error checks (no_trigger, empty_send, branch_missing_exit) and the orpha…
expected: The three pre-existing hard-error checks (no_trigger, empty_send, branch_missing_exit) and the orphan/dead-node-is-valid contract (D-17) are unchanged
result: pass
source: automated
coverage_id: 06-17-D4
verification: packages/flows-core/src/__tests__/flow-validate.test.ts (full suite, 10/10 passing)

### 68. [06-18 D1] Publishing a segment-triggered flow with enrollExisting=false seeds flow_segment_membership_snapshot…
expected: Publishing a segment-triggered flow with enrollExisting=false seeds flow_segment_membership_snapshot for every current member atomically inside publishFlow's own transaction, with zero flow_runs rows created
result: pass
source: automated
coverage_id: 06-18-D1
verification: apps/api/src/modules/flows/__tests__/flow-enroll-atomic.test.ts#06-18/CR-02: publishing a segment-triggered flow with enrollExisting=false seeds the snapshot atomically (zero runs, all members seen, synchronously)

### 69. [06-18 D2] Publish route only enqueues the async flowEnrollExistingQueue job for the enrollExisting=true back-f…
expected: Publish route only enqueues the async flowEnrollExistingQueue job for the enrollExisting=true back-fill case; event-triggered publish and the enrollExisting=true path are unaffected
result: pass
source: automated
coverage_id: 06-18-D2
verification: apps/api/src/modules/flows/__tests__/flow-lifecycle.test.ts

### 70. [06-19 D1] sweepOneFlow deletes a contact's flow_segment_membership_snapshot row when the sweep observes the co…
expected: sweepOneFlow deletes a contact's flow_segment_membership_snapshot row when the sweep observes the contact no longer matches the trigger segment
result: pass
source: automated
coverage_id: 06-19-D1
verification: apps/worker/src/queues/__tests__/flow-segment-trigger.test.ts#06-19/WR-04/FLOW-04: a contact who leaves the trigger segment (sweep-detected) and rejoins re-enters when reentry_mode is every_time, and stays blocked for once_ever

### 71. [06-19 D2] A leave->rejoin re-enters a segment-triggered flow when reentry_mode is every_time (a NEW flow_run i…
expected: A leave->rejoin re-enters a segment-triggered flow when reentry_mode is every_time (a NEW flow_run is created), because canEnterFlow is reachable again after the stale snapshot is cleared
result: pass
source: automated
coverage_id: 06-19-D2
verification: apps/worker/src/queues/__tests__/flow-segment-trigger.test.ts#06-19/WR-04/FLOW-04: ... (every_time sub-scenario, step 7: 2 runs)

### 72. [06-19 D3] Re-entry stays correctly BLOCKED for reentry_mode once_ever even after a leave/rejoin -- canEnterFlo…
expected: Re-entry stays correctly BLOCKED for reentry_mode once_ever even after a leave/rejoin -- canEnterFlow denies because a prior run exists, proving the fix does not bypass canEnterFlow's authority
result: pass
source: automated
coverage_id: 06-19-D3
verification: apps/worker/src/queues/__tests__/flow-segment-trigger.test.ts#06-19/WR-04/FLOW-04: ... (once_ever sub-scenario: still 1 run)

### 73. [06-19 D4] A contact who never left the segment is not re-enrolled by the sweep -- the still-matching snapshot …
expected: A contact who never left the segment is not re-enrolled by the sweep -- the still-matching snapshot row is preserved (no regression)
result: pass
source: automated
coverage_id: 06-19-D4
verification: apps/worker/src/queues/__tests__/flow-segment-trigger.test.ts#the sweep does NOT re-enroll a contact already recorded in the membership snapshot

### 74. [06-20 D1] deleteSegment throws SegmentConflictError (code referenced_by_campaign), not a raw postgres 25P02, w…
expected: deleteSegment throws SegmentConflictError (code referenced_by_campaign), not a raw postgres 25P02, when a segment is referenced only by a CANCELED campaign
result: pass
source: automated
coverage_id: 06-20-D1
verification: apps/api/src/modules/segments/__tests__/segment-delete-conflict.test.ts#06-20/WR-01: deleting a segment referenced by a canceled campaign throws SegmentConflictError (referenced_by_campaign), not a raw 25P02

### 75. [06-20 D2] D-24's flow-vs-campaign disambiguation and the non-canceled-campaign/referencing-flow pre-check path…
expected: D-24's flow-vs-campaign disambiguation and the non-canceled-campaign/referencing-flow pre-check paths remain unchanged after the SAVEPOINT fix
result: pass
source: automated
coverage_id: 06-20-D2
verification: apps/api/src/modules/flows/__tests__/flow-lifecycle.test.ts#D-24: a segment referenced by a flow trigger cannot be deleted

### 76. [06-21 D1] deriveAutosaveState pure function returns saving/error/idle correctly, including the WR-05 bug case …
expected: deriveAutosaveState pure function returns saving/error/idle correctly, including the WR-05 bug case (isPending:false, isError:true, dirty:true -> error, not idle)
result: pass
source: automated
coverage_id: 06-21-D1
verification: apps/web/src/features/flows/canvas/__tests__/autosaveState.test.ts#06-21/WR-05 deriveAutosaveState

## Summary

total: 13
passed: 11
issues: 0
pending: 2
skipped: 0
blocked: 0
auto_covered: 63

## Coverage Block Errors

Malformed coverage blocks detected by uat.classify-coverage (entries kept as human checkpoints — fail-safe, nothing dropped):

- 06-10-SUMMARY.md: invalid verification kinds ("build", "human"), invalid status ("needs-uat"), D1 missing rationale
- 06-11-SUMMARY.md: invalid verification kinds ("build", "human"), D1–D4 missing rationale
- 06-14-SUMMARY.md: D3 invalid kind ("manual"), missing rationale
- 06-15-SUMMARY.md: D3 invalid kind ("static")

## Gaps

- truth: "The contact form, CSV column mapping, and workspace send settings expose a constrained IANA timezone dropdown (combobox) for selecting a timezone"
  status: resolved
  resolution: "Fix landed 2026-07-13 (round 4): 06-22 added the server-side csv_imports.default_timezone contract (migration 0035, validated fill-only-missing in applyCsvRowMapping, dry-run→apply agreement); 06-23 rendered the TimezoneCombobox («Часовой пояс по умолчанию») in CsvImportWizard's mapping step. Human re-test pending — see Test 10."
  reason: "User reported: выпадающий список со списком часовых поясов отсутствует"
  severity: major
  test: 10
  root_cause: "Claim-vs-implementation gap on the CSV column-mapping surface: CsvImportWizard.tsx never renders a TimezoneCombobox — it only offers a timezone target-field option in the column-mapping Select (line 44) plus header auto-guesses. 06-11-SUMMARY overstated the claim (combobox wired into CSV mapping); verification was grep-only, never render-level. SendSettingsPage.tsx:177 and ContactForm.tsx:391 DO render the combobox unconditionally."
  artifacts:
    - path: "apps/web/src/features/contacts/CsvImportWizard.tsx"
      issue: "no timezone combobox on the mapping surface, despite the UAT truth/06-11 claim promising one"
    - path: ".planning/phases/06-flows-triggered-chains/06-11-SUMMARY.md"
      issue: "key claim overstates what shipped (wired into … CSV mapping)"
  missing:
    - "Wire the constrained timezone UI into the CSV mapping step (e.g. a default-timezone-for-rows-without-one control), OR realign the contract to server-side per-row IANA validation at dry-run (csv-mapping.ts:101) surfaced in the dry-run error report, and re-verify Test 10 on settings/sending + contact form where the combobox exists"
    - "Consider a jsdom component test lane so combobox rendering is verified, not just grepped"
  debug_session: ".planning/debug/timezone-combobox-missing.md"

- truth: "On a failed draft autosave the canvas toolbar shows an honest error/retrying state (not a stuck «Сохранение…» and not «Сохранено»), and the automatic retry re-fires the PATCH once connectivity is restored"
  status: resolved
  resolution: "Fix landed 2026-07-13 (round 4): 06-24 threads mutation.isPaused into deriveAutosaveState — isPending && isPaused maps to the error state (checked before plain isPending), so an offline-paused mutation shows «Не сохранено — повтор…»; reconnect auto-resume is TanStack's built-in paused-mutation resume. RED→GREEN test coverage added (6/6). Human re-test pending — see Test 11."
  reason: "User reported: ошибка не показывается. Просто висит статус «Сохранение...»"
  severity: major
  test: 11
  root_cause: "TanStack Query v5 default networkMode:'online' pauses the autosave mutation while offline — the PATCH mutationFn is never invoked, the mutation sits at isPending:true/isPaused:true/isError:false forever. deriveAutosaveState (useAutosaveDraft.ts:74-86) does not model isPaused, so isPending wins and the toolbar renders «Сохранение…» indefinitely. WR-05's unit test only covered settled errors (online 4xx/5xx) — an input shape that never occurs during an offline pause. Secondary: with API stopped but browser online the error briefly shows, but the 4s retry re-fires mutate() and any offline transition re-pauses it."
  artifacts:
    - path: "apps/web/src/features/flows/canvas/useAutosaveDraft.ts"
      issue: "deriveAutosaveState has no isPaused input; line 170 never reads mutation.isPaused — offline-paused mutation maps to saving instead of honest error/retrying"
    - path: "apps/web/src/lib/queryClient.ts"
      issue: "no networkMode override — TanStack default online governs mutations (contributing config)"
    - path: "apps/web/src/features/flows/canvas/__tests__/autosaveState.test.ts"
      issue: "test gap — no case for the paused-offline input shape"
  missing:
    - "Feed mutation.isPaused into deriveAutosaveState and map paused-with-unsaved-changes to the honest error/retrying state (TanStack auto-resumes paused mutations on reconnect), OR set networkMode:'always' on useUpdateFlowDraft so offline fetches settle to isError and the existing 4s bounded retry owns reconnection"
    - "Extend autosaveState.test.ts with the paused input shape"
  debug_session: ".planning/debug/autosave-error-state-stuck.md"
