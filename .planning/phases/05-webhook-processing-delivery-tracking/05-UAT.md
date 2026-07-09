---
status: partial
phase: 05-webhook-processing-delivery-tracking
source: [05-VERIFICATION.md]
started: 2026-07-09T06:50:48Z
updated: 2026-07-09T09:30:00Z
---

## Current Test

[testing paused — 1 blocked item outstanding]

## Tests

### 1. Live SendGrid key connect provisions the workspace-scoped Event Webhook
expected: Connect a real tenant SendGrid API key and confirm in the SendGrid dashboard that a signed 'Mega CRM Delivery Tracking (<workspace-prefix>)' Event Webhook is created (or PATCHed), the tenant's own pre-existing webhooks are untouched, and the implemented CREATE path (documented vs `.../settings/all` fallback, Open Question A3) matches what the live account actually requires.
result: issue
reported: "Вебхука в списке нет"
severity: major

### 2. Webhook-health card reflects a live signed event
expected: After a live SendGrid key connect and a real signed event delivery, the SendGrid settings page's webhook-health card shows a connected/active indicator, a non-null 'Последнее событие получено' relative time once a real event lands, and clicking Reconnect refreshes the card without error.
result: blocked
blocked_by: other
reason: "Блокер — вебхука в списке нет из предыдущего теста (depends on Test 1 fix: webhook never provisioned, so no signed events can arrive)"

### 3. Onboarding checklist shows and completes the delivery-tracking item
expected: For an already-connected (pre-Phase-5) workspace, an 'Включить отслеживание доставки' item appears in the onboarding checklist, links to SendGrid settings when incomplete, and flips to done after enabling/reconnecting tracking.
result: issue
reported: "при попытке включения отслеживания возвращается ошибка"
severity: blocker

## Summary

total: 3
passed: 0
issues: 2
pending: 0
skipped: 0
blocked: 1

## Gaps

- truth: "Connecting a live SendGrid key creates (or PATCHes) a signed 'Mega CRM Delivery Tracking (<workspace-prefix>)' Event Webhook visible in the SendGrid dashboard, without touching pre-existing webhooks"
  status: failed
  reason: "User reported: Вебхука в списке нет"
  severity: major
  test: 1
  root_cause: ""
  artifacts: []
  missing: []
  debug_session: ""

- truth: "For an already-connected (pre-Phase-5) workspace, enabling/reconnecting delivery tracking from the onboarding checklist succeeds and the 'Включить отслеживание доставки' item flips to done"
  status: failed
  reason: "User reported: при попытке включения отслеживания возвращается ошибка"
  severity: blocker
  test: 3
  root_cause: ""
  artifacts: []
  missing: []
  debug_session: ""
