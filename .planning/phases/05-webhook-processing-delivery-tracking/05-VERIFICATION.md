---
phase: 05-webhook-processing-delivery-tracking
verified: 2026-07-09T18:55:00Z
status: human_needed
score: 5/5 truths verified
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: "4/5 truths verified"
  gaps_closed:
    - "CR-01 (round-2 code review, PATCH-by-stored-id had no CREATE fallback on 404, permanently wedging provisioning) — closed by plan 05-11 (commits 27c52d5 test, fc7735c fix): patchWebhook marks a 404 recoverable:true; provisionEventWebhook's existingWebhookId branch falls through exactly once to createWebhook's reuse-or-create path; the new id reaches persistence on both the success path (result.id) and the signed-failure path (result.webhookId) in both callers (sendgrid-key.ts, webhook-settings.routes.ts) with zero caller edits required; two new regression tests pin the behavior and pass."
  gaps_remaining: []
  regressions: []
deferred: []
human_verification:
  - test: "Connect a real tenant SendGrid API key (Restricted Access, with BOTH Mail Send and Mail Settings/Event Webhook scopes, per docs/webhook-live-uat.md) behind a public tunnel and confirm in the SendGrid dashboard that a signed 'Mega CRM Delivery Tracking (<workspace-prefix>)' Event Webhook is created, the tenant's own pre-existing webhooks are untouched, and the connect-time UI shows no warning."
    expected: "A new Event Webhook named 'Mega CRM Delivery Tracking (<workspace-prefix>)' appears in SendGrid -> Settings -> Mail Settings -> Event Webhook, signed verification is enabled, no other webhook entries are modified, and the frontend shows no amber warning / a plain success toast."
    why_human: "Requires a live tunnel + live tenant SendGrid API key with webhook-management scope; not available in an automated verification run. No fresh live UAT session has been recorded since 05-08/05-09/05-10 landed (05-UAT.md's session predates all gap-closure commits, including 05-11)."
  - test: "Connect a SendGrid key that has Mail Send but deliberately lacks the Event Webhook management scope."
    expected: "Connect succeeds (key is valid for mail.send) but an amber inline warning renders immediately ('нет прав на управление вебхуками...') with no doomed SendGrid API call attempted, matching webhookWarningFor('missing_scope')."
    why_human: "Requires a live scope-limited SendGrid key; the deterministic short-circuit is unit-tested (sendgrid-key-webhook-provisioning.test.ts) but the rendered UI copy has not been observed live since the fix landed."
  - test: "For an already-connected workspace, delete the platform's webhook in the SendGrid dashboard (or rotate the BYO key to a different SendGrid account) and click Reconnect in the SendGrid settings page — the exact CR-01 scenario — then, separately, on a workspace with a valid webhook, observe the health card and onboarding checklist after a normal successful reconnect."
    expected: "CR-01 case (now expected to PASS, not fail, per the 05-11 fix): Reconnect recovers by re-creating the webhook via createWebhook's reuse-or-create path and the health card shows a new active webhook with a fresh id — no more permanent wedge. Normal case: the health card shows a connected/active indicator, a non-null 'Последнее событие получено' time after a real event, Reconnect refreshes without error, and the onboarding 'Включить отслеживание доставки' item flips to done."
    why_human: "Requires a live reconnect flow observed against a real SendGrid account in the browser. The fix (05-11) is confirmed by direct code read, two passing unit-level regression tests, and an independent round-3 code review that traced the fallback end-to-end with 0 new Critical/Warning findings — but no live SendGrid environment has exercised the actual 404-recovery path end-to-end yet. This live check is now confirmatory of an already-fixed and code/test-verified path, not a reproduction of a known-failing scenario as in the prior verification round."
---

# Phase 5: Webhook Processing & Delivery Tracking Verification Report

