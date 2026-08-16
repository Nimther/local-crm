---
status: complete
phase: 15-observability-alerting-frontend-resilience
source: [15-VERIFICATION.md]
started: 2026-08-16T10:45:00Z
updated: 2026-08-17T00:00:00Z
---

## Current Test

[testing complete]

## Tests

### 1. RouteErrorBoundary contained-panel click-through
expected: Force a render throw inside a lazy feature route in a real browser session and observe RouteErrorBoundary's contained panel; shell/nav stay usable; no full-page blank. (No DOM test environment in this repo — apps/web vitest runs with environment "node"; 15-11's SUMMARY flags this as human_judgment.)
result: pass

### 2. Canvas unsaved-changes e2e against live database
expected: Run `apps/web/e2e/flow-unsaved-changes.spec.ts` against a live e2e database — 4/4 Playwright tests pass, matching 15-09-SUMMARY.md's documented run.
result: pass

### 3. Live Sentry DSN provisioning and scrubbed-event confirmation
expected: Provision real Sentry DSNs (SENTRY_DSN_API, SENTRY_DSN_WORKER, VITE_SENTRY_DSN) in the operator's Sentry org; an intentionally-thrown test error in each process appears in its own Sentry project, tagged with workspace_id/request_id, with no secret/PII field. (Live DSNs are operator-supplied at deploy time — decision proceed-live-dsn.)
result: pass

### 4. Grafana Cloud Loki shipping and backstop alerts
expected: Provision Grafana Cloud Loki push credentials and the two documented backstop alert rules (no-logs dead-man's-switch, error-rate spike); Loki receives structured JSON log lines from all three prod-compose services via Alloy, and both rules fire on their documented conditions.
result: issue
reported: "docker/alloy/config.alloy uses # comments; grafana/alloy:v1.18.1 rejects them (illegal character U+0023), so the production Alloy container restart-loops. With a temporary //-corrected config, Loki shipping/correlation works and Grafana rules/contact are provisioned."
severity: blocker

## Summary

total: 4
passed: 3
issues: 1
pending: 0
skipped: 0
blocked: 0

## Gaps

- gap_id: G-15-4
  truth: "Loki receives structured JSON log lines from all three prod-compose services via Alloy, and both backstop alert rules (no-logs dead-man's-switch, error-rate spike) fire on their documented conditions."
  status: failed
  reason: "User reported: docker/alloy/config.alloy uses # comments; grafana/alloy:v1.18.1 rejects them (illegal character U+0023), so the production Alloy container restart-loops. With a temporary //-corrected config, Loki shipping/correlation works and Grafana rules/contact are provisioned."
  severity: blocker
  test: 4
  artifacts: []  # Filled by diagnosis
  missing: []    # Filled by diagnosis
