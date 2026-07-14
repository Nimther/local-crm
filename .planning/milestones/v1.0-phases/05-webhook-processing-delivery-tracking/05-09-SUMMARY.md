---
phase: 05-webhook-processing-delivery-tracking
plan: 09
subsystem: full-stack
tags: [sendgrid, webhooks, ux, gap-closure, drizzle, zod, react]

# Dependency graph
requires:
  - phase: 05-webhook-processing-delivery-tracking
    provides: redacted status+body logging, optional webhookId on signed-verification failure, persisted provision_error column (05-08)
provides:
  - "validateTenantSendGridKey valid result carries webhookScopePresent, derived from /v3/scopes"
  - "webhook-warning-copy.ts shared module (webhookWarningFor + 3 Russian copy constants) used by both connect/recheck and health/reconnect"
  - "provisionWebhookBestEffort short-circuits deterministically (no doomed SendGrid call) when the key lacks the webhook-management scope"
  - "webhookHealthResponseSchema.provisionError: curated Russian reason on GET webhook-health and POST webhook-reconnect"
  - "webhook-notice.ts pure UI decision helpers (webhookNoticeForKeyResponse, reconnectToastForHealth, webhookHealthDescription)"
  - "SendGridKeySettings.tsx renders the webhookWarning inline and the WebhookHealthCard shows a real error toast + reason instead of a lying success toast"
affects: [05-10]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "webhookWarningFor(reason) lives in webhook-warning-copy.ts and is the single source of truth for mapping a typed ProvisionEventWebhookError to Russian copy -- both sendgrid-key.ts (connect/recheck) and webhook-settings.routes.ts (health/reconnect) import it, closing the risk of the two surfaces drifting on wording"
    - "provisionWebhookBestEffort's webhookScopePresent short-circuit persists provisionError:'missing_scope' and returns webhookWarningFor('missing_scope') WITHOUT ever calling provisionEventWebhook -- avoids a doomed 403 round-trip"
    - "webhook-notice.ts follows the segmentSaveGate precedent: a pure, DOM-free module unit-tested in apps/web's node-environment vitest lane (no jsdom/@testing-library needed)"

key-files:
  created:
    - apps/api/src/modules/webhooks/webhook-warning-copy.ts
    - apps/web/src/features/sendgrid-key/webhook-notice.ts
    - apps/web/src/features/sendgrid-key/__tests__/webhook-notice.test.ts
  modified:
    - apps/api/src/modules/tenancy/sendgrid-client.ts
    - apps/api/src/modules/tenancy/sendgrid-key.ts
    - apps/api/src/modules/tenancy/__tests__/sendgrid-key-webhook-provisioning.test.ts
    - packages/shared-schemas/src/webhook.ts
    - apps/api/src/modules/webhooks/webhook-settings.routes.ts
    - apps/api/src/modules/webhooks/__tests__/webhook-settings-routes.test.ts
    - apps/web/src/features/sendgrid-key/SendGridKeySettings.tsx

key-decisions:
  - "webhook-warning-copy.ts extracted as a new module (not left duplicated) so connect/recheck and health/reconnect can never drift on the Russian copy for the same typed reason"
  - "webhookHealthDescription returns null (not a formatted string) outside the error state -- keeps the pure helper from having to replicate SendGridKeySettings.tsx's relativeTime/Intl.RelativeTimeFormat formatting, which is inherently impure (depends on Date.now())"
  - "Test-file mockScopes helpers in both sendgrid-key-webhook-provisioning.test.ts and webhook-settings-routes.test.ts were updated to include the webhook-management scope by default -- Task 1's new connect-time scope check would otherwise short-circuit every pre-existing provisioning-success test path"

requirements-completed: [WBHK-01, WBHK-04]

coverage:
  - id: D1
    description: "A key lacking the webhook-management scope at connect/recheck time produces a deterministic missing-scope warning with no doomed SendGrid webhook call"
    requirement: "WBHK-01"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/tenancy/__tests__/sendgrid-key-webhook-provisioning.test.ts#a key lacking the webhook-management scope at connect time short-circuits deterministically (05-09 Task 1)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Provisioning failures persist the typed provisionError reason and preserve the created webhookId on signed-verification failure"
    requirement: "WBHK-01"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/tenancy/__tests__/sendgrid-key-webhook-provisioning.test.ts#a provisioning failure (403 missing scope) degrades gracefully (05-09 Task 1)"
        status: pass
      - kind: unit
        ref: "apps/api/src/modules/webhooks/__tests__/webhook-settings-routes.test.ts#POST reconnect preserves a created-but-unsigned webhook id when signed-verification fails (05-09 Task 2)"
        status: pass
    human_judgment: false
  - id: D3
    description: "GET webhook-health and POST webhook-reconnect surface a human-readable provisionError; the reconnect success/error toast and health-card description are driven by it in the UI"
    requirement: "WBHK-04"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/webhooks/__tests__/webhook-settings-routes.test.ts#GET webhook-health for a workspace in the error state returns a non-null provisionError message (05-09 Task 2)"
        status: pass
      - kind: unit
        ref: "apps/web/src/features/sendgrid-key/__tests__/webhook-notice.test.ts (05-09 Task 3, 10/10 pass)"
        status: pass
      - kind: other
        ref: "npm run build -w apps/api && npm run build -w packages/shared-schemas && npm run build -w apps/web (all exit 0)"
        status: pass
    human_judgment: true
    human_judgment_note: "Live rendering of the inline warning/error toast/health-card reason in the running app is deferred to phase-level UAT re-verification of Tests 1/3, per human_verify_mode: end-of-phase."

