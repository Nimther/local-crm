---
status: testing
phase: 05-webhook-processing-delivery-tracking
source: [05-VERIFICATION.md]
started: 2026-07-09T13:49:28Z
updated: 2026-07-09T13:49:28Z
supersedes: "2026-07-09T06:50:48Z session (0 passed / 2 issues / 1 blocked) — both its diagnosed gaps were closed by gap-closure rounds 2-3 (plans 05-08..05-11); full record in git history of this file"
---

## Current Test

number: 1
name: Live SendGrid key connect provisions the workspace-scoped Event Webhook
expected: |
  A new Event Webhook named 'Mega CRM Delivery Tracking (<workspace-prefix>)' appears in
  SendGrid -> Settings -> Mail Settings -> Event Webhook, signed verification is enabled,
  no other webhook entries are modified, and the frontend shows no amber warning / a plain
  success toast.
awaiting: user response

## Tests

### 1. Live SendGrid key connect provisions the workspace-scoped Event Webhook
expected: Connect a real tenant SendGrid API key (Restricted Access, with BOTH Mail Send and Mail Settings/Event Webhook scopes, per docs/webhook-live-uat.md) behind a public tunnel. A signed 'Mega CRM Delivery Tracking (<workspace-prefix>)' Event Webhook appears in the SendGrid dashboard, the tenant's own pre-existing webhooks are untouched, and the connect-time UI shows no warning (plain success toast).
result: [pending]

### 2. Scope-limited key warns immediately at connect time
expected: Connect a SendGrid key that has Mail Send but deliberately lacks the Event Webhook management scope. Connect succeeds (key is valid for mail.send) but an amber inline warning renders immediately ('нет прав на управление вебхуками...') with no doomed SendGrid API call attempted, matching webhookWarningFor('missing_scope').
result: [pending]

### 3. Reconnect self-heals a deleted/rotated webhook (CR-01 scenario) + normal reconnect health
expected: For an already-connected workspace, delete the platform's webhook in the SendGrid dashboard (or rotate the BYO key to a different SendGrid account) and click Reconnect ('Переподключить') — now expected to PASS per the 05-11 fix - Reconnect recovers by re-creating the webhook via createWebhook's reuse-or-create path and the health card shows a new active webhook with a fresh id. Separately, on a workspace with a valid webhook, a normal reconnect shows a connected/active health card, a non-null 'Последнее событие получено' time after a real event, no error on refresh, and the onboarding 'Включить отслеживание доставки' item flips to done.
result: [pending]

## Summary

total: 3
passed: 0
issues: 0
pending: 3
skipped: 0
blocked: 0

## Gaps
