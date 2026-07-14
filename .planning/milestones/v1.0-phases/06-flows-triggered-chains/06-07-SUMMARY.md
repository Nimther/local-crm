---
phase: 06-flows-triggered-chains
plan: 07
subsystem: worker
tags: [intl, timezone, quiet-hours, bullmq, postgres, flows]

# Dependency graph
requires:
  - phase: 06-flows-triggered-chains (06-01)
    provides: flow_runs.next_wake_at, flows.quiet_hours_mode/start/end, workspace_send_settings.default_timezone/quiet_hours_*, contacts.timezone (migrations 0026/0029/0030)
  - phase: 06-flows-triggered-chains (06-02)
    provides: flowDelayNodeSchema (fixed | wait_until), FLOW_RUN_ADVANCE_QUEUE, flowRunAdvanceJobSchema
  - phase: 06-flows-triggered-chains (06-05)
    provides: flow-run-advance.worker.ts's node-type dispatch seam, handlers/send-node.ts's handleSendNode contract, flow-queues.ts's flowRunAdvanceQueue producer
provides:
  - "packages/delivery-core/src/quiet-hours.ts -- isValidIanaTimezone/resolveTimezone/isInsideQuietHours/nextQuietWindowEnd, native Intl, DST-correct"
  - "packages/flows-core/src/wait-until.ts -- pure computeNextWaitUntil(now, timeOfDay, dayOfWeek?, timezone), native Intl, DST-correct"
  - "apps/worker/src/queues/flows/handlers/delay-node.ts -- handleDelayNode: durable next_wake_at for fixed + wait_until delay kinds"
  - "handlers/send-node.ts's handleSendNode extended with a dispatch-time quiet-hours gate (inherit/override/disabled)"
  - "contacts.timezone + workspace_send_settings.default_timezone/quiet_hours_* validated and settable end-to-end (API create/update, CSV import, workspace send-settings PUT)"
affects: [06-08, 06-09, 06-11]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Zone-aware date math via native Intl.DateTimeFormat.formatToParts + a two-pass offset-correction zonedTimeToUtc helper (guess -> re-derive offset at the corrected instant -> re-derive once more) -- the standard technique for converting a local wall-clock Y/M/D H:M in an IANA zone to an absolute UTC instant that stays correct across a DST transition. Implemented independently (duplicated, not shared) in quiet-hours.ts and wait-until.ts since flows-core has no dependency path to delivery-core."
    - "Handler-owns-the-enqueue, caller-owns-the-DB-write: handleDelayNode and handleSendNode's quiet-hours-deferral branch both enqueue their own BullMQ delayed nudge (jobId: flowRunId, same dedup key flow-reconciliation.worker.ts's backstop nudge uses) and return only the computed next_wake_at/nextNodeId -- flow-run-advance.worker.ts performs the actual flow_runs UPDATE + flow_run_steps append in the ONE transaction it already holds, mirroring 06-05's handleSendNode/handleExitNode asymmetric-responsibility precedent."
    - "Server-only IANA validation split from browser-bundled schemas: apps/api and packages/contacts-core (both Node-only) depend directly on @mega-crm/delivery-core's isValidIanaTimezone; packages/shared-schemas (bundled into apps/web via Vite) deliberately does NOT gain a delivery-core dependency -- its timezone/defaultTimezone zod fields are format-only (non-empty string), with the actual Intl.supportedValuesOf allowlist check running server-side only."

key-files:
  created:
    - packages/delivery-core/src/quiet-hours.ts
    - packages/delivery-core/src/__tests__/quiet-hours.test.ts
    - packages/flows-core/src/wait-until.ts
    - packages/flows-core/src/__tests__/wait-until.test.ts
    - apps/worker/src/queues/flows/handlers/delay-node.ts
    - apps/api/src/modules/campaigns/__tests__/send-settings.test.ts
  modified:
    - apps/worker/src/queues/flows/handlers/send-node.ts
    - apps/worker/src/queues/flows/flow-run-advance.worker.ts
    - packages/delivery-core/src/send-settings.ts
    - packages/delivery-core/src/index.ts
    - packages/delivery-core/src/__tests__/pre-send-gate.test.ts
    - packages/flows-core/src/index.ts
    - packages/contacts-core/src/contact-repository.ts
    - packages/contacts-core/src/csv-mapping.ts
    - packages/contacts-core/package.json
    - apps/api/src/modules/contacts/contact.repository.ts
    - apps/api/src/modules/contacts/contacts.routes.ts
    - apps/api/src/modules/contacts/__tests__/contact-crud.test.ts
    - apps/api/src/modules/contacts/__tests__/csv-import.test.ts
    - apps/api/src/modules/campaigns/send-settings.routes.ts
    - packages/shared-schemas/src/campaign.ts
    - packages/shared-schemas/src/contact.ts
    - apps/worker/src/queues/__tests__/flow-run-advance.test.ts

