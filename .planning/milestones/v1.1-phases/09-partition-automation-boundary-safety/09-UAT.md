---
status: complete
phase: 09-partition-automation-boundary-safety
source: [09-VERIFICATION.md]
started: 2026-08-06T23:55:00Z
updated: 2026-08-07T00:00:00Z
---

## Current Test

[testing complete]

## Tests

### 1. Operator alert email actually arrives at a real inbox

expected: Exactly one plain-text email arrives at `OPERATOR_ALERT_EMAIL`, naming both `events` and `send_events`, with a per-table buffer number, both DEFAULT row counts, and a timestamp; no workspace id, contact identifier, event payload, or connection string in the body; plain text only. After restoring the horizon, the next poll sends nothing.
result: pass

**How to run it:**

1. Set a real `OPERATOR_ALERT_EMAIL`, plus a verified `PLATFORM_SENDGRID_API_KEY` / `PLATFORM_MAIL_FROM` sender.
2. Boot the stack: `npm run dev`.
3. Manufacture an unhealthy state — drop enough future `events` partitions that the buffer falls below `BUFFER_ALERT_THRESHOLD_MONTHS` (2).
4. Either wait for the watchdog poll (`WATCHDOG_INTERVAL_MS` = 15 min) or restart `apps/api` to force an immediate first poll.
5. Read the inbox.
6. Restore the horizon (restart the worker, or call `ensurePartitions`) and confirm the next poll sends nothing.

**Why this needs a human:** every layer up to and including the `sgMail.send()` call is proven by
injected-`sendMail`-seam tests (13 tests across the tracer and watchdog suites, including the
CR-01 and CR-02 fixes). No test in this phase invokes the real SendGrid API or observes a
delivered message. `OPERATOR_ALERT_EMAIL` is unset in this environment. Plan 09-05 anticipated
this and instructed recording it as outstanding rather than fabricating a pass.

**Worth checking while you are in the inbox:** this is also the first real-world exercise of the
CR-01 fix. A freshly migrated, never-run database should now alert — before the fix it stayed
silent in exactly that case.

## Summary

total: 1
passed: 1
issues: 0
pending: 0
skipped: 0
blocked: 0

## Gaps
