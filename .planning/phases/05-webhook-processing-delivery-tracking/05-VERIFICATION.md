---
phase: 05-webhook-processing-delivery-tracking
verified: 2026-07-09T18:10:00Z
status: gaps_found
score: 4/5 truths verified
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: "4/4 truths verified; 3 human_verification items deferred to end-of-phase"
  gaps_closed:
    - "UAT Test 1 (live SendGrid key connect, missing_scope key, silent provisioning failure) — closed by plans 05-08/05-09: redacted logging, connect-time webhook-scope short-circuit, rendered inline warning instead of a bare success toast"
    - "UAT Test 3 (onboarding/reconnect enable-tracking error with no explanation) — closed by plans 05-08/05-09: reconnect no longer returns 200-with-lying-success-toast; the typed provisionError reason is persisted, returned, and rendered in the health card + reconnect toast"
    - "UAT Test 1/3 environmental precondition (localhost PUBLIC_APP_URL, unscoped key) — closed by plan 05-10: docs/webhook-live-uat.md runbook + non-fatal check-env.mjs localhost warning"
  gaps_remaining:
    - "New Critical (CR-01, round-2 code review, 2026-07-09): PATCH-by-stored-webhook-id has no CREATE fallback on a 404 response, permanently wedging provisioning with no self-service recovery for exactly the scenario the Reconnect button is supposed to fix"
  regressions: []
gaps:
  - truth: "SendGrid events arrive on the workspace's per-tenant webhook URL and update each message's status in the send log"
    status: partial
    reason: "provisionEventWebhook (apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts:272-274) unconditionally PATCHes a stored sendgridWebhookId and never falls through to createWebhook when SendGrid answers 404 (id no longer exists on the account). errorForStatus(404) returns 'failed' (only 401/403 map to 'missing_scope'), and every caller then persists the STALE id forward: sendgrid-key.ts:75 and webhook-settings.routes.ts:125 both compute `sendgridWebhookId: result.webhookId ?? existing?.sendgridWebhookId ?? null` — on a plain PATCH-404 failure `result.webhookId` is undefined (that field is only populated on a signed-verification failure, not a PATCH failure), so the stale id is written back unchanged. Every subsequent connect/recheck/reconnect re-PATCHes the same dead id and fails again, forever, with no code path back to `createWebhook`'s reuse-by-name/create machinery. Reachable via two ordinary flows: (1) a tenant rotates their BYO key to a different SendGrid account, or (2) a tenant deletes the platform's webhook in the SendGrid dashboard and clicks 'Переподключить' — the exact remediation the UI and docs/webhook-live-uat.md direct them to. Confirmed by direct code read (apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts lines 265-290, apps/api/src/modules/tenancy/sendgrid-key.ts lines 61-76, apps/api/src/modules/webhooks/webhook-settings.routes.ts lines 109-126) and by absence: no regression test in webhook-provisioning.test.ts covers a stored-id-404 scenario (the file's only 404 test, line 157, covers the unrelated CREATE-path-404-falls-back-to-settings/all case)."
    artifacts:
      - path: "apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts"
        issue: "provisionEventWebhook's existingWebhookId branch calls patchWebhook only; a 404 result is returned as a plain { error: 'failed' } with no fallback to createWebhook's reuse/create logic"
      - path: "apps/api/src/modules/tenancy/sendgrid-key.ts"
        issue: "provisionWebhookBestEffort persists the stale sendgridWebhookId forward on any PATCH failure (result.webhookId is only set on signed-verification failure, not plain PATCH failure), so the dead id is never cleared"
      - path: "apps/api/src/modules/webhooks/webhook-settings.routes.ts"
        issue: "POST reconnect has the identical stale-id-persists-forward defect — the button advertised as the self-heal path cannot self-heal from this specific failure mode"
    missing:
      - "Treat a 404 on PATCH-by-stored-id as 'stored id is stale' and fall through to createWebhook's reuse-or-create path in provisionEventWebhook"
      - "A test: stored id + PATCH 404 + successful CREATE -> result active with the new id persisted (and the stale id is not written back on the fallback-create path)"
      - "Clear or replace the stale sendgridWebhookId in the persisted row once the fallback path succeeds, so the next call PATCHes the correct id"
