---
phase: 05-webhook-processing-delivery-tracking
verified: 2026-07-09T20:05:00Z
status: human_needed
score: 5/5 truths verified
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: "5/5 truths verified"
  gaps_closed:
    - "Round-4 UAT gaps (Test 1 major + Test 2 blocker, single shared root cause) — closed by plan 05-12 (commits 0e4f67b test, 0a1ef82 feat, 9d9da8a feat, 6cbc268 feat): provisionEventWebhook now short-circuits to { error: 'insecure_url' } before any SendGrid fetch when callbackUrl is not https, on both the create path (no existingWebhookId) and the PATCH/reconnect path (with existingWebhookId); webhookWarningFor maps 'insecure_url' to an actionable Russian warning naming PUBLIC_APP_URL/https/docs/webhook-live-uat.md; webhook-settings.routes.ts's PROVISION_ERROR_REASONS recognizes the new reason instead of silently dropping it; scripts/check-env.mjs warns on any http:// PUBLIC_APP_URL (not just localhost); apps/api/src/env.ts hard-fails a NODE_ENV=production boot with a non-https PUBLIC_APP_URL. All independently re-run and confirmed this round: 5 targeted test files / 37 tests pass, full monorepo suite 61 files / 375 tests pass (0 regressions), tsc build clean, check-env fixture warns+exits 0."
  gaps_remaining: []
  regressions: []
deferred: []
human_verification:
  - test: "Re-run docs/webhook-live-uat.md Test 1 (live key connect provisions the workspace-scoped Event Webhook) with PUBLIC_APP_URL set to a CURRENT https tunnel URL and the dev server restarted."
    expected: "A signed 'Mega CRM Delivery Tracking (<workspace-prefix>)' Event Webhook appears in SendGrid -> Settings -> Mail Settings -> Event Webhook, the tenant's own pre-existing webhooks are untouched, and the connect-time UI shows no warning (plain success toast)."
    why_human: "Requires a live public tunnel + live tenant SendGrid API key; not available in an automated verification run. The round-4 failure (http:// PUBLIC_APP_URL silently rejected by SendGrid) is now closed at the code level — this is the live confirmation that an https PUBLIC_APP_URL actually provisions successfully end-to-end. No live UAT session has been recorded since 05-12 landed (05-UAT.md's last entry is the round-4 failure this plan fixes)."
  - test: "Re-run docs/webhook-live-uat.md Test 2 (scope-limited key warns immediately at connect time) with a key that GENUINELY lacks the Event Webhook management scope (the round-4 run's key had the scope — the 400 that surfaced was a URL-validation rejection, not a scope rejection, so this scenario was never actually exercised)."
    expected: "Connect succeeds (key is valid for mail.send) but an amber inline warning renders immediately ('нет прав на управление вебхуками...') with no doomed SendGrid API call attempted, matching webhookWarningFor('missing_scope')."
    why_human: "Requires a live scope-limited SendGrid key. The deterministic short-circuit is unit-tested (sendgrid-key-webhook-provisioning.test.ts, unchanged by 05-12) but the rendered UI copy has not been observed live with a genuinely scope-limited key since the https fix landed — the prior live attempt was blocked by the unrelated https issue before this scenario could be exercised."
  - test: "Re-run docs/webhook-live-uat.md Test 3 (reconnect self-heals a deleted/rotated webhook + normal reconnect health) now that Test 1's precondition (a successfully provisioned webhook to delete) can be met."
    expected: "CR-01 case: Reconnect recovers by re-creating the webhook via createWebhook's reuse-or-create path and the health card shows a new active webhook with a fresh id. Normal case: the health card shows a connected/active indicator, a non-null 'Последнее событие получено' time after a real event, Reconnect refreshes without error, and the onboarding 'Включить отслеживание доставки' item flips to done."
    why_human: "Requires a live reconnect flow against a real SendGrid account in the browser. Round-4's Test 3 was blocked (not failed) because Test 2's https failure meant there was no webhook to delete/self-heal in the first place; the CR-01 fix itself was already code/test/review-confirmed in round 3 and is unaffected by round 4's fix, but the live end-to-end path has still never been observed to completion since the https blocker is now removed."
  - test: "Confirm PUBLIC_APP_URL in the live UAT environment has no trailing slash (e.g. 'https://tunnel.example.com', not 'https://tunnel.example.com/') before/while re-running the tests above."
    expected: "Webhook events are actually delivered (non-null 'Последнее событие получено'), not just a 'provisionStatus: active' status with zero events arriving."
    why_human: "Flagged by this round's independent code review (05-REVIEW.md WR-05, re-read this round): a trailing-slash PUBLIC_APP_URL produces a callback URL with a double slash (//webhooks/sendgrid/<token>) that SendGrid accepts as valid https (provisioning reports 'active') but Fastify's router 404s on every real delivery (ignoreDuplicateSlashes is unset) — silently reproducing the exact 'looks healthy, delivers nothing' failure class round 4 was closing, via a different misconfiguration. Not a regression introduced by 05-12 (the trailing-slash construction is pre-existing, unmodified code) and not yet fixed in the codebase — a residual risk to be aware of during the live re-run, not a blocker to this round's own scoped fix."
