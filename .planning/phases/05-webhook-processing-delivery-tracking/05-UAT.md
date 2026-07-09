---
status: complete
phase: 05-webhook-processing-delivery-tracking
source: [05-VERIFICATION.md]
started: 2026-07-09T17:57:28Z
updated: 2026-07-09T18:02:56Z
supersedes: "2026-07-09T15:06:36Z round-5 session (2 passed / 1 issue / 1 blocked) — its diagnosed gap (Test 4: campaign metrics zero despite delivered/opened events; root cause: extractEventRow read the nested custom_args wrapper instead of the flattened top-level fields SendGrid actually posts) was closed by gap-closure round 5 (plan 05-13); full record in git history of this file"
---

## Current Test

[testing complete]

## Tests

### 1. Live re-run of Test 4 — campaign metrics increment after the attribution fix
expected: Re-run docs/webhook-live-uat.md Test 4 with a FRESH test-campaign send over a current https tunnel (PUBLIC_APP_URL current, no trailing slash, dev server restarted). After the email is delivered and opened, the campaign detail page shows non-zero delivered/opened counters (no longer stuck at zero), and the new send_events rows have send_id resolved (non-null). "Последнее событие получено" also updates, as before. This is the direct live confirmation of the 05-13 fix (flattened top-level send_id/test extraction).
result: pass

### 2. Scope-limited key warns immediately at connect time
expected: Re-run docs/webhook-live-uat.md Test 2 with a key that GENUINELY lacks the Event Webhook management scope. Connect succeeds (key is valid for mail.send) but an amber inline warning renders immediately ('нет прав на управление вебхуками...') with no doomed SendGrid API call attempted, matching webhookWarningFor('missing_scope'). Carried forward from rounds 4-5: unresolved by any code change, previously blocked by tester access to a genuinely scope-limited SendGrid key — skip again if such a key still cannot be obtained.
result: pass

## Summary

total: 2
passed: 2
issues: 0
pending: 0
skipped: 0
blocked: 0

## Gaps
