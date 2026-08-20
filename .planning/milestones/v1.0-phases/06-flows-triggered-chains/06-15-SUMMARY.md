---
phase: 06-flows-triggered-chains
plan: 15
subsystem: infra
tags: [flows-engine, quiet-hours, timezone, gap-closure, tdd]

# Dependency graph
requires:
  - phase: 06-flows-triggered-chains
    provides: per-flow quiet-hours deferral (06-07), the workspace_default|custom|disabled vocabulary unification (06-13)
provides:
  - One canonical, correctly-bound loadContactTimezone(client, workspaceId, contactId) in @mega-crm/delivery-core, replacing two divergent private copies in send-node.ts and delay-node.ts
  - The contact's own stored timezone (contacts.timezone) is now actually consulted for quiet-hours gating and wait_until delay computation, restoring D-08/FLOW-05
affects: [06-flows-triggered-chains phase verification, roadmap success criterion 3]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Shared DB-helper functions that two or more call sites must never diverge on live in the lowest common package (@mega-crm/delivery-core), never duplicated locally per caller -- mirrors the existing getWorkspaceSendSettings/resolveTimezone convention in the same package"

key-files:
  created:
    - packages/delivery-core/src/contact-timezone.ts
  modified:
    - packages/delivery-core/src/index.ts
    - apps/worker/src/queues/flows/handlers/send-node.ts
    - apps/worker/src/queues/flows/handlers/delay-node.ts
    - apps/worker/src/queues/__tests__/flow-run-advance.test.ts

key-decisions:
  - "loadContactTimezone's client.query parameter array binds [workspaceId, contactId] (matching $1 = workspace_id, $2 = id) -- the pre-existing bug in both handlers passed [contactId, workspaceId], silently matching wrong values against the WHERE clause and always resolving no timezone row"
  - "The shared helper lives in a new packages/delivery-core/src/contact-timezone.ts file, not inside quiet-hours.ts -- quiet-hours.ts is contractually pure/DB-free (never imports pg), matching packages/flows-core's 'pure compiler package' convention"
  - "Two DST-free IANA zones (Asia/Kolkata UTC+5:30, Pacific/Honolulu UTC-10) with ~15.5h separation were chosen for the regression tests so pass/fail never depends on the wall-clock minute the suite happens to run at"

requirements-completed: [FLOW-05]

coverage:
  - id: D1
    description: "A contact with a stored timezone differing from the workspace default has its custom quiet-hours window evaluated in the CONTACT's timezone -- a send inside the contact's local quiet window defers (outcome deferred_quiet_hours), never enqueued"
    requirement: "FLOW-05"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/flow-run-advance.test.ts#06-15/D-08/FLOW-05: a custom quiet-hours window is evaluated in the CONTACT's timezone -- a send inside the contact's local window defers even when the workspace default timezone places now outside it"
        status: pass
    human_judgment: false
  - id: D2
    description: "A wait_until delay computes next_wake_at at the configured local time-of-day in the CONTACT's timezone, not the workspace default timezone"
    requirement: "FLOW-05"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/flow-run-advance.test.ts#06-15/D-08/FLOW-05: a wait_until delay computes next_wake_at at the contact's local time-of-day, not the workspace default timezone"
        status: pass
    human_judgment: false
  - id: D3
    description: "No local loadContactTimezone definition remains in either handler; the single shared helper is exported from @mega-crm/delivery-core"
    requirement: "FLOW-05"
    verification:
      - kind: static
        ref: "grep -rncE \"function loadContactTimezone\" apps/worker/src/queues/flows/handlers/send-node.ts apps/worker/src/queues/flows/handlers/delay-node.ts -> 0/0; grep -c loadContactTimezone packages/delivery-core/src/index.ts -> 1"
        status: pass
    human_judgment: false

metrics:
  duration: 12min
  completed: 2026-07-10
status: complete
---

# Phase 6 Plan 15: Contact-Timezone Bind-Order Fix (Gap Closure) Summary

Consolidated a divergent, incorrectly-bound `loadContactTimezone` SQL helper duplicated in both `send-node.ts` and `delay-node.ts` into one shared, correctly-bound function in `@mega-crm/delivery-core`, restoring D-08/FLOW-05: quiet hours and wait-until delays now honor the recipient's own stored timezone instead of silently falling back to the workspace default.

## What Was Built

The 06-VERIFICATION.md gap-closure report identified the sole remaining Phase 6 verification gap (roadmap success criterion 3 / FLOW-05): both flow handlers' private `loadContactTimezone` functions ran

```sql
SELECT timezone FROM contacts WHERE workspace_id = $1 AND id = $2
```

