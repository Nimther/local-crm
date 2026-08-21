---
status: testing
phase: 19-unsubscribe-secret-graceful-rotation
source: [19-VERIFICATION.md]
started: 2026-08-21T00:45:00Z
updated: 2026-08-21T00:45:00Z
---

## Current Test

number: 1
name: Live rotation rehearsal against a real deployment
expected: |
  Run the runbook (docs/runbooks/unsubscribe-secret-rotation.md) Step 1 → Step 2 → Step 3
  (both-eras canary smoke) against the standing canary workspace with real `docker compose`
  restarts and a real env file. Neither api nor worker crash-loops at any restart; both the
  freshly-signed post-rotation link and the retained pre-rotation link redeem successfully.
awaiting: user response

## Tests

### 1. Live rotation rehearsal against a real deployment
expected: Following the runbook's two-step rotation against the canary workspace: no crash-loop at any restart (every intermediate env state passes all three validators); a pre-rotation link captured before Step 1 and a post-rotation link both redeem via POST /unsubscribe/:token; the previous-secret redemption emits the D-05 log line with the `secretPosition` field and no secret values.
result: [pending]

## Summary

total: 1
passed: 0
issues: 0
pending: 1
skipped: 0
blocked: 0

## Gaps