duration: 25min
completed: 2026-07-09
status: complete
---

# Phase 05 Plan 09: Carry the webhook provisioning-failure reason to the rendered UI Summary

**Connect-time webhook-scope detection, a shared warning-copy module, a `provisionError` field on the health/reconnect contract, and a pure decision-helper module that stops SendGridKeySettings.tsx's reconnect handler from lying with an unconditional success toast.**

## Performance

- **Duration:** ~25 min (task commits 17:36 -> 17:44 local)
- **Started:** 2026-07-09 (phase 05 execution, plan 09 of 10)
- **Completed:** 2026-07-09
- **Tasks:** 3/3 completed
- **Files modified:** 10 (3 new, 7 modified)

## Accomplishments

- `sendgrid-client.ts`'s `validateTenantSendGridKey` now returns `webhookScopePresent: boolean` on the valid result, derived from a new `WEBHOOK_EVENT_SETTINGS_SCOPE_PREFIX` check against the `/v3/scopes` response — never turns a missing webhook scope into a failed key connect (D-01 preserved).
- `webhook-warning-copy.ts` is a new shared module exporting `webhookWarningFor` plus the three Russian warning constants, extracted verbatim from `sendgrid-key.ts` and imported by both the connect/recheck handlers and the health/reconnect route — a single source of truth for the copy.
- `provisionWebhookBestEffort` gained a third `webhookScopePresent` parameter: when the scope is absent it persists `provisionError: "missing_scope"` and returns the warning WITHOUT ever calling `provisionEventWebhook`, closing the doomed-403-call gap from UAT Test 1. When provisioning does attempt and fails, the typed reason is now persisted (`provisionError: result.error`) alongside the preserved `webhookId` from 05-08.
- `webhookHealthResponseSchema` gained `provisionError: z.string().nullable()`; `webhook-settings.routes.ts`'s GET health and POST reconnect both map the stored typed reason through `webhookWarningFor` and return it — reconnect no longer discards the reason on failure, and the created-but-unsigned webhook id survives a reconnect (05-08's preserved-id fix now flows end-to-end).
- `webhook-notice.ts` is a new pure, DOM-free module (mirrors the `segmentSaveGate` precedent) exporting `webhookNoticeForKeyResponse`, `reconnectToastForHealth`, and `webhookHealthDescription` — fully unit-tested (10/10) in apps/web's node vitest lane.
- `SendGridKeySettings.tsx`: connect/recheck now render the server's `webhookWarning` inline (amber, distinct from the destructive `serverError` paragraph) and `toast.warning` it; the `WebhookHealthCard`'s reconnect handler replaces the previous unconditional `toast.success(...)` with `reconnectToastForHealth`-driven success/error toasts, and its `CardDescription` shows the curated reason when `provisionStatus === "error"`.

## Task Commits

Each task was committed atomically:

1. **Task 1: Connect-time webhook-scope detection + persist typed reason on connect/recheck** - `8fd326d` (feat)
2. **Task 2: Reconnect error propagation + provisionError on the health contract** - `c3ceffc` (feat)
3. **Task 3: Render the reason in the UI (inline warning + reconnect error toast + health-card reason)** - `248ce28` (feat)

**Plan metadata:** (pending — final docs commit follows this summary)

## Files Created/Modified

