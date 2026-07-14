---
phase: 05-webhook-processing-delivery-tracking
plan: 11
subsystem: api
tags: [sendgrid, webhooks, delivery-tracking, provisioning, gap-closure]

# Dependency graph
requires:
  - phase: 05-webhook-processing-delivery-tracking
    provides: "createWebhook's reuse-by-name / cap-check / repoint-stale-url machinery (05-07), provisionError propagation to UI (05-08/05-09)"
provides:
  - "provisionEventWebhook self-heals a stale sendgridWebhookId (404 on PATCH) by falling through to createWebhook's reuse-or-create path"
  - "Reconnect/connect/recheck can recover a workspace whose SendGrid webhook was deleted in the dashboard or whose BYO key was rotated to a different account"
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Internal-only result-shape widening (recoverable marker) normalized away before crossing a module's public return boundary, so callers never see an internal signal"

key-files:
  created: []
  modified:
    - apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts
    - apps/api/src/modules/webhooks/__tests__/webhook-provisioning.test.ts

key-decisions:
  - "patchWebhook's 404 response is marked recoverable:true (only for 404, not 401/403/5xx); provisionEventWebhook's existing-id branch falls through to createWebhook only on that specific marker"
  - "The recoverable marker never leaks past provisionEventWebhook's return -- normalized into the existing narrow { id } | { error } shape before use, so ProvisionEventWebhookResult's public contract and both callers (sendgrid-key.ts, webhook-settings.routes.ts) need zero edits"

patterns-established: []

requirements-completed: [WBHK-01]

coverage:
  - id: D1
    description: "A stale stored sendgridWebhookId that SendGrid 404s on PATCH falls through to createWebhook's reuse-or-create path and returns an active webhook with a NEW id, not the stale one"
    requirement: "WBHK-01"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/webhooks/__tests__/webhook-provisioning.test.ts#a stale stored id (PATCH 404) falls through to CREATE and returns the NEW id, not the stale id"
        status: pass
    human_judgment: false
  - id: D2
    description: "On the fallback-create path, a subsequent signed-verification failure still returns the NEW webhookId (not the stale one), so callers persist the correct id even in the degraded error branch"
    requirement: "WBHK-01"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/webhooks/__tests__/webhook-provisioning.test.ts#a stale stored id (PATCH 404) + CREATE ok + signed 403 preserves the NEW webhookId (not the stale id) alongside the error"
        status: pass
    human_judgment: false
  - id: D3
    description: "No regressions across the full monorepo test suite after the fix"
    verification:
      - kind: unit
        ref: "npm run test --workspaces --if-present (all 6 workspaces green)"
        status: pass
    human_judgment: false

duration: 11min
completed: 2026-07-09
status: complete
---

# Phase 05 Plan 11: Reconnect self-heal for a stale stored webhook id Summary

**`provisionEventWebhook` now treats a 404 on the PATCH-by-stored-id call as "stale id" and falls through to `createWebhook`'s reuse-or-create path, so Reconnect/connect/recheck can recover a workspace whose SendGrid webhook was deleted or whose BYO key was rotated to a different account.**

## Performance

- **Duration:** 11 min
- **Started:** 2026-07-09T13:20:04Z (prior plan-completion commit)
- **Completed:** 2026-07-09T13:31:08Z
- **Tasks:** 2 completed
- **Files modified:** 2

## Accomplishments
- Closed CR-01 from 05-REVIEW.md: a stored `sendgridWebhookId` that no longer exists on the tenant's SendGrid account (404 on PATCH) previously mapped to a plain `{ error: "failed" }` dead end, permanently wedging delivery tracking with no self-service recovery.
- `patchWebhook`'s 404 response is now marked internally `recoverable: true`; `provisionEventWebhook`'s existing-id branch falls through to `createWebhook` (list-by-workspace-scoped-friendly_name reuse, cap check, or fresh create) on that signal, exactly mirroring the machinery already built in 05-07/05-08.
- The NEW id is what callers persist on both fallback outcomes: success (`result.id`) and signed-failure-after-fallback (`result.webhookId`) -- confirmed zero edits were needed in `sendgrid-key.ts` or `webhook-settings.routes.ts`, since both already write `result.id` on success and `result.webhookId ?? existing?.sendgridWebhookId ?? null` on error.
- Two regression tests pin the target behavior (RED before Task 2, GREEN after): stale-id 404 -> CREATE ok -> signed ok returns the new id; stale-id 404 -> CREATE ok -> signed 403 preserves the new `webhookId` alongside the error.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add failing regression tests for the stored-id 404 -> CREATE fallback** - `27c52d5` (test)
2. **Task 2: Fall through to createWebhook on a 404 PATCH of a stale stored id** - `fc7735c` (fix)

