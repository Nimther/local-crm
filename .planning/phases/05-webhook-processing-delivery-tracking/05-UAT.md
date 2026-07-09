---
status: testing
phase: 05-webhook-processing-delivery-tracking
source: [05-VERIFICATION.md]
started: 2026-07-09T06:50:48Z
updated: 2026-07-09T06:50:48Z
---

## Current Test

number: 1
name: Live SendGrid key connect provisions the workspace-scoped Event Webhook
expected: |
  A new (or updated) Event Webhook named 'Mega CRM Delivery Tracking (<workspace-prefix>)'
  appears in SendGrid → Settings → Mail Settings → Event Webhook, signed verification is
  enabled, and no other webhook entries are modified or removed.
awaiting: user response

## Tests

### 1. Live SendGrid key connect provisions the workspace-scoped Event Webhook
expected: Connect a real tenant SendGrid API key and confirm in the SendGrid dashboard that a signed 'Mega CRM Delivery Tracking (<workspace-prefix>)' Event Webhook is created (or PATCHed), the tenant's own pre-existing webhooks are untouched, and the implemented CREATE path (documented vs `.../settings/all` fallback, Open Question A3) matches what the live account actually requires.
result: [pending]

### 2. Webhook-health card reflects a live signed event
expected: After a live SendGrid key connect and a real signed event delivery, the SendGrid settings page's webhook-health card shows a connected/active indicator, a non-null 'Последнее событие получено' relative time once a real event lands, and clicking Reconnect refreshes the card without error.
result: [pending]

### 3. Onboarding checklist shows and completes the delivery-tracking item
expected: For an already-connected (pre-Phase-5) workspace, an 'Включить отслеживание доставки' item appears in the onboarding checklist, links to SendGrid settings when incomplete, and flips to done after enabling/reconnecting tracking.
result: [pending]

## Summary

total: 3
passed: 0
issues: 0
pending: 3
skipped: 0
blocked: 0

## Gaps
