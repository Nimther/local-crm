---
status: complete
phase: 19-unsubscribe-secret-graceful-rotation
source: [19-VERIFICATION.md]
started: 2026-08-21T00:45:00Z
updated: 2026-08-21T04:39:13Z
---

## Current Test

[testing complete]

## Tests

### 1. Live rotation rehearsal against a real deployment
expected: Following the runbook's two-step rotation against the canary workspace: no crash-loop at any restart (every intermediate env state passes all three validators); a pre-rotation link captured before Step 1 and a post-rotation link both redeem via POST /unsubscribe/:token; the previous-secret redemption emits the D-05 log line with the `secretPosition` field and no secret values.
result: pass
evidence: |
  Production deployment https://crm.nimther.com ran merge SHA
  7bbfc7ea6bc93516da31b16e0fc7bc6fa20f754b. Step 1 staged the new secret
  as verification-only; Step 2 atomically promoted it and moved the former
  primary to previous slot 1. API and worker were force-recreated after each
  step and remained healthy with zero crash-loop evidence; /readyz passed all
  PostgreSQL, Redis, and migration checks.

  The standing canary workspace sent one pre-rotation message to the Phase19
  contact and one post-rotation message to the Phase16 contact. The fresh
  RFC 8058 one-click path changed Phase16 to unsubscribed. The retained old-era
  browser-confirmation path changed Phase19 to unsubscribed after promotion.
  Production API logs contained exactly one previous-secret verification,
  with secretPosition=1 and no other previous slot match. Both canary contacts
  were restored to subscribed after the proof. No token or secret value was
  recorded in this evidence.

## Summary

total: 1
passed: 1
issues: 0
pending: 0
skipped: 0
blocked: 0

## Gaps