---

# Phase 5: Webhook Processing & Delivery Tracking Verification Report

**Phase Goal:** A marketer's sent emails show accurate, deduplicated delivery outcomes, and bounces/unsubscribes/spam complaints automatically suppress contacts from future sends.
**Verified:** 2026-07-09T20:05:00Z
**Status:** human_needed
**Re-verification:** Yes — after gap-closure round 4 (plan 05-12, closing the shared https-enforcement root cause behind round-4 UAT Test 1/Test 2 failures)

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1a | SendGrid events arrive on the workspace's per-tenant webhook URL and update each message's status in the send log (steady-state: webhook already provisioned and valid) | ✓ VERIFIED | Unchanged since prior verification rounds. Independently re-run this round as part of the 375-test full-suite green run (worker's webhook-events-status equivalent tests). |
| 1b | Provisioning is diagnosable and self-explanatory when it fails, including for a non-https callback URL (round-4 gap) | ✓ VERIFIED | **Round-4 gap closed.** Direct code read of `apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts` line 289-291 confirms a pre-flight `!callbackUrl.startsWith("https://")` guard, placed before the try block, returns `{ error: "insecure_url" }` with zero SendGrid fetch calls. `webhook-warning-copy.ts` line 25-26/31 confirms `WEBHOOK_INSECURE_URL_WARNING` (contains `PUBLIC_APP_URL`, `https`, `docs/webhook-live-uat.md`) is returned by `webhookWarningFor("insecure_url")`. `webhook-settings.routes.ts` line 15-20 confirms `PROVISION_ERROR_REASONS` recognizes `"insecure_url"` so the health card does not silently drop it. Independently re-run this round: `npm run test -w apps/api -- webhook-provisioning webhook-warning-copy webhook-settings-routes env-schema` → 5 files, 37 tests pass (includes 2 new insecure_url provisioning tests, 3 new copy tests, 1 new health-route test, 3 new env-schema tests). |
| 1c | Reconnect can always self-heal a workspace's webhook provisioning, including when the SendGrid-side webhook was deleted or the key was rotated to a different account | ✓ VERIFIED | Unchanged since round 3 (CR-01 fix, 05-11); not touched by 05-12. Re-confirmed present by direct code read this round (`sendgrid-webhook-provision.ts` lines 219, 240, 282-289 — `patchWebhook`'s 404-recoverable fallback to `createWebhook`). |
| 2 | A payload with an invalid ECDSA signature is rejected, while a valid one is verified against the raw request body before any parsing | ✓ VERIFIED | Unchanged; `webhooks-signature.test.ts` re-run this round as part of the full 375-test suite. |
| 3 | Duplicate webhook deliveries (same sg_event_id) do not double-count or corrupt delivery statistics | ✓ VERIFIED | Unchanged; `webhook-events-idempotency.test.ts` re-run this round as part of the worker workspace's 65-test green run. |
| 4 | A bounce, spam complaint, or unsubscribe automatically flips the contact's subscription status so subsequent sends skip that contact | ✓ VERIFIED | Unchanged; `webhook-events-suppression.test.ts` re-run this round as part of the worker workspace's 65-test green run. |

