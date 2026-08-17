---
status: complete
phase: 15-observability-alerting-frontend-resilience
source: [15-VERIFICATION.md]
started: 2026-08-16T10:45:00Z
updated: 2026-08-17T09:00:00Z
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

### 5. Production redeploy with the committed config.alloy
expected: Redeploy the prod compose stack with the committed docker/alloy/config.alloy and confirm the `alloy` container runs (not Restarting) and structured log lines keep arriving in Grafana Cloud Loki. (The UAT-session confirmation in test 4 was against a temporary //-corrected config applied ad hoc; the committed file was independently proven to parse cleanly under the pinned grafana/alloy:v1.18.1 binary — exit 0 — so this confirms the exact committed bytes in the live path.)
result: pass

## Summary

total: 5
passed: 4
issues: 1
pending: 0
skipped: 0
blocked: 0

## Gaps

- gap_id: G-15-4
  truth: "Loki receives structured JSON log lines from all three prod-compose services via Alloy, and both backstop alert rules (no-logs dead-man's-switch, error-rate spike) fire on their documented conditions."
  status: resolved
  resolved_by: "plan 15-22 (2026-08-17): docker/alloy/config.alloy converted to // comments (0 leading # lines, was 88); scripts/validate-alloy-config.mjs gate added and wired into the required CI static job with ALLOY_VALIDATE_REQUIRE_BINARY=1; committed file passes the pinned grafana/alloy:v1.18.1 parser (exit 0). Residual live-redeploy confirmation tracked as UAT test 5."
  reason: "User reported: docker/alloy/config.alloy uses # comments; grafana/alloy:v1.18.1 rejects them (illegal character U+0023), so the production Alloy container restart-loops. With a temporary //-corrected config, Loki shipping/correlation works and Grafana rules/contact are provisioned."
  severity: blocker
  test: 4
  root_cause: "docker/alloy/config.alloy uses shell/YAML-style # comments on 88 lines; Grafana Alloy config syntax supports only // and /* */ comments, so grafana/alloy:v1.18.1's lexer rejects the first # byte (illegal character U+0023 at 1:1), the process exits at config load, and restart: unless-stopped restart-loops the container. Contributing process gap: no automated check parses config.alloy with a real Alloy binary (pre-flagged in 15-17-SUMMARY.md)."
  artifacts:
    - path: "docker/alloy/config.alloy"
      issue: "88 comment lines use # instead of //; functional blocks are valid (verified: //-corrected copy passes alloy fmt exit 0 on the pinned image)"
    - path: "docker/docker-compose.prod.yml"
      issue: "No change needed — alloy service (lines 464-506) mounts the broken file; restart: unless-stopped produces the observed loop (context only)"
  missing:
    - "Convert # comments to // on all comment lines of docker/alloy/config.alloy"
    - "Add a validation gate that parses config.alloy with the real binary (e.g. docker run --rm -v ...:/etc/alloy/config.alloy:ro grafana/alloy:v1.18.1 fmt /etc/alloy/config.alloy in CI or scripts/validate-prod-compose.mjs)"
  debug_session: ".planning/debug/alloy-config-hash-comments.md"
