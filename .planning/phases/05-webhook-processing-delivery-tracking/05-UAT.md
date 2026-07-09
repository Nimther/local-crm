---
status: testing
phase: 05-webhook-processing-delivery-tracking
source: [05-VERIFICATION.md]
started: 2026-07-09T15:06:36Z
updated: 2026-07-09T15:06:36Z
supersedes: "2026-07-09T13:49:28Z round-4 session (0 passed / 2 issues / 1 blocked) — both its diagnosed gaps (shared root cause: non-https PUBLIC_APP_URL rejected by SendGrid) were closed by gap-closure round 4 (plan 05-12); full record in git history of this file"
---

## Current Test

number: 1
name: Live key connect provisions the workspace-scoped Event Webhook over an https tunnel
expected: |
  A signed 'Mega CRM Delivery Tracking (<workspace-prefix>)' Event Webhook appears in
  SendGrid -> Settings -> Mail Settings -> Event Webhook, the tenant's own pre-existing
  webhooks are untouched, and the connect-time UI shows no warning (plain success toast).
awaiting: user response

## Tests

### 1. Live key connect provisions the workspace-scoped Event Webhook over an https tunnel
expected: Re-run docs/webhook-live-uat.md Test 1 with PUBLIC_APP_URL set to a CURRENT https tunnel URL and the dev server restarted. A signed 'Mega CRM Delivery Tracking (<workspace-prefix>)' Event Webhook appears in SendGrid -> Settings -> Mail Settings -> Event Webhook, the tenant's own pre-existing webhooks are untouched, and the connect-time UI shows no warning (plain success toast).
result: [pending]

### 2. Scope-limited key warns immediately at connect time
expected: Re-run docs/webhook-live-uat.md Test 2 with a key that GENUINELY lacks the Event Webhook management scope (the round-4 key had the scope — its 400 was the https rejection, so this scenario was never actually exercised). Connect succeeds (key is valid for mail.send) but an amber inline warning renders immediately ('нет прав на управление вебхуками...') with no doomed SendGrid API call attempted, matching webhookWarningFor('missing_scope').
result: [pending]

### 3. Reconnect self-heals a deleted/rotated webhook + normal reconnect health
expected: Re-run docs/webhook-live-uat.md Test 3 now that Test 1's precondition (a successfully provisioned webhook to delete) can be met. CR-01 case: Reconnect recovers by re-creating the webhook via createWebhook's reuse-or-create path and the health card shows a new active webhook with a fresh id. Normal case: the health card shows a connected/active indicator, a non-null 'Последнее событие получено' time after a real event, Reconnect refreshes without error, and the onboarding 'Включить отслеживание доставки' item flips to done.
result: [pending]

### 4. PUBLIC_APP_URL has no trailing slash during the live re-run
expected: Confirm PUBLIC_APP_URL in the live UAT environment has no trailing slash (e.g. 'https://tunnel.example.com', not 'https://tunnel.example.com/') before/while re-running the tests above. Webhook events are actually delivered (non-null 'Последнее событие получено'), not just a 'provisionStatus: active' status with zero events arriving. (Flagged by 05-REVIEW.md WR-05: a trailing slash produces a //webhooks/... callback that SendGrid accepts but Fastify 404s — residual risk to watch, not a blocker.)
result: [pending]

## Summary

total: 4
passed: 0
issues: 0
pending: 4
skipped: 0
blocked: 0

## Gaps