**Score:** 5/5 distinct truths verified (truth 1 remains split into 1a/1b/1c per the established convention; 1b now reflects the round-4 https-enforcement fix instead of the prior missing_scope/provisioning-diagnosability language).

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts` | `ProvisionEventWebhookError` union includes `"insecure_url"`; pre-flight https guard returns `{ error: "insecure_url" }` before any fetch | ✓ VERIFIED | Confirmed by direct code read: line 40 (union), line 289-291 (guard, first statement in `provisionEventWebhook`, before the try block). |
| `apps/api/src/modules/webhooks/webhook-warning-copy.ts` | `WEBHOOK_INSECURE_URL_WARNING` constant + `webhookWarningFor` handles `"insecure_url"`; parameter typed against the exported `ProvisionEventWebhookError` (no more inline literal union) | ✓ VERIFIED | Confirmed: line 25-26 (constant, contains `PUBLIC_APP_URL`, `https`, `docs/webhook-live-uat.md`), line 28 (typed signature), line 31 (branch). |
| `apps/api/src/modules/webhooks/webhook-settings.routes.ts` | `PROVISION_ERROR_REASONS` set includes `"insecure_url"` | ✓ VERIFIED | Confirmed: line 15-20. |
| `apps/api/src/env.ts` | Exports `envSchema`; rejects a non-https `PUBLIC_APP_URL` under `NODE_ENV=production`; dev/test still accept http | ✓ VERIFIED | Confirmed: line 3 (`export const envSchema`), line 60-66 (superRefine issue gated on `NODE_ENV === "production"`). |
| `scripts/check-env.mjs` | Warns (non-fatally) on any `http://` `PUBLIC_APP_URL`, not just localhost | ✓ VERIFIED | Confirmed: line 112-123, case-insensitive-scoped regex `/^http:\/\//i`, still `process.exit(0)`. Independently re-run this round via a fixture `.env` with an http `PUBLIC_APP_URL` — warns and exits 0 (see Behavioral Spot-Checks). |
| `apps/api/src/modules/webhooks/__tests__/webhook-provisioning.test.ts` | Two new tests: http callbackUrl with/without `existingWebhookId`, both asserting `{ error: "insecure_url" }` and zero fetch calls | ✓ VERIFIED | Confirmed present verbatim (lines 358, 369) and passing. |
| `apps/api/src/modules/webhooks/__tests__/webhook-warning-copy.test.ts` (new file) | Copy-mapping + content + regression tests | ✓ VERIFIED | File exists, 3 tests, all pass; regression case explicitly re-confirms the three pre-existing reasons (`missing_scope`, `cap_reached`, `failed`) map unchanged. |
| `apps/api/src/modules/webhooks/__tests__/webhook-settings-routes.test.ts` | New test: seeded `insecure_url` endpoint row surfaces the actionable copy via GET webhook-health | ✓ VERIFIED | Confirmed present (line 313) and passing. |
| `apps/api/src/__tests__/env-schema.test.ts` (new file) | production+http fails / production+https passes / development+http passes | ✓ VERIFIED | File exists, 3 tests, all pass; assertions match the plan's exact scenarios. |
| Carried-forward artifacts (webhook-endpoint.repository.ts, sendgrid-client.ts, webhook-notice.ts, SendGridKeySettings.tsx, docs/webhook-live-uat.md) | Unchanged from prior rounds | ✓ VERIFIED | Not modified by 05-12; carried forward from prior verification with no regression evidence found in this round's full-suite run. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `callbackUrl` scheme | `provisionEventWebhook` pre-flight guard | `!callbackUrl.startsWith("https://")` as the FIRST statement | ✓ WIRED | Confirmed by direct code read, line 289 — fires before any fetch, on both the create path (no `existingWebhookId`) and the PATCH/reconnect path (`existingWebhookId` set), per the two new regression tests. |
| `provisionEventWebhook`'s `{ error: "insecure_url" }` | `sendgrid-key.ts` (`provisionWebhookBestEffort`) / `webhook-settings.routes.ts` (reconnect) persistence | `result.error` written via `upsertWebhookEndpoint({ provisionError: result.error })` | ✓ WIRED | Confirmed unchanged in both callers (neither call site required edits — the new reason flows through the existing `"error" in result` branch). |
| Persisted `provisionError: "insecure_url"` | `webhook-settings.routes.ts`'s health mapper | `PROVISION_ERROR_REASONS.has("insecure_url")` → `provisionErrorMessage` → `webhookWarningFor("insecure_url")` | ✓ WIRED | Confirmed by direct code read (lines 15-20, 33-37) and by the new passing GET webhook-health test seeding exactly this stored value. |
| `webhookWarningFor("insecure_url")` | `WEBHOOK_INSECURE_URL_WARNING` | direct return in the reason-branch chain | ✓ WIRED | Confirmed line 31 of `webhook-warning-copy.ts`; asserted by the new copy test. |
| `scripts/check-env.mjs` http-scheme warning | predev pipeline | non-fatal `console.warn` + `process.exit(0)` unchanged | ✓ WIRED | Confirmed by direct fixture run this round: warns and still exits 0. |
| `env.ts` superRefine PUBLIC_APP_URL rule | module-level `safeParse` + throw on boot | `NODE_ENV === "production" && PUBLIC_APP_URL.startsWith("http://")` → `ctx.addIssue` | ✓ WIRED | Confirmed by direct code read (line 60-66) and by 3 passing env-schema tests exercising all three branches (prod+http fails, prod+https passes, dev+http passes). |