deferred: []
human_verification:
  - test: "Connect a real tenant SendGrid API key (Restricted Access, with BOTH Mail Send and Mail Settings/Event Webhook scopes, per docs/webhook-live-uat.md) behind a public tunnel and confirm in the SendGrid dashboard that a signed 'Mega CRM Delivery Tracking (<workspace-prefix>)' Event Webhook is created, the tenant's own pre-existing webhooks are untouched, and the connect-time UI shows no warning."
    expected: "A new Event Webhook named 'Mega CRM Delivery Tracking (<workspace-prefix>)' appears in SendGrid -> Settings -> Mail Settings -> Event Webhook, signed verification is enabled, no other webhook entries are modified, and the frontend shows no amber warning / a plain success toast."
    why_human: "Requires a live tunnel + live tenant SendGrid API key with webhook-management scope; not available in an automated verification run. This is the fixed re-run of UAT Test 1 — the code-level fix (05-08/05-09) and the operational runbook (05-10) are both in place and unit/integration-tested, but no fresh live UAT session has been recorded since 05-08/05-09/05-10 landed (05-UAT.md's session predates all three plans' commits)."
  - test: "Connect a SendGrid key that has Mail Send but deliberately lacks the Event Webhook management scope."
    expected: "Connect succeeds (key is valid for mail.send) but an amber inline warning renders immediately ('нет прав на управление вебхуками...') with no doomed SendGrid API call attempted, matching webhookWarningFor('missing_scope')."
    why_human: "Requires a live scope-limited SendGrid key; the deterministic short-circuit is unit-tested (sendgrid-key-webhook-provisioning.test.ts) but the rendered UI copy has not been observed live since the fix landed."
  - test: "For an already-connected (pre-Phase-5) workspace, click Reconnect in the SendGrid settings page after intentionally deleting the platform's webhook in the SendGrid dashboard (simulating the CR-01 scenario above), and separately, on a workspace with a valid webhook, observe the health card and onboarding checklist after a normal successful reconnect."
    expected: "Normal case: the health card shows a connected/active indicator, a non-null 'Последнее событие получено' time after a real event, Reconnect refreshes without error, and the onboarding 'Включить отслеживание доставки' item flips to done. CR-01 case (expected to currently FAIL per the gap above): Reconnect should recover by re-creating the webhook, but will instead repeatedly fail with the same stale-id error — confirms the gap in a live environment rather than only by code read."
    why_human: "Requires a live reconnect flow observed in the browser, deferred per 05-05-PLAN.md's own human-check and further motivated by the newly-found CR-01 defect this round's code review surfaced."
---

# Phase 5: Webhook Processing & Delivery Tracking Verification Report