key-decisions:
  - "Contact/workspace timezone stored as opaque text in packages/contacts-core (mirrors city/country's zero-validation pass-through) -- IANA-allowlist validation is enforced ONLY at the two write choke points with a response cycle: the session-authed contact API (apps/api's contact.repository.ts) and CSV import (contacts-core's applyCsvRowMapping, the single mapper both dry-run and apply call)."
  - "packages/shared-schemas gained NO dependency on @mega-crm/delivery-core -- shared-schemas is bundled into apps/web via Vite, and delivery-core is Node-only (pg/KMS/SendGrid transitively). Both createContactSchema/updateContactSchema's timezone field and workspaceSendSettingsSchema's defaultTimezone are format-only in the zod schema; the real Intl.supportedValuesOf('timeZone') check runs server-side in apps/api's route/repository layer."
  - "packages/contacts-core DID gain a new @mega-crm/delivery-core dependency (for isValidIanaTimezone in csv-mapping.ts) -- safe because contacts-core is never bundled into apps/web (only apps/api and apps/worker depend on it), unlike shared-schemas."
  - "Both handleDelayNode and handleSendNode's quiet-hours deferral enqueue their own BullMQ delayed nudge with jobId: flowRunId -- the SAME deterministic key flow-reconciliation.worker.ts's 60s backstop uses (06-05), so a redelivered/duplicate nudge from any of the three sources (delay handler, quiet-hours deferral, reconciliation scan) can never stack more than one pending advance job for a run."
  - "A flow's quiet-hours window resolution order is disabled -> override (flow's own start/end) -> inherit (workspace default, gated on workspace_send_settings.quiet_hours_enabled); a null start/end at any resolved level defensively no-gates rather than throwing."

requirements-completed: [FLOW-05, FLOW-01]

coverage:
  - id: D1
    description: "isValidIanaTimezone/resolveTimezone/isInsideQuietHours/nextQuietWindowEnd implemented with native Intl only, covering a midnight-wrapping quiet window and a real IANA zone/fake zone allowlist check"
    requirement: "FLOW-05"
    verification:
      - kind: unit
        ref: "packages/delivery-core/src/__tests__/quiet-hours.test.ts (16 tests: isValidIanaTimezone, resolveTimezone, isInsideQuietHours incl. midnight-wrap + zero-width window, nextQuietWindowEnd incl. non-UTC zone)"
        status: pass
    human_judgment: false
  - id: D2
    description: "computeNextWaitUntil resolves the next local time-of-day/day-of-week match, DST-correct across a real spring-forward transition"
    requirement: "FLOW-05"
    verification:
      - kind: unit
        ref: "packages/flows-core/src/__tests__/wait-until.test.ts#DST spring-forward boundary (America/New_York, 2026-03-08): lands on the correct absolute instant when the wait crosses the spring-forward transition"
        status: pass
    human_judgment: false
  - id: D3
    description: "A due delay node (fixed or wait_until) sets flow_runs.next_wake_at durably, advances current_node_id past the delay node, and enqueues a BullMQ delayed nudge -- no setTimeout"
    requirement: "FLOW-05"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/flow-run-advance.test.ts#a due fixed-duration delay node sets a future next_wake_at, advances to the next node, and enqueues NO send"
        status: pass
    human_judgment: false
  - id: D4
    description: "At dispatch time, a send node whose flow's effective quiet-hours window contains 'now' defers the send (no send job enqueued), setting next_wake_at to the window end with no added jitter (D-10); resolved in the recipient's timezone (contact -> workspace default -> UTC)"
    requirement: "FLOW-01"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/flow-run-advance.test.ts#a send node inside its flow's override quiet-hours window defers -- NO send job, next_wake_at = window end"
        status: pass
    human_judgment: false
  - id: D5
    description: "contacts.timezone is validated against the IANA allowlist on every write path with a response cycle (API create/update, CSV import) and is a recognized standard field (not freeform properties); an invalid zone is rejected, never stored"
    requirement: "FLOW-01"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/contacts/__tests__/contact-crud.test.ts (3 tests: valid timezone persists on create; invalid timezone rejected 400 on create; invalid timezone rejected 400 on update, existing value untouched)"
        status: pass
      - kind: unit
        ref: "apps/api/src/modules/contacts/__tests__/csv-import.test.ts#applyCsvRowMapping timezone standard-field validation (06-07): valid zone maps to the standard field not properties; invalid zone rejected"
        status: pass
    human_judgment: false
  - id: D6
    description: "Workspace default timezone + quiet-hours window (start/end/enabled) are settable and validated via PUT send-settings, alongside the pre-existing frequency-cap/rps fields"
    requirement: "FLOW-05"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/campaigns/__tests__/send-settings.test.ts (3 tests: persists default_timezone + quiet_hours_start/end/enabled; rejects invalid IANA defaultTimezone with 400; frequency cap/rps unaffected)"
        status: pass
    human_judgment: false