### Behavioral Spot-Checks / Test Execution

| Suite | Command | Result | Status |
|-------|---------|--------|--------|
| Targeted round-4 gap-closure tests (independently re-run this round) | `npm run test -w apps/api -- webhook-provisioning webhook-warning-copy webhook-settings-routes env-schema` | 5 files, 37 tests passed | ✓ PASS |
| apps/api build (independently re-run this round) | `npm run build -w apps/api` | tsc exits 0, no type errors | ✓ PASS |
| check-env fixture (independently re-run this round) | `node scripts/check-env.mjs` against a fixture `.env` with `PUBLIC_APP_URL=http://example.com` | Warns with "https"/"webhook url must use https" wording, then "Env check passed.", exit 0 | ✓ PASS |
| Full monorepo test suite (independently re-run this round) | `npm run test --workspaces --if-present` | 6 workspaces, 61 files, 375 tests, all green (apps/api 36 files/201 tests, apps/web 2/18, apps/worker 13/65, delivery-core 7/54, segments-core 1/19, shared-schemas 2/18) | ✓ PASS (0 regressions from 05-12; +9 tests vs. the prior round's 366, matching the plan's 2+3+1+3 new-test breakdown) |
| Task commit provenance | `git show --stat 0e4f67b 0a1ef82 9d9da8a 6cbc268` | All 4 commits present; file/line-delta counts match SUMMARY's claims (e.g. 0a1ef82: 3 files/38+/3-, including the vitest.config.ts deviation fix) | ✓ CONFIRMS CLOSURE |
| Working tree cleanliness | `git status --short` | empty | ✓ CLEAN |

No probe scripts (`scripts/*/tests/probe-*.sh`) exist or are declared for this phase — Step 7c is not applicable.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|--------------|--------|----------|
| WBHK-01 | 05-01, 05-04, 05-07, 05-08, 05-09, 05-10, 05-11, 05-12 | Per-tenant webhook URL + ECDSA signature verification + auto-provisioning, workspace-scoped, diagnosable failures (including non-https callback URLs), self-healing reconnect | ✓ SATISFIED | All prior capabilities plus the round-4 https pre-flight guard and production-boot env guard are implemented and independently test-confirmed this round. |
| WBHK-02 | 05-02, 05-03 | delivered/opened/clicked/bounced/unsubscribed/spam/dropped event handling | ✓ SATISFIED | Unchanged; not touched by 05-12; re-confirmed in the full-suite run. |
| WBHK-03 | 05-01, 05-06 | Dedup by sg_event_id, no double-counting on replay | ✓ SATISFIED | Unchanged; not touched by 05-12; re-confirmed in the full-suite run. |
| WBHK-04 | 05-03, 05-05, 05-07, 05-08, 05-09, 05-12 | Webhook events update message status + are surfaced to the marketer, including the new insecure_url provisioning-failure reason surfaced end-to-end (health card + connect/recheck/reconnect warning) | ✓ SATISFIED | Round-4 addition (insecure_url) confirmed end-to-end: pre-flight guard → typed reason → persisted → health card → actionable copy, all independently test-confirmed this round. |
| SUBS-02 | 05-02, 05-03 | Unsubscribe/bounce/spam auto-updates contact status | ✓ SATISFIED | Unchanged; not touched by 05-12; re-confirmed in the full-suite run. |

**Orphaned requirements check:** REQUIREMENTS.md traceability table maps exactly WBHK-01, WBHK-02, WBHK-03, WBHK-04, SUBS-02 to Phase 5, all marked `[x]` complete. All five appear in at least one plan's `requirements:` frontmatter field across all 12 plans (05-01 through 05-12; 05-12 declares `[WBHK-01, WBHK-04]`). No orphans.

### Anti-Patterns Found

No `TBD`/`FIXME`/`XXX`/`TODO`/`HACK`/`PLACEHOLDER` markers found in any of the 9 files touched by the 05-12 commits (confirmed by direct grep this round across `sendgrid-webhook-provision.ts`, `webhook-warning-copy.ts`, `webhook-settings.routes.ts`, `env.ts`, `check-env.mjs`, and all 3 test files, plus `vitest.config.ts`).

**Independent code review (05-REVIEW.md, re-read after round 4, re-reviewed 63 files):** Status `issues_found`. No new Critical findings; the round-4 change itself is confirmed correctly wired end-to-end (guard fires before the try block on connect/recheck/reconnect alike; the stored reason round-trips to the health card; the test-env PUBLIC_APP_URL fix removes machine-dependent flakiness). However, the review surfaced two Warning-level findings directly relevant to this round's own change that are worth flagging prominently rather than silently carrying forward alongside the pre-existing WR-01/WR-02:

- **WR-03 (new this round):** the three 05-12 guard layers disagree on scheme case-sensitivity — `env.ts` and `sendgrid-webhook-provision.ts` both use a case-sensitive `.startsWith("http(s)://")`, while `check-env.mjs` correctly uses a case-insensitive regex. A mixed-case scheme (`Https://…`) bypasses the production hard-fail while being misclassified as `insecure_url` by the provisioning guard.
- **WR-05 (new this round):** a trailing slash in `PUBLIC_APP_URL` (pre-existing, unmodified construction at `sendgrid-key.ts:63` / `webhook-settings.routes.ts:114`, not introduced by 05-12) produces a double-slash callback URL that SendGrid accepts as valid https — provisioning reports `active` — but Fastify's router 404s on every real event delivery, silently reproducing the exact "looks healthy, delivers nothing" failure class round 4 was closing, via a different misconfiguration vector.

Both are classified Warning (not Critical) by the reviewer's own severity taxonomy — consistent with the treatment of the three carried-forward Warnings from prior rounds (WR-01: webhook-timestamp replay spoofing the health signal; WR-02: unenforced single-row invariant on `workspace_webhook_endpoints`; WR-04: silent exception-swallowing in `provisionWebhookBestEffort`'s outer catch) — none of which were treated as phase-blocking in this or prior rounds. They are surfaced here as residual risk for the live UAT re-run (see the added 4th human-verification item above) and as a future-hardening backlog item, not as gaps against this round's specific, narrowly-scoped fix (plain lowercase `http://`, no trailing slash — the documented and reproduced round-4 failure mode).

### Human Verification Required

See frontmatter `human_verification`. Four items:
1. Live re-run of UAT Test 1 (connect provisions the webhook) with a current https tunnel — direct confirmation that the round-4 fix resolves the actual live failure it was built for.
2. Live re-run of UAT Test 2 with a genuinely scope-limited key — the round-4 run's key was not actually scope-limited (its 400 was the https rejection, not a scope rejection), so this scenario has still never been exercised live.
3. Live re-run of UAT Test 3 (reconnect self-heal + normal reconnect health) — blocked in round 4 purely because Test 1's precondition (a webhook to delete) couldn't be met; the underlying CR-01 fix itself is unaffected by round 4 and remains code/test/review-confirmed from round 3.
4. A trailing-slash-free `PUBLIC_APP_URL` sanity check during the live re-run, given this round's code-review finding (WR-05) that a trailing slash reproduces a similar silent "active but nothing delivers" failure mode through an unfixed, different code path.

No fresh live UAT session has been recorded since 05-12 landed — `05-UAT.md`'s only entries predate this fix.

### Gaps Summary

No code-level gaps remain for the two round-4 UAT failures. Both shared the single root cause (non-https `PUBLIC_APP_URL` rejected by SendGrid with `400 "webhook url must use https"`), and it is closed at every layer:

- **Pre-flight short-circuit:** `provisionEventWebhook` never makes a doomed SendGrid call for a non-https `callbackUrl`, on create OR patch/reconnect — confirmed by direct code read and two independently-passing regression tests.
- **Actionable copy:** the new `insecure_url` reason maps to a curated Russian warning naming the exact env var, the https requirement, and the runbook — confirmed by 3 independently-passing tests.
- **Health-card recognition:** the persisted reason is recognized by the health mapper instead of being silently dropped — confirmed by an independently-passing test.
- **Defense-in-depth:** a predev warning fires on any http scheme (not just localhost), and a production boot hard-fails on a non-https `PUBLIC_APP_URL` — confirmed by an independently-passing fixture run and 3 independently-passing schema tests.
- **No regressions:** full monorepo suite (61 files / 375 tests, +9 vs. the prior round) is green; build is clean; working tree is clean.

The phase's overall status remains `human_needed` (unchanged from the prior round, for a different and now-updated set of reasons): all must-have truths — including the round-4 fix itself — are verified by code, test, and independent review, but the live SendGrid environment confirmation (the actual purpose of round-4's fix: does a real connect now succeed with an https tunnel?) has not yet been re-run since the fix landed. This round's independent code review also surfaced two new Warning-level residual risks (case-sensitivity of the scheme check, trailing-slash callback URLs) that are not blockers to this round's narrowly-scoped fix but are worth carrying into the live re-run and a future hardening pass.

---

_Verified: 2026-07-09T20:05:00Z_
_Verifier: Claude (gsd-verifier)_
