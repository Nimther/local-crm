---
phase: 05-webhook-processing-delivery-tracking
verified: 2026-07-09T11:50:00Z
status: human_needed
score: 4/4 truths verified
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: "4/4 truths present and passing tests; 2 truths carried an unresolved, codebase-confirmed correctness defect"
  gaps_closed:
    - "Duplicate webhook deliveries (same sg_event_id) do not double-count or corrupt delivery statistics — WR-01/WR-02 (non-deterministic occurred_at fallback, unguarded RangeError on out-of-range timestamp) closed by plan 05-06"
    - "SendGrid events arrive on the workspace's per-tenant webhook URL and update each message's status in the send log — CR-01 (stale-URL webhook reuse, cross-workspace webhook adoption) closed by plan 05-07"
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "Connect a real tenant SendGrid API key and confirm in the SendGrid dashboard that a signed 'Mega CRM Delivery Tracking (<workspace-prefix>)' Event Webhook is created (or PATCHed), the tenant's own pre-existing webhooks are untouched, and the implemented CREATE path (documented vs `.../settings/all` fallback, Open Question A3) matches what the live account actually requires."
    expected: "A new (or updated) Event Webhook named 'Mega CRM Delivery Tracking (<workspace-prefix>)' appears in SendGrid → Settings → Mail Settings → Event Webhook, signed verification is enabled, and no other webhook entries are modified or removed."
    why_human: "Requires a live tenant SendGrid API key with webhook-management scope; not available in an automated verification run. Deferred per the plan's own `human_verify_mode: end-of-phase` (05-04-PLAN.md). Unaffected by the 05-06/05-07 gap-closure fixes (no web/UI files changed since the prior verification)."
  - test: "After a live SendGrid key connect and a real signed event delivery, check the SendGrid settings page's webhook-health card."
    expected: "The card shows a connected/active indicator, a non-null 'Последнее событие получено' relative time once a real event lands, and clicking Reconnect refreshes the card without error."
    why_human: "Requires a live signed webhook event to observe the UI update in a browser; deferred per 05-05-PLAN.md's own `<human-check>`. Unaffected by the gap-closure fixes."
  - test: "For an already-connected (pre-Phase-5) workspace, view the onboarding checklist."
    expected: "An 'Включить отслеживание доставки' item appears, links to SendGrid settings when incomplete, and flips to done after enabling/reconnecting tracking."
    why_human: "Requires a live reconnect flow observed in the browser; deferred per 05-05-PLAN.md's own `<human-check>`. Unaffected by the gap-closure fixes."
---

# Phase 5: Webhook Processing & Delivery Tracking Verification Report