**Phase Goal:** A marketer's sent emails show accurate, deduplicated delivery outcomes, and bounces/unsubscribes/spam complaints automatically suppress contacts from future sends.
**Verified:** 2026-07-09T18:55:00Z
**Status:** human_needed
**Re-verification:** Yes — after gap-closure round 3 (plan 05-11, closing CR-01: reconnect self-heal for a stale stored webhook id)

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1a | SendGrid events arrive on the workspace's per-tenant webhook URL and update each message's status in the send log (steady-state: webhook already provisioned and valid) | ✓ VERIFIED | Unchanged since prior verification. `webhooks-signature.test.ts` + worker's `webhook-events-status.test.ts` re-run and pass (confirmed in this round's full-suite run). |
| 1b | Provisioning failures are diagnosable and self-explanatory to the marketer (UAT Test 1/3 gap-closure) | ✓ VERIFIED | Unchanged since prior verification (05-08/05-09/05-10). Confirmed by direct code read this round: `sendgrid-key.ts` and `webhook-settings.routes.ts` were **not modified** by 05-11 (only `sendgrid-webhook-provision.ts` and its test file changed — `git show fc7735c --stat` shows 1 file, 23 insertions/5 deletions), so all prior diagnosability behavior is intact and unregressed. |
| 1c | Reconnect can always self-heal a workspace's webhook provisioning, including when the SendGrid-side webhook was deleted or the key was rotated to a different account | ✓ VERIFIED | **CR-01 closed.** Direct code read of `apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts` lines 219, 240, 282-289 confirms: `patchWebhook` returns `recoverable: res.status === 404` alongside its typed error (only for 404 — 401/403/5xx stay non-recoverable, `errorForStatus` unchanged); `provisionEventWebhook`'s `existingWebhookId` branch falls through exactly once to `createWebhook`'s reuse-or-create path when `recoverable` is true, otherwise normalizes to `{ error: patchResult.error }`. Two new regression tests (`webhook-provisioning.test.ts:304-356`) independently re-run this round: `npm run test -w apps/api -- webhook-provisioning webhook-settings-routes sendgrid-key-webhook-provisioning webhooks-signature` → 4 files, 33 tests passed (31 baseline + 2 new). Callers (`sendgrid-key.ts:75,85`; `webhook-settings.routes.ts:125,140`) confirmed unchanged and already persist `result.id` on success / `result.webhookId ?? existing?.sendgridWebhookId ?? null` on failure — both paths write the NEW id, never the stale one. Independently corroborated by 05-REVIEW.md round 3 (traced the same fallback end-to-end, 0 new Critical/Warning findings on the 05-11 diff). |
| 2 | A payload with an invalid ECDSA signature is rejected, while a valid one is verified against the raw request body before any parsing | ✓ VERIFIED | Unchanged since prior verification; `webhooks-signature.test.ts` re-run this round and passes (included in the 33-test targeted run and the 366-test full run). |
| 3 | Duplicate webhook deliveries (same sg_event_id) do not double-count or corrupt delivery statistics | ✓ VERIFIED | Unchanged since prior verification (WR-01/WR-02 closed by 05-06); `webhook-events-idempotency.test.ts` re-run this round as part of the worker workspace's 65-test green run. |
| 4 | A bounce, spam complaint, or unsubscribe automatically flips the contact's subscription status so subsequent sends skip that contact | ✓ VERIFIED | Unchanged since prior verification; `webhook-events-suppression.test.ts` re-run this round as part of the worker workspace's 65-test green run. |

