---
status: diagnosed
phase: 05-webhook-processing-delivery-tracking
source: [05-VERIFICATION.md]
started: 2026-07-09T13:49:28Z
updated: 2026-07-09T14:18:00Z
supersedes: "2026-07-09T06:50:48Z session (0 passed / 2 issues / 1 blocked) — both its diagnosed gaps were closed by gap-closure rounds 2-3 (plans 05-08..05-11); full record in git history of this file"
---

## Current Test

[testing paused — 1 item outstanding (test 3 blocked by test 2 issue)]

## Tests

### 1. Live SendGrid key connect provisions the workspace-scoped Event Webhook
expected: Connect a real tenant SendGrid API key (Restricted Access, with BOTH Mail Send and Mail Settings/Event Webhook scopes, per docs/webhook-live-uat.md) behind a public tunnel. A signed 'Mega CRM Delivery Tracking (<workspace-prefix>)' Event Webhook appears in the SendGrid dashboard, the tenant's own pre-existing webhooks are untouched, and the connect-time UI shows no warning (plain success toast).
result: issue
reported: "вебхук отсутствует в сендгриде"
severity: major

### 2. Scope-limited key warns immediately at connect time
expected: Connect a SendGrid key that has Mail Send but deliberately lacks the Event Webhook management scope. Connect succeeds (key is valid for mail.send) but an amber inline warning renders immediately ('нет прав на управление вебхуками...') with no doomed SendGrid API call attempted, matching webhookWarningFor('missing_scope').
result: issue
reported: "Вебхуки не подключаются. в консоли npm ошибка [api] provisionEventWebhook [create] non-ok response: 400 {\"errors\":[{\"field\":null,\"message\":\"webhook url must use https\"}]}"
severity: blocker

### 3. Reconnect self-heals a deleted/rotated webhook (CR-01 scenario) + normal reconnect health
expected: For an already-connected workspace, delete the platform's webhook in the SendGrid dashboard (or rotate the BYO key to a different SendGrid account) and click Reconnect ('Переподключить') — now expected to PASS per the 05-11 fix - Reconnect recovers by re-creating the webhook via createWebhook's reuse-or-create path and the health card shows a new active webhook with a fresh id. Separately, on a workspace with a valid webhook, a normal reconnect shows a connected/active health card, a non-null 'Последнее событие получено' time after a real event, no error on refresh, and the onboarding 'Включить отслеживание доставки' item flips to done.
result: blocked
blocked_by: other
reason: "удаляться нечему, так как вебхук не создаётся. в предыдущем тесте показал ошибку — blocked by the test-2 issue (webhook creation fails with 'webhook url must use https'), so there is no webhook to delete/self-heal"

## Summary

total: 3
passed: 0
issues: 2
pending: 0
skipped: 0
blocked: 1

## Gaps

- truth: "Connecting a live SendGrid key provisions a signed 'Mega CRM Delivery Tracking (<workspace-prefix>)' Event Webhook visible in the SendGrid dashboard, leaving other webhooks untouched, with no warning in the UI"
  status: failed
  reason: "User reported: вебхук отсутствует в сендгриде"
  severity: major
  test: 1
  root_cause: "callbackUrl is built verbatim from boot-time env.PUBLIC_APP_URL with no https/scheme enforcement in any layer; during the live run PUBLIC_APP_URL was an http:// URL (likely dev default http://localhost:4000 — .env not updated to the https tunnel URL or server not restarted), so SendGrid rejected the create with 400 'webhook url must use https'. The 400 collapses into the generic 'failed' warning bucket (errorForStatus maps only 401/403 to typed reasons), so the user got only non-actionable retry-later copy right after the louder success toast — webhook silently absent."
  artifacts:
    - path: "apps/api/src/modules/tenancy/sendgrid-key.ts"
      issue: "line 63: builds callbackUrl from env.PUBLIC_APP_URL with no https/scheme check before calling provisionEventWebhook"
    - path: "apps/api/src/modules/webhooks/webhook-settings.routes.ts"
      issue: "line 113: same unguarded URL construction on the reconnect path"
    - path: "apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts"
      issue: "lines 80-82: errorForStatus collapses 400 into generic 'failed' — no typed reason for a URL-validation rejection"
    - path: "apps/api/src/env.ts"
      issue: "line 31: PUBLIC_APP_URL is z.string().url() — accepts http"
    - path: "scripts/check-env.mjs"
      issue: "lines 94-99: warns non-fatally only on localhost/127.0.0.1, never on http:// scheme; wording never mentions SendGrid's https requirement"
  missing:
    - "Pre-flight non-https detection in provisionWebhookBestEffort/provisionEventWebhook (mirror the 05-09 missing_scope short-circuit): persist typed reason 'insecure_url', skip the doomed SendGrid call"
    - "Actionable Russian copy for 'insecure_url' in webhook-warning-copy.ts pointing at PUBLIC_APP_URL / docs/webhook-live-uat.md"
    - "check-env.mjs warning on any http:// PUBLIC_APP_URL (not just localhost) with https-requirement wording"
    - "Optional: env.ts superRefine requiring https for PUBLIC_APP_URL when NODE_ENV=production"
    - "Operator step: re-run live UAT with PUBLIC_APP_URL set to the current https tunnel URL and the dev server restarted (value is read once at boot)"
  debug_session: ".planning/debug/webhook-url-must-use-https.md"

- truth: "Connecting a scope-limited key succeeds with an immediate amber 'missing_scope' warning and no doomed SendGrid API call attempted"
  status: failed
  reason: "User reported: Вебхуки не подключаются. в консоли npm ошибка [api] provisionEventWebhook [create] non-ok response: 400 {\"errors\":[{\"field\":null,\"message\":\"webhook url must use https\"}]} — a create call WAS attempted and SendGrid rejected the webhook URL as non-https"
  severity: blocker
  test: 2
  root_cause: "Same single root cause as test 1: non-https PUBLIC_APP_URL-derived callback URL rejected by SendGrid with 400. Note: the scope-limited scenario was never actually exercised — a 400 (body validation, not 401/403) proves the run's key HAD the webhook scope, so the 05-09 missing_scope short-circuit was correctly bypassed; no missing_scope warning could have rendered for this run. Test 2 must be re-run with a genuinely scope-limited key once the https issue is fixed."
  artifacts:
    - path: "apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts"
      issue: "lines 80-82: 400 maps to untyped 'failed' → generic retry-later copy that can never succeed while PUBLIC_APP_URL stays http"
    - path: "apps/api/src/modules/tenancy/sendgrid-key.ts"
      issue: "line 63: no pre-flight https validation before the SendGrid create call"
  missing:
    - "Same fixes as gap 1 (typed 'insecure_url' pre-flight short-circuit + actionable copy + env checks)"
    - "Re-test scenario 2 with a key that genuinely lacks the Event Webhook scope after the https fix lands"
  debug_session: ".planning/debug/webhook-url-must-use-https.md"