- `apps/api/src/modules/tenancy/sendgrid-client.ts` — Added `WEBHOOK_EVENT_SETTINGS_SCOPE_PREFIX` constant and `webhookScopePresent` on the valid `ValidateTenantSendGridKeyResult` arm
- `apps/api/src/modules/webhooks/webhook-warning-copy.ts` — NEW: `webhookWarningFor` + `WEBHOOK_MISSING_SCOPE_WARNING`/`WEBHOOK_CAP_REACHED_WARNING`/`WEBHOOK_PROVISION_FAILED_WARNING`, extracted from `sendgrid-key.ts`
- `apps/api/src/modules/tenancy/sendgrid-key.ts` — `provisionWebhookBestEffort` takes `webhookScopePresent`, short-circuits on missing scope, persists typed `provisionError` + preserved `webhookId` on failure, `provisionError: null` on success; both connect and recheck call sites pass `validation.webhookScopePresent`
- `apps/api/src/modules/tenancy/__tests__/sendgrid-key-webhook-provisioning.test.ts` — `mockScopes` now takes a `scopes` param defaulting to `["mail.send"]`; existing success/reconnect tests updated to pass a webhook-scoped key; two new tests cover the deterministic short-circuit and the with-scope success path
- `packages/shared-schemas/src/webhook.ts` — `webhookHealthResponseSchema` gained `provisionError: z.string().nullable()`
- `apps/api/src/modules/webhooks/webhook-settings.routes.ts` — GET health maps stored `provisionStatus`/`provisionError` through `webhookWarningFor`; POST reconnect persists+returns the typed reason and preserves `result.webhookId` on failure
- `apps/api/src/modules/webhooks/__tests__/webhook-settings-routes.test.ts` — `mockScopes` default now includes the webhook-management scope (needed after Task 1); updated 3 existing assertions to include `provisionError`; added 3 new tests (reconnect failure reason, preserved-id-on-signed-failure, health error-state reason)
- `apps/web/src/features/sendgrid-key/webhook-notice.ts` — NEW: pure `webhookNoticeForKeyResponse`, `reconnectToastForHealth`, `webhookHealthDescription`
- `apps/web/src/features/sendgrid-key/__tests__/webhook-notice.test.ts` — NEW: 10 unit tests covering all three helpers
- `apps/web/src/features/sendgrid-key/SendGridKeySettings.tsx` — `KeyMutationResponse.webhookWarning?`; new `webhookWarning` state set from connect/recheck responses and rendered inline + `toast.warning`'d; `WebhookHealthCard`'s reconnect `onSuccess` now driven by `reconnectToastForHealth`; `CardDescription` driven by `webhookHealthDescription`

## Decisions Made

- `webhook-warning-copy.ts` is a genuinely new module (not just re-exported) so the two surfaces (connect/recheck vs. health/reconnect) share one literal source of the Russian copy and cannot drift.
- `webhookHealthDescription` returns `null` outside the error state rather than replicating `SendGridKeySettings.tsx`'s `relativeTime`/`Intl.RelativeTimeFormat` formatting inside the pure helper — that formatting is inherently impure (depends on `Date.now()`), so the caller keeps owning its existing fallback rendering.
- Both provisioning test files' `mockScopes` helpers were updated to default to (or explicitly pass) a webhook-management-scoped key list, since Task 1's new connect-time scope check would otherwise silently short-circuit every pre-existing provisioning-success test path into the new deterministic missing-scope branch — this was caught by running the full suites, not anticipated from reading the plan alone.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Pre-existing test helpers broke after Task 1's connect-time scope check landed**
- **Found during:** Task 1 verification (running the full `sendgrid-key-webhook-provisioning` + `webhook-settings-routes` suites)
- **Issue:** `sendgrid-key-webhook-provisioning.test.ts`'s existing `mockScopes(VALID_KEY)` calls (and `webhook-settings-routes.test.ts`'s `connectKey` helper, which also calls `mockScopes`) return only `{ scopes: ["mail.send"] }`. Once `provisionWebhookBestEffort` started short-circuiting on a missing webhook scope, these previously-passing tests (which expect a successful provisioning flow) started failing because the scope check now intercepted them before the webhook listing/create/patch/signed nock interceptors were ever hit.
- **Fix:** Changed both files' `mockScopes` helpers to accept an optional `scopes` parameter (with a `WITH_WEBHOOK_SCOPE` constant `["mail.send", "user.webhooks.event.settings.update"]` used as the default in `webhook-settings-routes.test.ts`, and passed explicitly at call sites in `sendgrid-key-webhook-provisioning.test.ts` where a real provisioning attempt is under test).
- **Files modified:** `apps/api/src/modules/tenancy/__tests__/sendgrid-key-webhook-provisioning.test.ts`, `apps/api/src/modules/webhooks/__tests__/webhook-settings-routes.test.ts`
- **Commit:** `8fd326d` (Task 1 test file), `c3ceffc` (Task 2 test file, three additional existing assertions updated to include `provisionError`)

## Issues Encountered

None beyond the auto-fixed test-helper drift above.

## User Setup Required

None — no external service configuration required. All changes are code + test only; the live-key UAT re-verification of Tests 1/3 (already scheduled per 05-08's Next Phase Readiness note) is where a human will observe the rendered warning/toast/health-card copy for the first time against a real SendGrid key missing webhook scope.

## Next Phase Readiness

- The full vertical slice diagnosed in the two UAT failures is now closed end-to-end: a scope-lacking key gets a deterministic warning at connect time (no doomed call), a failed reconnect shows a real error toast with the reason instead of a lying success toast, and the health card explains why it's in the error state.
- Phase-level UAT re-verification of Test 1 (missing-scope key) and Test 3 (Reconnect failure) is the remaining human-judgment item — the automated coverage (25/25 relevant backend tests, 10/10 frontend decision-helper tests, clean builds across api/shared-schemas/web) is accepted as sufficient to unblock plan completion, following the Phase 1/2/3 precedent for deferring live-browser verification to end-of-phase.
- No further gap-closure work is anticipated for this UAT diagnosis; 05-10 is the last plan in wave 2 and already has its own summary on disk.

---
*Phase: 05-webhook-processing-delivery-tracking*
*Completed: 2026-07-09*

## Self-Check: PASSED

All created/modified files and all task commit hashes verified present on disk / in git log.