**Phase Goal:** A marketer's sent emails show accurate, deduplicated delivery outcomes, and bounces/unsubscribes/spam complaints automatically suppress contacts from future sends.
**Verified:** 2026-07-09T11:50:00Z
**Status:** human_needed
**Re-verification:** Yes — after gap closure (plans 05-06, 05-07)

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | SendGrid events (delivered/opened/clicked/bounced/unsubscribed/spam report/dropped) arrive on the workspace's per-tenant webhook URL and update each message's status in the send log | ✓ VERIFIED | Route wired (`POST /webhooks/sendgrid/:pathToken`), signature-verified, enqueued, worker applies fact columns idempotently. **CR-01 closed (plan 05-07):** `createWebhook`'s reuse-by-name branch (`sendgrid-webhook-provision.ts` lines 145-186) now compares `existing.url !== callbackUrl` and calls `patchWebhook` to repoint before returning — direct code read confirms the fix; `friendly_name` is now workspace-scoped via `webhookFriendlyName(workspaceId)` = `"Mega CRM Delivery Tracking (<8-char-prefix>)"`, so two workspaces sharing one SendGrid key can no longer adopt/repoint each other's webhook. Both production callers (`sendgrid-key.ts` connect/recheck, `webhook-settings.routes.ts` reconnect) verified passing `workspace.id` through. Two new regression tests (`reuse-by-name with a stale url PATCHes...`, `a different workspace does not adopt a sibling's webhook...`) pass against a real fetch-mock harness exercising the exact reuse/adopt scenarios. |
| 2 | A payload with an invalid ECDSA signature is rejected, while a valid one is verified against the raw request body before any parsing | ✓ VERIFIED | Unchanged since prior verification — `webhooks.routes.ts` scopes `addContentTypeParser("application/json",{parseAs:"buffer"})` inside `registerWebhookRoutes` only; `signature-verify.ts` calls `verifySignature` before any `JSON.parse`; `webhooks-signature.test.ts` (5 tests, real SendGrid published fixture, real ECDSA bytes) re-run and passes: valid→200+1 enqueue, invalid/missing→400+0 enqueue+no parse, unknown pathToken→404 before signature attempt. |
| 3 | Duplicate webhook deliveries (same sg_event_id) do not double-count or corrupt delivery statistics | ✓ VERIFIED | `send_events` has `UNIQUE(workspace_id, sg_event_id, occurred_at)`; `ON CONFLICT ... DO NOTHING RETURNING` gates every side effect. **WR-01/WR-02 closed (plan 05-06):** `extractEventRow` (`webhook-events.worker.ts` lines 38-99) now requires `typeof event.timestamp === "number" && Number.isFinite(...) && Math.abs(timestamp*1000) <= 8.64e15` before constructing `occurredAt`; on failure it returns `null` (same treatment as a missing `sg_event_id`) instead of substituting `new Date().toISOString()` — confirmed present in the current tree by direct code read, no wall-clock fallback remains anywhere in the function. Two new regression tests pass: `WBHK-03/D-09: a redelivered event with a missing/invalid timestamp does not double-insert or double-count` (asserts `inserted:0` on both the first attempt and the replay, zero `send_events` rows, `delivered_at` stays null, counter stays 0) and `an out-of-range numeric timestamp in one event does not fail the rest of the batch` (asserts the batch resolves `{inserted:2}` instead of throwing `RangeError`). |
| 4 | A bounce, spam complaint, or unsubscribe automatically flips the contact's subscription status so subsequent sends skip that contact | ✓ VERIFIED | Unchanged since prior verification — `webhook-events-suppression.test.ts` (10 tests) re-run and passes: hard bounce → suppressed(hard_bounce) + 1 `workspace_suppressions` row; 3rd consecutive soft bounce → suppressed(soft_bounce_streak), reset by a delivered event; spam_report → suppressed(spam_report); unsubscribe/group_unsubscribe → unsubscribed with zero suppression rows; dropped-by-reason → suppressed/unsubscribed/no-change per D-12. |