duration: 32min
completed: 2026-07-10
status: complete
---

# Phase 6 Plan 7: Delay/quiet-hours engine + timezone write-validation Summary

**Delay nodes get a durable Postgres-timer wake (fixed duration or DST-correct wait-until, native Intl only) and every flow send is gated at DISPATCH time against the recipient's quiet-hours window -- resolved contact-timezone-first, workspace-default-second, UTC-last -- with contact/workspace timezone now validated end-to-end (API, CSV import, workspace settings).**

## Performance

- **Duration:** ~32 min
- **Started:** 2026-07-10T10:31:00+05:00
- **Completed:** 2026-07-10T10:47:09+05:00
- **Tasks:** 3
- **Files modified:** 24 (7 created, 17 modified)

## Accomplishments

- `packages/delivery-core/src/quiet-hours.ts`: `isValidIanaTimezone` (`Intl.supportedValuesOf('timeZone')` set membership + defensive `try/catch` fallback), `resolveTimezone` (contact -> workspace default -> `'UTC'`), `isInsideQuietHours` (midnight-wrap aware, zero-width-window-safe), `nextQuietWindowEnd`. All zone-aware math goes through a shared internal `zonedTimeToUtc` helper using `Intl.DateTimeFormat.formatToParts` + a two-pass offset correction, DST-correct by construction.
- `packages/flows-core/src/wait-until.ts`: pure `computeNextWaitUntil(now, timeOfDayMinutes, dayOfWeek?, timezone)` -- walks forward day-by-day (bounded to 8 days) to the next matching local time-of-day/weekday, using the same DST-correct zone-math technique (independently implemented, no cross-package dependency).
- `apps/worker/src/queues/flows/handlers/delay-node.ts`: `handleDelayNode` computes `next_wake_at` for both delay kinds (`fixed`: now + amount·unit; `wait_until`: `computeNextWaitUntil` resolved in the contact's timezone falling back to the workspace default) and enqueues a BullMQ delayed nudge (`jobId: flowRunId`, `delay: max(0, nextWakeAt - now)`) onto `FLOW_RUN_ADVANCE_QUEUE` -- no `setTimeout` anywhere, Postgres's `next_wake_at` column remains the durable timer of record, the 06-05 reconciliation scan the backstop.
- `handlers/send-node.ts`'s `handleSendNode` extended with a dispatch-time quiet-hours gate: resolves the flow's effective window (`disabled` -> none; `override` -> the flow's own start/end; `inherit` -> the workspace default, gated on `quiet_hours_enabled`), checks `isInsideQuietHours` against the CURRENT instant (never the instant a prior delay was scheduled, Pitfall 4/D-14), and on a hit DEFERS -- no send job is ever enqueued, `next_wake_at` is set to `nextQuietWindowEnd` with **no jitter/stagger added** (D-10; the deferred burst that releases together at the window end is smoothed only by the existing per-tenant token bucket + triggered lane). A corrupted/invalid stored contact timezone is defensively caught and falls back to UTC (T-06-07-01) rather than crashing the worker.
- `flow-run-advance.worker.ts` now dispatches a third node type (`delay`, alongside 06-05's `send`/`exit`) and handles `handleSendNode`'s new `deferred_quiet_hours` outcome.
- Contact/workspace timezone write-validation, end to end: `contacts.timezone` is a recognized standard field (mirrors `city`/`country`) in `packages/contacts-core`'s shared upsert/CSV-mapping AND in `apps/api`'s session-authed contact API -- an invalid IANA zone is rejected with 400 (new `ContactValidationError`, distinct from the existing 409 `ContactConflictError`) at every write path that has a response cycle (create/update API, CSV dry-run/apply). Workspace `default_timezone`/`quiet_hours_start`/`quiet_hours_end`/`quiet_hours_enabled` are now settable via the existing PUT send-settings route, with the same IANA-allowlist validation applied server-side.
- `packages/delivery-core`'s `WorkspaceSendSettings`/`getWorkspaceSendSettings`/`upsertWorkspaceSendSettings` extended with the four new fields (read/write) -- the single source both the delay/send handlers (read) and the send-settings route (read+write) share.
- New integration tests (real Postgres/Redis, `apps/worker`): a due fixed-duration delay node advances the run and enqueues a durable nudge with no send job; a send node inside its flow's override quiet-hours window (dynamically centered on the actual current wall clock, never time-of-day flaky) defers with no send job and a delayed advance nudge for the window end.

## Task Commits

Each task was committed atomically:

1. **Task 1: quiet-hours util (Intl-based) + pure wait-until computation** - `d193ed7` (test)
2. **Task 2: Delay-node handler + dispatch-time quiet-hours gate in send handler** - `39d661b` (feat)
3. **Task 3: Timezone write-validation + workspace default timezone & quiet hours settings API** - `7252a83` (feat)

Additional commits (Rule 1 cleanup + strengthened coverage, both scoped to this plan's own changes):
4. **Drop unused `FlowNode` re-export from send-node.ts** - `a6e37b5` (refactor)
5. **Integration coverage for delay-node advance + quiet-hours deferral** - `fd63493` (test)

**Plan metadata:** pending (docs: complete plan)

## Files Created/Modified

- `packages/delivery-core/src/quiet-hours.ts` - isValidIanaTimezone/resolveTimezone/isInsideQuietHours/nextQuietWindowEnd
- `packages/delivery-core/src/__tests__/quiet-hours.test.ts` - 16 unit tests incl. midnight-wrap + non-UTC zone
- `packages/flows-core/src/wait-until.ts` - pure computeNextWaitUntil
- `packages/flows-core/src/__tests__/wait-until.test.ts` - 5 unit tests incl. DST spring-forward boundary
- `apps/worker/src/queues/flows/handlers/delay-node.ts` - handleDelayNode (new file)
- `apps/worker/src/queues/flows/handlers/send-node.ts` - handleSendNode extended with the quiet-hours gate
- `apps/worker/src/queues/flows/flow-run-advance.worker.ts` - dispatches the new "delay" node type; handles deferred_quiet_hours
- `packages/delivery-core/src/send-settings.ts` - WorkspaceSendSettings extended with defaultTimezone/quietHoursStart/quietHoursEnd/quietHoursEnabled
- `packages/delivery-core/src/index.ts` / `packages/flows-core/src/index.ts` - new barrel exports
- `packages/delivery-core/src/__tests__/pre-send-gate.test.ts` - updated defaults assertion (Rule 1, broken by the interface extension)
- `packages/contacts-core/src/contact-repository.ts` / `csv-mapping.ts` / `package.json` - timezone standard field + IANA validation in CSV mapping; new @mega-crm/delivery-core dependency
- `apps/api/src/modules/contacts/contact.repository.ts` / `contacts.routes.ts` - ContactValidationError (400) + timezone persist/response
- `apps/api/src/modules/contacts/__tests__/contact-crud.test.ts` / `csv-import.test.ts` - new timezone validation tests
- `apps/api/src/modules/campaigns/send-settings.routes.ts` - PUT route validates + persists the new workspace fields
- `apps/api/src/modules/campaigns/__tests__/send-settings.test.ts` - new test file (3 tests)
- `packages/shared-schemas/src/campaign.ts` / `contact.ts` - format-only timezone/quiet-hours zod fields (no delivery-core dependency)
- `apps/worker/src/queues/__tests__/flow-run-advance.test.ts` - 2 new integration tests + a delay-flow fixture

## Decisions Made

- Contact/workspace timezone stored as opaque text in the shared `contacts-core` upsert path (mirrors `city`/`country`'s zero-validation pass-through); IANA-allowlist validation is enforced only at the two write choke points with a response cycle (session-authed API, CSV import) -- the unattended event-ingestion path never sets `timezone` today (no standard-field extraction from event properties exists), so no additional validation surface was needed there.
- `packages/shared-schemas` deliberately did NOT gain a dependency on `@mega-crm/delivery-core` even though its new `timezone`/`defaultTimezone` fields conceptually need IANA validation -- `shared-schemas` is bundled into `apps/web` via Vite, and `delivery-core` is Node-only (pulls in `pg`/KMS/SendGrid transitively). Verified via a clean `apps/web` production build after the change. The real `Intl.supportedValuesOf` check runs server-side only (`apps/api`'s route/repository layer).
- `packages/contacts-core` DID gain a `@mega-crm/delivery-core` dependency (needed for `isValidIanaTimezone` in `csv-mapping.ts`) -- safe because `contacts-core` is consumed only by `apps/api`/`apps/worker`, never `apps/web`.
- Both `handleDelayNode` and `handleSendNode`'s quiet-hours-deferral branch enqueue their own BullMQ delayed nudge with `jobId: flowRunId` -- the same deterministic key `flow-reconciliation.worker.ts`'s 60s backstop nudge uses (06-05), so redelivered/duplicate nudges from any of the three sources can never stack more than one pending advance job per run.
- A flow's quiet-hours window resolves `disabled` -> `override` (flow's own start/end) -> `inherit` (workspace default, gated on `quiet_hours_enabled`); a `null` start/end at any resolved level defensively no-gates rather than throwing (the UI is expected to keep these consistent, but the worker never trusts that).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Test fix] Updated `pre-send-gate.test.ts`'s `WorkspaceSendSettings` defaults assertion**
- **Found during:** Task 2
- **Issue:** Extending `WorkspaceSendSettings` with 4 new required fields broke an existing `toEqual` assertion (deep-equality, not subset match) against the pre-06-07 3-field default object.
- **Fix:** Updated both the "no row exists" and "persisted row" test cases in `pre-send-gate.test.ts` to include the new fields.
- **Files modified:** `packages/delivery-core/src/__tests__/pre-send-gate.test.ts`
- **Verification:** `npm run test -w packages/delivery-core` -- 70/70 passing.
- **Committed in:** `39d661b` (part of Task 2's commit)

**2. [Rule 2 - Auto-add missing critical functionality] `packages/delivery-core/src/send-settings.ts` extended (not in the plan's literal `files_modified` list)**
- **Found during:** Task 2 (read side) and Task 3 (write side)
- **Issue:** The plan's `files_modified` list only names `quiet-hours.ts`/`index.ts` for `delivery-core`, but the delay/send handlers need to READ the workspace's default timezone + quiet-hours window, and Task 3's own action text explicitly requires the PUT send-settings route to WRITE those same fields. Neither is possible without extending `WorkspaceSendSettings`/`getWorkspaceSendSettings`/`upsertWorkspaceSendSettings`.
- **Fix:** Extended the interface and both functions' SQL with `defaultTimezone`/`quietHoursStart`/`quietHoursEnd`/`quietHoursEnabled` (read/write), matching the already-existing `workspace_send_settings` columns from 06-01 (no new migration needed).
- **Files modified:** `packages/delivery-core/src/send-settings.ts`
- **Verification:** `npm run build -w packages/delivery-core -w apps/worker -w apps/api` + full test suites, all clean.
- **Committed in:** `39d661b` (Task 2, read side)

**3. [Rule 2 - Auto-add missing critical functionality] `packages/contacts-core` (CONTACT_COLUMNS/ContactRow/UpsertContactIdentityInput/upsertContactByIdentity SQL, csv-mapping.ts) extended (not in the plan's literal `files_modified` list)**
- **Found during:** Task 3
- **Issue:** The plan's `files_modified` list names only `apps/api/src/modules/contacts/contact.repository.ts`, but Task 3's own acceptance criteria require "timezone is a recognized standard field for CSV mapping / property registry (not shoved into freeform properties)" -- CSV mapping's `STANDARD_FIELDS` allowlist and the shared upsert's column list both live in `@mega-crm/contacts-core`, a separate package from `apps/api`'s own contact repository.
- **Fix:** Added `timezone` to `ContactRow`/`CONTACT_COLUMNS`/`UpsertContactIdentityInput` and the INSERT/UPDATE SQL in `upsertContactByIdentity` (pass-through, no IANA validation at this layer, mirroring city/country); added `timezone` to `csv-mapping.ts`'s `STANDARD_FIELDS` WITH an `isValidIanaTimezone` reject-the-row check (the one CSV write path that DOES have a response cycle via dry-run's error reporting).
- **Files modified:** `packages/contacts-core/src/contact-repository.ts`, `packages/contacts-core/src/csv-mapping.ts`, `packages/contacts-core/package.json`
- **Verification:** New unit tests in `apps/api/src/modules/contacts/__tests__/csv-import.test.ts`; full `apps/api` test suite (214/214) passing.
- **Committed in:** `7252a83` (Task 3)

**4. [Rule 1 - Path correction] Plan's `apps/api/src/modules/settings/send-settings.routes.ts` reference corrected to the real path**
- **Found during:** Task 3 (context-gathering)
- **Issue:** The plan's frontmatter `files_modified` and Task 3's `read_first` both reference `apps/api/src/modules/settings/send-settings.routes.ts`, but no `modules/settings/` directory exists in this codebase -- the real file (established in Phase 4) is `apps/api/src/modules/campaigns/send-settings.routes.ts`.
- **Fix:** All Task 3 changes applied to the real path.
- **Files modified:** `apps/api/src/modules/campaigns/send-settings.routes.ts` (not `modules/settings/...`)
- **Verification:** N/A (path correction only, no behavior change).
- **Committed in:** `7252a83` (Task 3)

---

**Total deviations:** 4 auto-fixed (1 test-fix Rule 1, 2 missing-critical-functionality Rule 2, 1 path-correction Rule 1).
**Impact on plan:** All auto-fixes were necessary for the plan's own explicitly-stated acceptance criteria to hold (workspace settings read/write, CSV standard-field routing) or to keep the existing test suite green after a required interface extension. No scope creep -- every change traces directly to a sentence in the plan's own Task action/acceptance-criteria text.

## Issues Encountered

None blocking. One design consideration surfaced and resolved during implementation (not a blocker): extending `packages/shared-schemas` with the new timezone/quiet-hours fields initially risked adding a `@mega-crm/delivery-core` dependency (needed for `isValidIanaTimezone`) to a package that is bundled into `apps/web` via Vite -- `delivery-core` is Node-only (pg/KMS/SendGrid). Resolved by keeping the zod-schema-level checks format-only and moving the actual IANA-allowlist validation server-side (`apps/api`'s route/repository layer), verified via a clean `apps/web` production build.

## User Setup Required

None - no external service configuration required. No new npm dependency, no new environment variable, no new migration (all required `contacts.timezone`/`workspace_send_settings.default_timezone`/`quiet_hours_*` columns already existed from 06-01).

## Next Phase Readiness

- `flow-run-advance.worker.ts`'s node-type dispatch now handles `send`/`exit`/`delay` -- 06-08 (branch nodes) is the remaining node type; it slots into the same `if (node.type === "...")` dispatch chain following `handleDelayNode`/`handleSendNode`'s established `{ nextNodeId, ... }`-return / handler-owns-enqueue contract.
- `flow_run_steps.outcome` vocabulary extended this plan: `'waiting'` (delay node dispatched), `'deferred_quiet_hours'` (send deferred at dispatch time) -- 06-08's branch handler should follow the same per-node-type outcome convention.
- The workspace default-timezone + quiet-hours settings API (PUT/GET `/send-settings`) and the contact-timezone write API are both server-complete; 06-11 (frontend) can now bind the contact-form timezone combobox and a workspace quiet-hours settings UI directly against these routes with no further backend work.
- `isValidIanaTimezone`/`resolveTimezone` (delivery-core) and `computeNextWaitUntil` (flows-core) are both standalone, already-exported, reusable primitives -- no further plan in this phase needs to touch either.

---
*Phase: 06-flows-triggered-chains*
*Completed: 2026-07-10*

## Self-Check: PASSED

All 17 created/modified key files verified present on disk; all 5 task/cleanup commit hashes (d193ed7, 39d661b, 7252a83, a6e37b5, fd63493) verified present in git log.