**Phase Goal:** A marketer's sent emails show accurate, deduplicated delivery outcomes, and bounces/unsubscribes/spam complaints automatically suppress contacts from future sends.
**Verified:** 2026-07-09T18:10:00Z
**Status:** gaps_found
**Re-verification:** Yes — after gap-closure round 2 (plans 05-08, 05-09, 05-10, closing the UAT Test 1/3 silent-provisioning-failure diagnoses)

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1a | SendGrid events arrive on the workspace's per-tenant webhook URL and update each message's status in the send log (steady-state: webhook already provisioned and valid) | ✓ VERIFIED | Route wired (`POST /webhooks/sendgrid/:pathToken`), signature-verified, enqueued, worker applies fact columns idempotently — unchanged since prior verification, `webhooks-signature.test.ts` + `webhook-events-status.test.ts` re-run and pass. |
| 1b | Provisioning failures are diagnosable and self-explanatory to the marketer (UAT Test 1/3 gap-closure) | ✓ VERIFIED | 05-08 added redacted status+body logging on every non-ok SendGrid response; 05-09 added connect-time webhook-scope short-circuit (no doomed call), typed `provisionError` persisted end-to-end, and rendered inline warning / real reconnect error toast / health-card reason (confirmed by direct code read of `sendgrid-key.ts`, `webhook-settings.routes.ts`, `SendGridKeySettings.tsx`, `webhook-notice.ts`); 05-10 added the operational runbook + non-fatal localhost env-checker warning. All confirmed present and wired by direct code read, not just SUMMARY claims. |
| 1c | Reconnect can always self-heal a workspace's webhook provisioning, including when the SendGrid-side webhook was deleted or the key was rotated to a different account | ✗ FAILED | **New (CR-01, round-2 code review, confirmed by direct code read):** `provisionEventWebhook`'s `existingWebhookId` branch (`sendgrid-webhook-provision.ts:272-274`) only ever PATCHes the stored id; a 404 (stale id) is mapped to `{error:'failed'}` with no fallback to `createWebhook`, and every caller (`sendgrid-key.ts:75`, `webhook-settings.routes.ts:125`) writes the stale id back unchanged on failure. Reconnect — the UI's designated remediation — cannot recover from this exact scenario. No test covers it. |
| 2 | A payload with an invalid ECDSA signature is rejected, while a valid one is verified against the raw request body before any parsing | ✓ VERIFIED | Unchanged since prior verification; `webhooks-signature.test.ts` (5 tests) re-run and passes. |
| 3 | Duplicate webhook deliveries (same sg_event_id) do not double-count or corrupt delivery statistics | ✓ VERIFIED | Unchanged since prior verification (WR-01/WR-02 closed by 05-06); `webhook-events-idempotency.test.ts` re-run and passes. |
| 4 | A bounce, spam complaint, or unsubscribe automatically flips the contact's subscription status so subsequent sends skip that contact | ✓ VERIFIED | Unchanged since prior verification; `webhook-events-suppression.test.ts` (10 tests) re-run and passes. |