but bound the parameter array as `[contactId, workspaceId]` -- swapped relative to the query's own `$1`/`$2` order. Since `contactId` and `workspaceId` are both UUIDs, this never threw a type error; it simply matched the wrong row (or, in the common case where the swapped values happened not to correspond to any row, silently returned no timezone), so `resolveTimezone` always fell through to the workspace default and the contact's own `contacts.timezone` was never actually consulted.

This plan executed as a full RED -> GREEN TDD slice:

**RED (Task 1):** Added two integration regression tests to `flow-run-advance.test.ts` using two DST-free IANA zones with a large, stable separation (`Asia/Kolkata`, UTC+5:30, and `Pacific/Honolulu`, UTC-10, ~15.5h apart) so the assertions never depend on the exact wall-clock minute the suite runs at:
- **Test A** (send-node quiet hours): seeds a contact whose stored timezone places "now" inside a 120-minute custom quiet window, while the workspace default timezone would place "now" well outside it. Asserts the send defers (`outcome: "deferred_quiet_hours"`, no send job enqueued).
- **Test B** (delay wait_until): seeds a `wait_until` delay node (`timeOfDay: 600` = 10:00 local) and asserts `next_wake_at` lands at 10:00 in the contact's timezone (with a divergence proof that it is NOT 10:00 in the workspace's timezone for the same instant).

Ran against the unfixed code, both failed for the correct behavioral reason (Test A: the send was enqueued instead of deferred; Test B: `next_wake_at` landed at 01:30 IST -- i.e. 10:00 Honolulu time -- not 10:00 IST), confirming the defect was pinned before any fix.

**GREEN (Task 2):** Created `packages/delivery-core/src/contact-timezone.ts` exporting a single `loadContactTimezone(client, workspaceId, contactId): Promise<string | null>`, matching `send-settings.ts`'s established DB-helper style, with the corrected bind order `[workspaceId, contactId]`. Re-exported it from the package barrel (`index.ts`). Deleted the two private copies from `send-node.ts` and `delay-node.ts` and imported the shared helper from `@mega-crm/delivery-core` instead -- call sites (`loadContactTimezone(client, workspaceId, contactId)`) stayed byte-identical; only the bind order inside the now-shared implementation changed.

## Verification

- `cd apps/worker && npx vitest run src/queues/__tests__/flow-run-advance.test.ts` -- 8/8 pass, including the two new "06-15" cases and all six pre-existing cases (no regression).
- `cd apps/worker && npx vitest run src/queues/__tests__` (full suite) -- 93/93 pass across 19 test files.
- `cd packages/delivery-core && npx vitest run` -- 70/70 pass.
- `grep -rncE "function loadContactTimezone" apps/worker/src/queues/flows/handlers/send-node.ts apps/worker/src/queues/flows/handlers/delay-node.ts` -- 0/0 (no local copies remain).
- `grep -c "loadContactTimezone" packages/delivery-core/src/index.ts` -- 1 (exported).
- `cd packages/delivery-core && npm run build` (tsc) -- clean.
- `cd apps/worker && npx tsc --noEmit -p tsconfig.json` -- clean.

## Deviations from Plan

None -- plan executed exactly as written. Both tasks matched their `<action>`/`<acceptance_criteria>` precisely: the shared helper's file location, export style, bind order, and both handlers' import-only call sites all landed as specified.

## TDD Gate Compliance

RED gate: `test(06-15): add failing contact-timezone regression tests (RED)` commit, verified failing against the pre-fix code for the correct behavioral reason (not a compile/setup error).
GREEN gate: `fix(06-15): consolidate loadContactTimezone with correct SQL bind order (GREEN)` commit, verified all 8 tests (including the 2 new cases) pass.
No REFACTOR commit was needed -- the GREEN commit's consolidation (deleting two duplicated functions in favor of one shared, correctly-ordered helper) already achieved the cleanup this task's REFACTOR step would otherwise have covered.

## Threat Flags

None -- this plan's threat register (T-06-15-01/02/03) covers exactly the surface touched (the swapped-bind fix itself, the tenant-scoping of the consolidated helper, and the pre-existing UTC fallback for a corrupt zone); no new network endpoint, auth path, file-access pattern, or schema change was introduced.

## Self-Check: PASSED

- FOUND: packages/delivery-core/src/contact-timezone.ts
- FOUND: packages/delivery-core/src/index.ts (exports loadContactTimezone)
- FOUND: apps/worker/src/queues/flows/handlers/send-node.ts (imports loadContactTimezone, no local copy)
- FOUND: apps/worker/src/queues/flows/handlers/delay-node.ts (imports loadContactTimezone, no local copy)
- FOUND: apps/worker/src/queues/__tests__/flow-run-advance.test.ts (two new "06-15" test cases)
- FOUND commit 10ac91e: test(06-15): add failing contact-timezone regression tests (RED)
- FOUND commit 3e24b98: fix(06-15): consolidate loadContactTimezone with correct SQL bind order (GREEN)
