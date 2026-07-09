---
status: diagnosed
phase: 05-webhook-processing-delivery-tracking
source: [05-VERIFICATION.md]
started: 2026-07-09T06:50:48Z
updated: 2026-07-09T10:15:00Z
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
  root_cause: "Provisioning IS invoked on key connect, but every SendGrid Event Webhook create call returned non-ok and the failure is swallowed at three layers (no logging of status/body, webhookWarning never rendered in UI, typed error not persisted) — user sees success toast while DB shows provision_status='error', sendgrid_webhook_id=NULL. Most probable proximate cause: tenant BYO key is a restricted key without Event Webhook management scopes (403 missing_scope) — in-app copy asks only for 'Mail Send' access and validateTenantSendGridKey checks only mail.send. Secondary: PUBLIC_APP_URL=http://localhost:4000 produces a callback URL SendGrid cannot accept/deliver to."
  artifacts:
    - path: "apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts"
      issue: "maps all non-ok SendGrid responses to typed errors without logging status/body — failures undiagnosable"
    - path: "apps/web/src/features/sendgrid-key/SendGridKeySettings.tsx"
      issue: "never reads/renders webhookWarning from connect/recheck responses; unconditional success toast"
    - path: "apps/api/src/modules/tenancy/sendgrid-client.ts"
      issue: "validateTenantSendGridKey fetches full scopes list but only checks mail.send — webhook scopes never verified"
    - path: "apps/api/src/modules/tenancy/sendgrid-key.ts"
      issue: "provisionWebhookBestEffort drops a successfully-created webhook id if signed-verification step fails (latent secondary bug)"
  missing:
    - "Log redacted SendGrid status + error body on every non-ok provisioning response"
    - "Persist typed provisioning error reason (e.g. provision_error column) so UI/health card can show why"
    - "Render webhookWarning in frontend after connect/recheck"
    - "Check webhook-management scopes in validateTenantSendGridKey and surface deterministic 'key lacks Webhook Settings permission' message"
    - "Document that PUBLIC_APP_URL must be publicly reachable (tunnel) and key needs Event Webhook scopes for live UAT"
    - "Persist created webhook id even when signed-verification step fails"
  debug_session: ".planning/debug/sendgrid-webhook-not-provisioned.md"

- truth: "For an already-connected (pre-Phase-5) workspace, enabling/reconnecting delivery tracking from the onboarding checklist succeeds and the 'Включить отслеживание доставки' item flips to done"
  status: failed
  reason: "User reported: при попытке включения отслеживания возвращается ошибка"
  severity: blocker
  test: 3
  root_cause: "Same underlying defect as Test 1 (SendGrid create call fails on every attempt — leading cause: callback URL built from PUBLIC_APP_URL=http://localhost:4000 which SendGrid rejects; compounding: webhook-management scope never validated) PLUS a distinct error-presentation defect: the reconnect route returns HTTP 200 with provisionStatus:'error', so reconnectMutation.onSuccess fires a success toast while the badge flips to 'Ошибка' — the error the user saw — with no explanation, and the typed error discriminator is discarded by the handler."
  artifacts:
    - path: "apps/api/src/modules/webhooks/webhook-settings.routes.ts"
      issue: "reconnect returns 200 on provisioning failure and discards the typed error reason"
    - path: "apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts"
      issue: "non-ok SendGrid responses (status/body) never logged; failure modes indistinguishable after the fact"
    - path: "apps/web/src/features/sendgrid-key/SendGridKeySettings.tsx"
      issue: "success toast on failed reconnect; webhookWarning never rendered (KeyMutationResponse omits it)"
    - path: ".env"
      issue: "PUBLIC_APP_URL=http://localhost:4000 makes live webhook provisioning impossible (environmental precondition)"
  missing:
    - "Propagate typed provisioning error through the reconnect response (non-2xx or error field using existing webhookWarningFor copy) and render it instead of unconditional success toast"
    - "Log redacted SendGrid status+body on non-ok provisioning responses; persist typed error alongside provision_status"
    - "Run live UAT behind a public tunnel (ngrok) with PUBLIC_APP_URL set to the tunnel URL"
    - "Verify webhook-settings scope at connect time so scope-lacking keys warn immediately"
  debug_session: ".planning/debug/enable-delivery-tracking-error.md"