**Score:** 4/5 distinct truths verified (truth 1 is split into 1a/1b/1c to separate the steady-state pipeline, the UAT-diagnosed presentation/observability gap-closure, and the newly-found reconnect-self-heal defect — 1a and 1b pass, 1c fails).

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts` | Logs redacted status+body on non-ok responses; preserves created webhookId on signed-verification failure; self-heals from a stale stored id | ⚠️ PARTIAL | Logging + id-preservation-on-signed-failure confirmed present (05-08). Self-heal from a PATCH-404 on a stored id is **not implemented** (CR-01) — this is the artifact-level root of gap 1c. |
| `apps/api/src/modules/webhooks/webhook-endpoint.repository.ts` | Threads `provisionError` through read/write path | ✓ VERIFIED | `UpsertWebhookEndpointInput`/`WebhookEndpointRow` carry `provisionError`; confirmed by passing integration tests. |
| `apps/api/src/modules/tenancy/sendgrid-client.ts` | Returns `webhookScopePresent` on the valid result | ✓ VERIFIED | `WEBHOOK_EVENT_SETTINGS_SCOPE_PREFIX` check present (line 30, 65); confirmed by direct code read. |
| `apps/api/src/modules/webhooks/webhook-warning-copy.ts` | Exports `webhookWarningFor` + Russian copy constants, single source of truth for both surfaces | ✓ VERIFIED | New module confirmed present; imported by both `sendgrid-key.ts` and `webhook-settings.routes.ts`. |
| `packages/shared-schemas/src/webhook.ts` | `WebhookHealthResponse` gains `provisionError` | ✓ VERIFIED | `provisionError: z.string().nullable()` confirmed present. |
| `apps/web/src/features/sendgrid-key/webhook-notice.ts` | Pure UI decision helpers for notice/toast | ✓ VERIFIED | `webhookNoticeForKeyResponse`, `reconnectToastForHealth`, `webhookHealthDescription` present; 10/10 unit tests pass. |
| `apps/web/src/features/sendgrid-key/SendGridKeySettings.tsx` | Renders inline warning; reconnect toast reflects real success/error | ✓ VERIFIED | `webhookWarning` state rendered inline (line 318); `reconnectToastForHealth`-driven toast confirmed at lines 89-97; no unconditional success toast remains on the reconnect path. |
| `docs/webhook-live-uat.md` | Documents tunnel + PUBLIC_APP_URL + key-scope preconditions and Test 1-3 steps | ✓ VERIFIED | File present; contains `PUBLIC_APP_URL`, `ngrok`/`cloudflared`, and Mail Settings/Webhook references. |
| `scripts/check-env.mjs` | Non-fatal localhost heads-up pointing at the runbook | ✓ VERIFIED | Localhost/127.0.0.1 regex check + warning confirmed present at lines 90-99; hard-fail behavior for missing vars unchanged. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `sendgrid-client.ts` (`webhookScopePresent`) | `sendgrid-key.ts` (`provisionWebhookBestEffort`) | connect/recheck call sites pass `validation.webhookScopePresent` | ✓ WIRED | Confirmed by direct code read; short-circuit persists `provisionError:'missing_scope'` without a doomed SendGrid call. |
| `webhook-settings.routes.ts` reconnect | `webhookHealthResponseSchema.provisionError` | typed reason mapped through `webhookWarningFor` and returned | ✓ WIRED | Confirmed present at lines 119-134; reconnect no longer discards the reason on failure. |
| `SendGridKeySettings.tsx` | `reconnectToastForHealth` / `webhookHealthDescription` | reconnect `onSuccess` + `CardDescription` | ✓ WIRED | Confirmed at lines 27-28, 89-97, 110. |
| `provisionEventWebhook` (`existingWebhookId` branch) | `createWebhook` reuse/create machinery | **expected** fallback on stale-id 404 | ✗ NOT WIRED | This is the CR-01 gap: the link the reconnect self-heal story depends on does not exist. `patchWebhook`'s 404 result is a dead end. |
| `check-env.mjs` PUBLIC_APP_URL comment | `docs/webhook-live-uat.md` runbook | non-fatal warning text references the doc path | ✓ WIRED | Confirmed by grep. |

### Behavioral Spot-Checks / Test Execution

| Suite | Command | Result | Status |
|-------|---------|--------|--------|
| apps/api webhook/provisioning/sendgrid-key tests | `npm run test -w apps/api -- webhook-provisioning webhook-settings-routes sendgrid-key-webhook-provisioning webhooks-signature` | 4 files, 31 tests passed | ✓ PASS |
| Full monorepo test suite | `npm run test --workspaces --if-present` | 6 workspaces, 59 files, 397 tests, all green | ✓ PASS (no regressions from 05-08/05-09/05-10) |
| `node --check scripts/check-env.mjs` | `node --check scripts/check-env.mjs` | exit 0 | ✓ PASS |
| CR-01 regression coverage check | `grep -n "404" apps/api/src/modules/webhooks/__tests__/webhook-provisioning.test.ts` | Only one 404 test exists, and it covers the unrelated CREATE-path fallback (not the stored-id-PATCH-404 self-heal scenario) | ✗ CONFIRMS GAP — no test exists for the failing scenario |

No probe scripts (`scripts/*/tests/probe-*.sh`) exist or are declared for this phase — Step 7c is not applicable.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|--------------|--------|----------|
| WBHK-01 | 05-01, 05-04, 05-07, 05-08, 05-09, 05-10 | Per-tenant webhook URL + ECDSA signature verification + auto-provisioning, workspace-scoped, diagnosable failures | ⚠️ PARTIALLY SATISFIED | Receiver, signature verification, and provisioning-failure diagnosability/UX are all implemented and tested. The auto-provisioning's self-heal path has a confirmed gap (CR-01) for the stale-stored-id-404 scenario. |
| WBHK-02 | 05-02, 05-03 | delivered/opened/clicked/bounced/unsubscribed/spam/dropped event handling | ✓ SATISFIED | Unchanged; `normalizeEventType` covers every listed event. |
| WBHK-03 | 05-01, 05-06 | Dedup by sg_event_id, no double-counting on replay | ✓ SATISFIED | Dedup constraint + RETURNING gate; WR-01/WR-02 closed by plan 05-06, re-confirmed by passing regression tests this round. |
| WBHK-04 | 05-03, 05-05, 05-07, 05-08, 05-09 | Webhook events update message status + are surfaced to the marketer, including provisioning-failure reasons | ✓ SATISFIED | Fact columns + campaign counters written exactly-once; provisioning failure reasons now surfaced end-to-end in the UI (05-09). |
| SUBS-02 | 05-02, 05-03 | Unsubscribe/bounce/spam auto-updates contact status | ✓ SATISFIED | Full suppression state machine, unchanged, 10 passing integration tests. |

**Orphaned requirements check:** REQUIREMENTS.md traceability table maps exactly WBHK-01, WBHK-02, WBHK-03, WBHK-04, SUBS-02 to Phase 5. All five appear in at least one plan's `requirements:` frontmatter field across all 10 plans (05-01 through 05-10). No orphans.

### Anti-Patterns Found

No `TBD`/`FIXME`/`XXX`/`TODO`/`HACK`/`PLACEHOLDER` markers found in any of the files touched by the 05-08/05-09/05-10 gap-closure commits, nor in `sendgrid-webhook-provision.ts` (the file containing the new CR-01 gap). CR-01 is a logic gap (missing fallback branch), not a debt marker — it does not trip the debt-marker gate, but is reported as a structured gap above per the code-review finding and independent direct-code-read confirmation.

### Human Verification Required

See frontmatter `human_verification`. Three items, distinct from the prior verification's three: the previous three (live dashboard confirmation of a normal connect, live health-card rendering, live onboarding-checklist flip) are superseded by these because (a) the code paths they exercise changed materially in 05-09 (rendering logic, reconnect toast logic) and (b) no fresh live UAT session has been recorded since 05-08/05-09/05-10 landed — `05-UAT.md`'s only session (2026-07-09, 0 passed / 2 issues / 1 blocked) predates all three gap-closure plans' commits. The third item specifically asks a human to reproduce the CR-01 scenario live to corroborate the code-read-confirmed gap in a running environment.

### Gaps Summary

**One new gap this round (CR-01, surfaced by the 2026-07-09 round-2 code review and independently confirmed here by direct code read and by absence of covering tests):**

`provisionEventWebhook` in `apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts` only ever PATCHes a stored `sendgridWebhookId`; a 404 response (the id no longer exists on the SendGrid account) is mapped to a plain `{error:'failed'}` with no fallback to the `createWebhook` reuse-or-create path that already exists and is already exercised for the no-stored-id case. Both production callers (`sendgrid-key.ts` connect/recheck, `webhook-settings.routes.ts` reconnect) then persist the stale id forward on failure, so every subsequent attempt — including a click on "Переподключить," the UI's designated self-heal button — re-PATCHes the same dead id and fails again, forever. This is reachable via two ordinary supported flows: BYO-key rotation to a different SendGrid account, or deleting the platform's webhook in the SendGrid dashboard and clicking Reconnect. In both cases delivery tracking (the entire phase's core value) is permanently dead for that workspace with no self-service recovery.

This gap sits squarely on phase Success Criterion #1 ("SendGrid events... arrive on the workspace's per-tenant webhook URL") because it breaks the one mechanism (Reconnect) the product offers for a marketer to recover from a lost/rotated webhook — an ordinary, expected operational event, not an exotic edge case.

**Everything diagnosed in the prior UAT session (05-UAT.md) is closed:**
1. UAT Test 1 (silent provisioning failure, missing_scope key) — closed by 05-08 (redacted logging) + 05-09 (connect-time scope short-circuit, no doomed call, rendered warning) + 05-10 (documented key-scope precondition).
2. UAT Test 3 (reconnect lying success toast, no explanation) — closed by 05-09 (typed reason threaded through reconnect response, real error toast, health-card reason) + 05-10 (documented localhost-callback precondition).

No regressions: the full monorepo test suite (59 files, 397 tests) passes cleanly after 05-08/05-09/05-10.

The phase's overall status moves from `human_needed` to `gaps_found` because a Critical, code-review-confirmed, and independently-reproduced-by-reading defect exists on the core auto-provisioning path with no test coverage and no fix yet applied. This is a should-fix-before-shipping issue, not a nice-to-have: it undermines the "accurate, deduplicated delivery outcomes" phase goal for any workspace that rotates its SendGrid key or has its webhook deleted on the SendGrid side — a plausible, not exotic, operational scenario. A gap-closure plan should implement the 404-on-stored-id-falls-through-to-create fix (the review's suggested fix is directly actionable) plus the missing regression test before the phase can be marked passed.

---

_Verified: 2026-07-09T18:10:00Z_
_Verifier: Claude (gsd-verifier)_