**Score:** 5/5 distinct truths verified (truth 1 remains split into 1a/1b/1c per the prior round's convention; 1c now passes with 1a/1b).

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts` | Logs redacted status+body on non-ok responses; preserves created webhookId on signed-verification failure; self-heals from a stale stored id | ✓ VERIFIED | All three behaviors confirmed present by direct code read this round: logging (line 100-104, unchanged), id-preservation-on-signed-failure (line 297-300, unchanged), and the new self-heal fallback (line 219, 240, 282-289 — this round's fix). |
| `apps/api/src/modules/webhooks/__tests__/webhook-provisioning.test.ts` | Regression tests for the stored-id-404 fallback (create-success and signed-failure-after-fallback) | ✓ VERIFIED | Both test titles present verbatim as specified in 05-11-PLAN.md (lines 304, 333); both pass in the targeted and full-suite runs this round. |
| `apps/api/src/modules/webhooks/webhook-endpoint.repository.ts` | Threads `provisionError` through read/write path | ✓ VERIFIED | Unchanged; carried forward from prior verification. |
| `apps/api/src/modules/tenancy/sendgrid-client.ts` | Returns `webhookScopePresent` on the valid result | ✓ VERIFIED | Unchanged; carried forward from prior verification. |
| `apps/api/src/modules/webhooks/webhook-warning-copy.ts` | Exports `webhookWarningFor` + Russian copy constants | ✓ VERIFIED | Unchanged; carried forward from prior verification. |
| `packages/shared-schemas/src/webhook.ts` | `WebhookHealthResponse` gains `provisionError` | ✓ VERIFIED | Unchanged; carried forward from prior verification. |
| `apps/web/src/features/sendgrid-key/webhook-notice.ts` | Pure UI decision helpers for notice/toast | ✓ VERIFIED | Unchanged; carried forward from prior verification. |
| `apps/web/src/features/sendgrid-key/SendGridKeySettings.tsx` | Renders inline warning; reconnect toast reflects real success/error | ✓ VERIFIED | Unchanged; carried forward from prior verification. |
| `docs/webhook-live-uat.md` | Documents tunnel + PUBLIC_APP_URL + key-scope preconditions and Test 1-3 steps | ✓ VERIFIED | Unchanged; carried forward from prior verification. |
| `scripts/check-env.mjs` | Non-fatal localhost heads-up pointing at the runbook | ✓ VERIFIED | Unchanged; carried forward from prior verification. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `patchWebhook` 404 result (`recoverable: true`) | `provisionEventWebhook`'s existing-id branch | `"error" in patchResult && patchResult.recoverable` guard | ✓ WIRED | Confirmed by direct code read, line 285. |
| `provisionEventWebhook` existing-id branch (recoverable) | `createWebhook` reuse/create machinery | `await createWebhook(apiKey, callbackUrl, workspaceId)` | ✓ WIRED | Confirmed by direct code read, line 286 — this is the link the prior round found `NOT WIRED`; it is now wired and covered by two passing regression tests. |
| `provisionEventWebhook` fallback success (`{ id: newId }`) | Caller persistence (`sendgrid-key.ts`, `webhook-settings.routes.ts`) | `result.id` on the success branch | ✓ WIRED | Confirmed unchanged in both callers; the NEW id (not the stale one) is what gets written. |
| `provisionEventWebhook` fallback + signed-failure (`{ error, webhookId: newId }`) | Caller persistence | `result.webhookId ?? existing?.sendgridWebhookId ?? null` on the failure branch | ✓ WIRED | Confirmed unchanged in both callers; `result.webhookId` is populated with the NEW id after a fallback, so it wins over the nullish-coalesced stale id. |
| `sendgrid-client.ts` (`webhookScopePresent`) | `sendgrid-key.ts` (`provisionWebhookBestEffort`) | connect/recheck call sites | ✓ WIRED | Unchanged; carried forward. |
| `webhook-settings.routes.ts` reconnect | `webhookHealthResponseSchema.provisionError` | typed reason mapped through `webhookWarningFor` | ✓ WIRED | Unchanged; carried forward. |

### Behavioral Spot-Checks / Test Execution

| Suite | Command | Result | Status |
|-------|---------|--------|--------|
| apps/api webhook/provisioning/sendgrid-key tests (independently re-run this round) | `npm run test -w apps/api -- webhook-provisioning webhook-settings-routes sendgrid-key-webhook-provisioning webhooks-signature` | 4 files, 33 tests passed (31 baseline + 2 new CR-01 regression tests) | ✓ PASS |
| Full monorepo test suite (independently re-run this round) | `npm run test --workspaces --if-present` | 6 workspaces, 59 files, 366 tests, all green (apps/api 34 files/192 tests, apps/web 2/18, apps/worker 13/65, delivery-core 7/54, segments-core 1/19, shared-schemas 2/18) | ✓ PASS (no regressions from 05-11) |
| CR-01 regression coverage check | `grep -n "a stale stored id (PATCH 404)" apps/api/src/modules/webhooks/__tests__/webhook-provisioning.test.ts` | Both new test titles present verbatim (lines 304, 333) | ✓ CONFIRMS CLOSURE |
| Working tree cleanliness (confirms no stray uncommitted state) | `git status --short` | empty | ✓ CLEAN |

**Data-accuracy note:** The prior verification's "397 tests" full-suite figure was stale (a pre-existing discrepancy unrelated to 05-11, as also flagged in 05-11-SUMMARY.md's Issues Encountered section). The accurate, independently-confirmed count in this environment is **59 test files, 366 tests total across 6 workspaces**, with apps/api at 192 tests after the 2 new regression tests (190 baseline + 2).

No probe scripts (`scripts/*/tests/probe-*.sh`) exist or are declared for this phase — Step 7c is not applicable.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|--------------|--------|----------|
| WBHK-01 | 05-01, 05-04, 05-07, 05-08, 05-09, 05-10, 05-11 | Per-tenant webhook URL + ECDSA signature verification + auto-provisioning, workspace-scoped, diagnosable failures, self-healing reconnect | ✓ SATISFIED | Receiver, signature verification, provisioning-failure diagnosability/UX, and now the reconnect self-heal path (CR-01, closed by 05-11) are all implemented and tested. No remaining gap. |
| WBHK-02 | 05-02, 05-03 | delivered/opened/clicked/bounced/unsubscribed/spam/dropped event handling | ✓ SATISFIED | Unchanged; `normalizeEventType` covers every listed event. |
| WBHK-03 | 05-01, 05-06 | Dedup by sg_event_id, no double-counting on replay | ✓ SATISFIED | Unchanged; dedup constraint + RETURNING gate; re-confirmed by passing regression tests this round. |
| WBHK-04 | 05-03, 05-05, 05-07, 05-08, 05-09 | Webhook events update message status + are surfaced to the marketer, including provisioning-failure reasons | ✓ SATISFIED | Unchanged; fact columns + campaign counters written exactly-once; provisioning failure reasons surfaced end-to-end in the UI. |
| SUBS-02 | 05-02, 05-03 | Unsubscribe/bounce/spam auto-updates contact status | ✓ SATISFIED | Unchanged; full suppression state machine, 10 passing integration tests, re-confirmed this round as part of the worker's 65-test green run. |

**Orphaned requirements check:** REQUIREMENTS.md traceability table maps exactly WBHK-01, WBHK-02, WBHK-03, WBHK-04, SUBS-02 to Phase 5, all marked `[x]` complete. All five appear in at least one plan's `requirements:` frontmatter field across all 11 plans (05-01 through 05-11). No orphans.

### Anti-Patterns Found

No `TBD`/`FIXME`/`XXX`/`TODO`/`HACK`/`PLACEHOLDER` markers found in either file touched by the 05-11 commits (`sendgrid-webhook-provision.ts`, `webhook-provisioning.test.ts`), confirmed by direct grep this round. CR-01 was a logic gap (missing fallback branch), now closed — it never tripped the debt-marker gate and does not now.

**Independent code review (05-REVIEW.md, round 3, re-read this round):** 0 new Critical or Warning findings on the 05-11 diff. One new Info-level finding (IN-08): the internal `recoverable` marker is not normalized away on every code path inside `createWebhook`'s own reuse-PATCH branch (a narrow edge case: the reused webhook is deleted between LIST and PATCH) — today's callers only read `.error`/`.webhookId` so this is harmless at runtime, but the module's own normalization invariant claim is not fully enforced. This is an internal-typing nit, not a functional defect, and does not block the phase goal — it is noted here for future-plan awareness, not as a phase gap. The five carried-forward Warnings (WR-01 through WR-05, all pre-existing and unrelated to 05-11's scope) remain open but were not raised as blocking Phase 5's goal in either the prior or this verification round; they concern 401/403 copy precision, a provisioning-row race, silent DB-error swallowing, an unbounded-batch-insert edge case, and stale health-card caching respectively — all worth a future hardening pass but none contradict the phase's core observable truths.

### Human Verification Required

See frontmatter `human_verification`. Three items, carried forward from the prior round with the third updated to reflect the fix: the first two (live dashboard confirmation of a normal connect, live scope-limited-key warning rendering) are unchanged in substance since no code paths they exercise were touched by 05-11. The third item is the direct re-run of the CR-01 scenario in a live SendGrid environment — previously documented as "expected to currently FAIL," now updated to "expected to PASS" since the fix is code-read-confirmed, unit-tested (2 new regression tests), and independently code-reviewed end-to-end. No fresh live UAT session has been recorded since 05-08/05-09/05-10/05-11 landed (`05-UAT.md`'s only session predates all of them).

### Gaps Summary

No gaps remain. The single gap from the prior round (CR-01: `provisionEventWebhook`'s stored-id PATCH had no 404 fallback, permanently wedging Reconnect) is closed:

- **Fix verified by direct code read:** `patchWebhook` marks a 404 `recoverable: true`; `provisionEventWebhook`'s existing-id branch falls through exactly once to `createWebhook`'s reuse-or-create path on that signal; the normalization back to the narrow `{ id } | { error }` shape on the primary paths is confirmed, keeping the public contract of `provisionEventWebhook` unchanged.
- **Fix verified by independently-run tests:** both new regression tests (stored-id 404 → CREATE success → new id; stored-id 404 → CREATE success → signed 403 → new id preserved alongside the error) pass in a fresh run this round, alongside the 31 pre-existing cases in the same file (33/33) and the full monorepo suite (366/366, 0 regressions).
- **Fix independently corroborated:** the round-3 code review (05-REVIEW.md) traced the identical code paths end-to-end and confirms 0 new Critical/Warning findings, with only a narrow Info-level normalization nit that does not affect today's caller behavior.

The phase's overall status moves from `gaps_found` to `human_needed`: all must-have truths are now verified by code, test, and independent review, but three items require a live SendGrid environment to observe end-to-end (a real connect, a real scope-limited key, and a real reconnect-after-deletion) that automated verification cannot exercise. These are the same class of item deferred at the end of every prior round for this phase — none are new defects, they are the final live-environment confirmation gate before shipping.

---

_Verified: 2026-07-09T18:55:00Z_
_Verifier: Claude (gsd-verifier)_