**Score:** 4/4 truths verified. Both gaps from the prior verification (WR-01/WR-02 on truth #3, CR-01 on truth #1) are closed by direct code inspection of the current tree plus passing regression tests that exercise the exact previously-failing scenarios.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps/worker/src/queues/webhook-events.worker.ts` | Full dedup + fact + counter + suppression pipeline, deterministic-or-skip timestamp handling | ✓ VERIFIED | 429 lines; `extractEventRow` hardened per WR-01/WR-02 fix; `processWebhookEventBatch`/`createWebhookEventsWorker` exports unchanged; registered in `apps/worker/src/server.ts` |
| `apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts` | Create/PATCH/enable-signed, workspace-scoped friendly_name, repoint-on-reuse | ✓ VERIFIED | `webhookFriendlyName(workspaceId)` helper added; `createWebhook`'s reuse branch repoints stale URLs before returning; `provisionEventWebhook`/`patchWebhook`/`postCreate` all now take `workspaceId` |
| `apps/api/src/modules/tenancy/sendgrid-key.ts` | Threads workspaceId into provisioning | ✓ VERIFIED | `provisionWebhookBestEffort(workspaceId, apiKey)` signature updated; both connect (line 170) and recheck (line 214) call sites pass `workspace.id` |
| `apps/api/src/modules/webhooks/webhook-settings.routes.ts` | Threads workspaceId into reconnect provisioning | ✓ VERIFIED | Reconnect handler's `provisionEventWebhook(plaintext, callbackUrl, workspace.id, ...)` call confirmed passing `workspace.id` |
| `apps/worker/src/queues/__tests__/webhook-events-idempotency.test.ts` | Regression tests for missing/invalid and out-of-range timestamps | ✓ VERIFIED | Both tests present (lines 222, 246) and pass against real Postgres fixtures |
| `apps/api/src/modules/webhooks/__tests__/webhook-provisioning.test.ts` | Regression tests for stale-url repoint and cross-workspace non-adoption | ✓ VERIFIED | Both tests present (lines 198, 238) and pass against a fetch-mock harness |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `webhooks.routes.ts` | `findWebhookEndpointByToken` | pre-verification pathToken resolve | ✓ WIRED | Unchanged; called before signature check, before any parse |
| `webhooks.routes.ts` | `enqueue.ts` (`WEBHOOK_EVENTS_QUEUE`) | `enqueueWebhookBatch` after valid signature | ✓ WIRED | Unchanged; real BullMQ/Redis job-count assertions in tests |
| `webhook-events.worker.ts` | `send_events` UNIQUE constraint | `ON CONFLICT ... DO NOTHING RETURNING`, now fed a deterministic-or-null `occurredAt` | ✓ WIRED | WR-01/WR-02 caveat removed — dedup key is reliable for every event that reaches the INSERT |
| `sendgrid-key.ts` connect/recheck | `provisionEventWebhook(apiKey, callbackUrl, workspace.id, ...)` | best-effort call inside `withTenant` | ✓ WIRED | `workspace.id` threaded through; CR-01 caveat removed |
| `webhook-settings.routes.ts` reconnect | `provisionEventWebhook(plaintext, callbackUrl, workspace.id, ...)` | reconnect handler | ✓ WIRED | `workspace.id` threaded through |
| `createWebhook` reuse branch | `patchWebhook` | `existing.url !== callbackUrl` guard | ✓ WIRED | New link introduced by 05-07; confirmed by passing regression test asserting `patchBody?.url === CALLBACK_URL` and `createCalled === false` |

### Behavioral Spot-Checks / Test Execution

| Suite | Command | Result | Status |
|-------|---------|--------|--------|
| apps/worker webhook tests | `npm run test -w apps/worker -- webhook-events-status webhook-events-suppression webhook-events-idempotency` | 3 files, 24 tests passed | ✓ PASS |
| apps/api webhook/provisioning/campaign tests | `npm run test -w apps/api -- webhooks-signature webhook-provisioning sendgrid-key webhook-settings webhook-health campaign-delivery-counters` | 6 files, 35 tests passed | ✓ PASS |
| packages/delivery-core tests | `npm run test -w packages/delivery-core` | 7 files, 54 tests passed | ✓ PASS |
| apps/api build | `npm run build -w apps/api` (tsc) | Clean | ✓ PASS |
| Full monorepo test suite | `npm run test --workspaces --if-present` | 60 files (34+1+13+7+1+2+2), 347 tests, all green | ✓ PASS (no regressions from 05-06/05-07) |

No probe scripts (`scripts/*/tests/probe-*.sh`) exist or are declared for this phase — Step 7c is not applicable, consistent with the prior verification.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|--------------|--------|----------|
| WBHK-01 | 05-01, 05-04, 05-07 | Per-tenant webhook URL + ECDSA signature verification + auto-provisioning, workspace-scoped | ✓ SATISFIED | Receiver + provisioning implemented and tested; CR-01 (stale-URL reuse, cross-workspace adoption) closed by plan 05-07 |
| WBHK-02 | 05-02, 05-03 | delivered/opened/clicked/bounced/unsubscribed/spam/dropped event handling | ✓ SATISFIED | Unchanged; `normalizeEventType` covers every listed event |
| WBHK-03 | 05-01, 05-06 | Dedup by sg_event_id, no double-counting on replay | ✓ SATISFIED | Dedup constraint + RETURNING gate; WR-01/WR-02 (non-deterministic occurred_at fallback, unguarded RangeError) closed by plan 05-06 |
| WBHK-04 | 05-03, 05-05, 05-07 | Webhook events update message status + are surfaced to the marketer | ✓ SATISFIED | Fact columns + campaign counters written exactly-once; surfaced in campaign progress/detail UI; reused-webhook repoint keeps status updates flowing to the correct workspace |
| SUBS-02 | 05-02, 05-03 | Unsubscribe/bounce/spam auto-updates contact status | ✓ SATISFIED | Full suppression state machine, unchanged, 10 passing integration tests |

**Orphaned requirements check:** REQUIREMENTS.md traceability table maps exactly WBHK-01, WBHK-02, WBHK-03, WBHK-04, SUBS-02 to Phase 5. All five appear in at least one plan's `requirements:` frontmatter field (05-01: WBHK-01/03; 05-02: WBHK-02/SUBS-02; 05-03: WBHK-02/WBHK-04/SUBS-02; 05-04: WBHK-01; 05-05: WBHK-04; 05-06: WBHK-03; 05-07: WBHK-01/WBHK-04). No orphans.

### Anti-Patterns Found

No `TBD`/`FIXME`/`XXX`/`TODO`/`HACK`/`PLACEHOLDER` markers found in any of the 6 files modified by the 05-06/05-07 gap-closure commits (checked via targeted grep across `webhook-events.worker.ts`, `sendgrid-webhook-provision.ts`, `sendgrid-key.ts`, `webhook-settings.routes.ts`, and both new/modified test files). No hardcoded-empty stub patterns found. No debt markers blocking this re-verification.

### Human Verification Required

See frontmatter `human_verification` — the same three items carried forward from the prior verification, unaffected by the 05-06/05-07 gap-closure fixes (no web/UI files were touched by either gap-closure plan; `git diff --name-only` between the pre-gap-closure commit and HEAD shows only backend worker/API/test files changed). All three remain explicitly deferred by the plans themselves to end-of-phase human UAT: live SendGrid dashboard confirmation of the auto-provisioned (now workspace-scoped) webhook, live webhook-health card rendering after a real signed event, and the onboarding item's live done-state flip.

### Gaps Summary

Both gaps from the prior verification (2026-07-08) are closed:

1. **WR-01/WR-02 (truth #3, WBHK-03)** — `extractEventRow` in `apps/worker/src/queues/webhook-events.worker.ts` no longer falls back to wall-clock time for a missing/non-numeric `timestamp`, and bounds-checks numeric timestamps against the ECMAScript Date-representable range before construction, eliminating both the dedup-defeating non-determinism and the RangeError-crash/batch-drop risk. Confirmed via direct code read (no wall-clock fallback exists anywhere in the current function) and two passing regression tests that exercise exactly the previously-failing redelivery and out-of-range scenarios against real Postgres fixtures.
2. **CR-01 (truth #1, WBHK-01/WBHK-04)** — `createWebhook` in `apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts` now PATCHes a reused-by-name webhook's `url` to the caller's `callbackUrl` before returning it as active, and `friendly_name` is workspace-scoped (`webhookFriendlyName(workspaceId)`) so two workspaces sharing one BYO SendGrid key can no longer adopt or repoint each other's webhook. Confirmed via direct code read and two passing regression tests (stale-url repoint; cross-workspace non-adoption) against a fetch-mock harness exercising the exact previously-vulnerable scenarios.

No regressions: the full monorepo test suite (60 files, 347 tests) passes cleanly after both fixes, and `apps/api` type-checks cleanly under the new `workspaceId`-threaded signatures.

The phase's overall status moves from `gaps_found` to `human_needed`: all four roadmap Success Criteria and all five requirement IDs (WBHK-01 through WBHK-04, SUBS-02) now have real, passing, codebase-verified coverage with no known unresolved correctness defects. The three remaining items are pre-existing, explicitly-deferred `end-of-phase` human UAT checks (live SendGrid dashboard behavior, live webhook-health card, live onboarding checklist flip) that require a live tenant SendGrid API key and browser observation — they were not part of either gap and are unaffected by the fixes.

---

_Verified: 2026-07-09T11:50:00Z_
_Verifier: Claude (gsd-verifier)_