_TDD-style plan: RED (Task 1) confirmed both new cases failed against pre-fix code (`{ error: "failed" }`), then GREEN (Task 2) made both pass without weakening any of the 12 pre-existing cases._

## Files Created/Modified
- `apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts` - `patchWebhook`'s return type widened internally with `PatchWebhookResult` (`{ id } | { error; recoverable? }`); `provisionEventWebhook`'s existing-id branch falls through to `createWebhook` when `recoverable` is true, and normalizes the marker away before the value crosses the public return boundary.
- `apps/api/src/modules/webhooks/__tests__/webhook-provisioning.test.ts` - Two new regression tests inside the existing `describe("provisionEventWebhook (D-01/D-02/D-05)", ...)` block, reusing the existing `route()`/`jsonResponse` stubbed-fetch harness (no new mocking library).

## Decisions Made
- `patchWebhook`'s 404 response is marked `recoverable: true` -- and only for 404, not 401/403/5xx -- since a 404 specifically means "the id no longer exists on the account," which is the one failure mode `createWebhook`'s reuse-or-create machinery can actually resolve.
- The `recoverable` marker is normalized away inside `provisionEventWebhook` before assignment to the narrow `{ id } | { error }` local, so `ProvisionEventWebhookResult`'s public shape and both existing callers require zero edits -- confirmed via `git diff` showing no changes to `sendgrid-key.ts` or `webhook-settings.routes.ts`.

## Deviations from Plan

None - plan executed exactly as written. The task action explicitly specified the internal type widening, the fall-through condition, and the normalization requirement; all three were implemented as described with no additional fixes needed.

One micro-correction during Task 2 verification: the first implementation pass left `recoverable: false` on the non-recoverable error branch, which leaked into the return value and broke the pre-existing "403 scope response" test (`expected { error: 'missing_scope', recoverable: false } to deeply equal { error: 'missing_scope' }`). Fixed inline (Rule 1 - bug, self-caught before commit) by explicitly re-narrowing to `{ error: patchResult.error }` on the non-recoverable branch, matching the plan's explicit "never leaks into provisionEventWebhook's returned value" requirement. No separate commit -- folded into the Task 2 commit since it was caught during that task's own verification loop, not after.

## Issues Encountered

The plan's stated baseline of "397 tests" (from 05-VERIFICATION.md) did not match the actual full-suite count observed in this environment (366 total across 6 workspaces, apps/api alone at 190 before / 192 after the 2 new tests). Investigated by diffing apps/api's test count with and without the new tests in the current environment: 190 -> 192, an exact +2 match with zero failures. Concluded the 397 figure in 05-VERIFICATION.md was already stale/inaccurate relative to this environment's actual test count (unrelated to this plan's change, and pre-existing) -- not a regression introduced here. The literal acceptance criterion ("no regressions") is satisfied: `npm run test --workspaces --if-present` reports all 6 workspaces green with zero failures.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- CR-01 is closed. The single remaining Phase 5 gap tracked in 05-REVIEW.md/05-VERIFICATION.md is resolved; Phase 05 has no further known gaps.
- Reconnect ("Переподключить") can now self-heal a workspace whose webhook was deleted in the SendGrid dashboard or whose BYO key was rotated to a different SendGrid account -- WBHK-01 is fully satisfied.
- No blockers for downstream phases.

---
*Phase: 05-webhook-processing-delivery-tracking*
*Completed: 2026-07-09*

## Self-Check: PASSED

- FOUND: apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts
- FOUND: apps/api/src/modules/webhooks/__tests__/webhook-provisioning.test.ts
- FOUND commit: 27c52d5 (Task 1)
- FOUND commit: fc7735c (Task 2)
