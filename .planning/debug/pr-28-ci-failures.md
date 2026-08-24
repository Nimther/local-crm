---
status: verifying
trigger: "PR #28 CI run 32733613756 fails in static, test, and e2e jobs before merge"
created: 2026-08-24T14:00:00Z
updated: 2026-08-24T15:25:00Z
mode: fix_and_verify
---

## Current Focus

hypothesis: "CONFIRMED — three independent deterministic causes: a connection-scoped timeout in a pooled test connection; three actionable-looking bare purge fixtures for live workspaces leaking into later global-scan tests; and an E2E sign-up helper that ignores the production-shaped shared auth rate limit."
test: "Static audit + four-file purge suite locally; full E2E on GitHub after push because the developer's long-running API/Web processes occupy the two hard-coded local E2E ports."
expecting: "Session-state audit clean, 47/47 purge tests pass together, and remote E2E handles a 429 by honoring Retry-After without consuming the test's application-work timeout."
next_action: "Commit and push the fix, wait for PR #28 checks, then resolve this session and merge in dependency order."

## Symptoms

expected: "PR #28 CI is green and can merge after PR #27."
actual: "static fails session-state audit; test reports the same audit violation plus three WorkspaceRestoredError failures; e2e times out waiting for /create-workspace after registration."
errors:
  - "apps/worker/src/queues/__tests__/workspace-purge-neighbour-safety.test.ts:242: connection-scoped-assignment SET statement_timeout = '2000'"
  - "WorkspaceRestoredError from beginDestructivePhase in three workspace-purge.test.ts cases"
  - "flow-unsaved-changes.spec.ts registration waitForURL timeout"
reproduction: "GitHub Actions CI run 32733613756 on PR #28 head 2c14a32ace40df660d60b42055f6004413d78d05"

## Evidence

- timestamp: 2026-08-24T14:00:00Z
  checked: "GitHub Actions jobs and logs"
  found: "failure-injection and Images pass; static, test, and e2e fail with the symptoms above."
  implication: "The PR is mergeable at Git level but not safe to merge until deterministic failures are fixed and E2E is classified."

- timestamp: 2026-08-24T14:20:00Z
  checked: "Downloaded Playwright artifact 9522459871 and inspected trace network response"
  found: "POST /api/auth/sign-up/email returned 429 with x-ratelimit-limit=20, x-ratelimit-remaining=0, and Retry-After=19; the failing spec then waited for a navigation that could never occur."
  implication: "The E2E failure is not a navigation flake; the spec bypassed the shared backoff-aware registration helper."

- timestamp: 2026-08-24T14:35:00Z
  checked: "Four purge test files run together before the fixture fix"
  found: "Exactly three WorkspaceRestoredError failures remained; workspace-purge-auth.test.ts creates exactly three bare purge_records rows at status purging for live organizations and leaves them visible to later global purge ticks."
  implication: "The aggregate failures are cross-test fixture leakage, while the report-only restore path also needs an explicit historical-record guard to match D-14/T-22-06-06."

- timestamp: 2026-08-24T15:00:00Z
  checked: "Local verification after fixes"
  found: "npm run lint:session-state passed (559 files); build across all workspaces passed; ESLint passed; workspace purge suites passed 47/47."
  implication: "Static and backend test failures are fixed locally."

- timestamp: 2026-08-24T15:25:00Z
  checked: "Attempted full local E2E"
  found: "The run provisioned an ephemeral database but could not start its isolated servers because long-running developer processes already occupy ports 4000 and 5173; Playwright failed with EADDRINUSE before collecting tests."
  implication: "This is an environment-only local verification blocker; the clean GitHub runner remains the authoritative full-corpus E2E check."

## Resolution

root_cause: "(1) neighbour-safety used SET statement_timeout before BEGIN, leaking session state on a pooled connection and tripping the required audit; (2) three JSONB unit fixtures inserted purge_records as purging for live organizations, so later global purge tests attempted them and failed closed; (3) two legacy E2E specs performed sign-up directly, and flow-unsaved-changes hit the shared 20/min auth bucket without honoring the returned Retry-After. The worker also had no non-error terminal path for the documented report-only restore history row."
fix: "Use BEGIN + SET LOCAL; make bare JSONB fixtures terminal/non-actionable; preserve a reported/no-destruction purge record when the same-lock restore has already cleared deletedAt; add a regression test; route the affected E2E specs through the shared registration helper and extend only the current test budget by the server-mandated retry delay."
verification: "Local: session-state 559 files clean; all workspace builds + ESLint pass; four purge files 47/47 pass. Remote full CI pending after push because local E2E ports are occupied by the developer's existing stack."
files_changed:
  - "apps/worker/src/queues/__tests__/workspace-purge-neighbour-safety.test.ts"
  - "apps/worker/src/queues/__tests__/workspace-purge-auth.test.ts"
  - "apps/worker/src/queues/__tests__/workspace-purge.test.ts"
  - "apps/worker/src/queues/workspace-purge.worker.ts"
  - "apps/web/e2e/helpers/workspace-setup.ts"
  - "apps/web/e2e/flow-unsaved-changes.spec.ts"
  - "apps/web/e2e/segments-tags.spec.ts"
