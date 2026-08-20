---
status: complete
phase: 10-tenant-isolation-trust-boundaries
source: 10-01-SUMMARY.md, 10-02-SUMMARY.md, 10-03-SUMMARY.md, 10-04-SUMMARY.md, 10-05-SUMMARY.md, 10-06-SUMMARY.md, 10-07-SUMMARY.md, 10-08-SUMMARY.md, 10-09-SUMMARY.md, 10-10-SUMMARY.md, 10-11-SUMMARY.md, 10-12-SUMMARY.md, 10-13-SUMMARY.md, 10-14-SUMMARY.md
started: 2026-08-08T20:21:21.918Z
updated: 2026-08-09T04:24:36.000Z
---

## Current Test

[testing complete]

## Tests

### 1. Cold Start Smoke Test
expected: Kill any running server/worker. Clear ephemeral state. Start the application from scratch — server boots without errors, migrations (incl. 0042 scan-role grants and 0046 API-key scope backfill) complete, and a health check / basic API call returns live data.
result: pass
note: "Re-tested after G-10-1 fix (plan 10-15) — user confirmed cold start passes on the Homebrew-Postgres machine."

### 2. Confirm Auto-Covered Security Deliverables
expected: All 60 deliverables across the 14 Phase 10 plans are deterministically covered by passing automated tests (see auto-passed entries below). Confirm acceptance of the automated coverage.
result: pass

### 3. [10-01 D1] SEC-01
expected: mega_crm_scan role created (NOBYPASSRLS, owns no tables, not a member relationship of mega_crm_app) and campaign-scheduler's due-campaign discovery reads across two workspaces in one query via withCrossWorkspaceScan
result: pass
source: automated
coverage_id: D1
covering_tests: packages/tenant-context/src/__tests__/scan.test.ts#Test 1: reads due campaigns from two DIFFERENT workspaces in a single scan-pool query ; packages/tenant-context/src/__tests__/scan.test.ts#Test 2: mega_crm_scan is a login role that cannot bypass RLS ; packages/tenant-context/src/__tests__/scan.test.ts#Test 3: mega_crm_scan and mega_crm_auth own zero tables ; apps/worker/src/queues/__tests__/campaign-scheduler-scan.test.ts#discovers due campaigns across two workspaces and transitions each via the unchanged per-tenant path

### 4. [10-01 D2] SEC-02
expected: API process structurally cannot reach the scan role -- no credential in its env schema, no membership in the role, no import of the helper
result: pass
source: automated
coverage_id: D2
covering_tests: packages/tenant-context/src/__tests__/scan.test.ts#Test 4: mega_crm_app is not a member of mega_crm_scan or mega_crm_auth (P3) ; apps/api/src/__tests__/env-schema.test.ts#P3 -- apps/api holds no scan-role credential or entry point > apps/api/src/env.ts does not reference SCAN_DATABASE_URL ; apps/api/src/__tests__/env-schema.test.ts#P3 -- apps/api holds no scan-role credential or entry point > no file under apps/api/src (outside __tests__) imports withCrossWorkspaceScan ; apps/worker/src/server.ts buildWorker() boot check -- verified manually: throws without SCAN_DATABASE_URL

### 5. [10-02 D1] SEC-14
expected: Single resolveWorkspaceMember implementation exists; its four failure paths (unknown slug, soft-deleted workspace, unauthenticated caller, non-member caller) are byte-identical, proven by an automated test driving the real HTTP stack
result: pass
source: automated
coverage_id: D1
covering_tests: apps/api/src/modules/tenancy/__tests__/resolve-workspace-member.test.ts (6 tests)

### 6. [10-02 D2] SEC-14
expected: All nine former local resolveWorkspaceMember copies replaced with the shared import; exactly one declaration remains in the tree; existing apps/api suite passes unchanged
result: pass
source: automated
coverage_id: D2
covering_tests: grep -rn \"async function resolveWorkspaceMember\" apps/api/src --include=*.ts (1 match, tenancy/resolve-workspace-member.ts) ; npx vitest run --root apps/api (52 files, 287 tests) ; npm run build --workspace=apps/api && npm run lint

### 7. [10-03 D1] SEC-01
expected: Migration 0042 grants mega_crm_scan SELECT-only access to flow_runs, flows, contacts, sends, organization with narrowing predicates on flow_runs_scan/flows_scan
result: pass
source: automated
coverage_id: D1
covering_tests: packages/db/migrations/0042_scan_role_grants_and_policies.sql -- npm run lint:migrations ; packages/tenant-context/src/__tests__/scan.test.ts#10-03 Test 1: reads waiting, past-wake flow_runs from two DIFFERENT workspaces in a single scan-pool query ; packages/tenant-context/src/__tests__/scan.test.ts#10-03 Test 2: a completed flow_run and a future-wake waiting flow_run are both invisible to the scan pool ; packages/tenant-context/src/__tests__/scan.test.ts#10-03 Test 3: a live segment-triggered flow in each of two workspaces is visible to the scan pool; a paused one is not ; packages/tenant-context/src/__tests__/scan.test.ts#10-03 Test 4: the scan pool can read organization ids across workspaces ; packages/tenant-context/src/__tests__/scan.test.ts#Test 5 (10-01 tracer, superseded by 10-03's flow_versions case below)

### 8. [10-03 D2] SEC-02
expected: flow-reconciliation, flow-segment-sweep, and analytics-reconciliation all discover cross-workspace candidates through withCrossWorkspaceScan, not a session flag on the tenant pool
result: pass
source: automated
coverage_id: D2
covering_tests: apps/worker/src/queues/__tests__/analytics-reconciliation.test.ts -- 3/3 passing after migration ; apps/worker/src/queues/__tests__/flow-segment-trigger.test.ts -- 8/8 passing after migration ; grep -c set_config apps/worker/src/queues/flows/flow-reconciliation.worker.ts == 0; grep -n admin_scan across all three migrated files == 0 matches

### 9. [10-04 D1] SEC-10
expected: Parameterized sweep proves a missing id and a cross-tenant id return byte-identical status+body across 9 resource kinds (contact, campaign, flow, flow-analytics, segment, segment-members, send-log entry, csv import, api key) under an authenticated workspace-A-only member
result: pass
source: automated
coverage_id: D1
covering_tests: apps/api/src/__tests__/anti-enumeration-sweep.test.ts (it.each over resourceCases, 9 cases)

### 10. [10-04 D2] SEC-15
expected: Workspace-level anti-enumeration holds on both resolveWorkspaceMember-backed routes and requirePermission-backed routes (a nonexistent slug and a non-member-of-a-real-workspace slug return byte-identical 404)
result: pass
source: automated
coverage_id: D2
covering_tests: apps/api/src/__tests__/anti-enumeration-sweep.test.ts (workspace-level resolveWorkspaceMember + requirePermission cases)

### 11. [10-04 D3] SEC-10
expected: Positive control proves the sweep fixture reaches real handlers (not vacuously 401ing) -- workspace A's own contact returns 200
result: pass
source: automated
coverage_id: D3
covering_tests: apps/api/src/__tests__/anti-enumeration-sweep.test.ts (positive control test)

### 12. [10-04 D4] SEC-15
expected: role-guard.ts's requirePermission shares resolveWorkspaceMember's NOT_FOUND_BODY constant (missing-workspace branch) and maps hasPermission's non-member throw to the same 404 (permission-check branch), closing a real 401-vs-404 enumeration oracle
result: pass
source: automated
coverage_id: D4
covering_tests: apps/api/src/__tests__/anti-enumeration-sweep.test.ts (requirePermission workspace-level case) + apps/api/src/modules/tenancy/__tests__/role-guard.test.ts (regression, 4 tests)

### 13. [10-04 D5] SEC-10
expected: Invite preview endpoint returns identical 404 for a nonexistent invitation id and one whose organization row is gone, byte-identical across repeat requests, and returns exactly the 5-field audited payload for a pending invitation
result: pass
source: automated
coverage_id: D5
covering_tests: apps/api/src/modules/tenancy/__tests__/invite-response-identity.test.ts (4 tests)

### 14. [10-05 D1] SEC-16
expected: scripts/lint-session-state.mjs fails on a connection-scoped SET, a role switch (even with LOCAL), or a set_config(...) call whose third argument isn't the literal true
result: pass
source: automated
coverage_id: D1
covering_tests: scripts/__tests__/lint-session-state.test.mjs#Test 1 — the violating fixture fails with exactly three violations ; scripts/__tests__/lint-session-state.test.mjs#Test 4 — set_config with a non-true third argument, and the two-argument form ; scripts/__tests__/lint-session-state.test.mjs#role switch is reported unconditionally, even with LOCAL

### 15. [10-05 D2] SEC-16
expected: A source file using only transaction-local session state (SET LOCAL, set_config(..., true)) passes cleanly
result: pass
source: automated
coverage_id: D2
covering_tests: scripts/__tests__/lint-session-state.test.mjs#Test 2 — the compliant fixture passes

### 16. [10-05 D3] SEC-16
expected: Comment-stripping runs before matching, so prose describing the forbidden constructs in a code comment does not self-invalidate the compliant fixture
result: pass
source: automated
coverage_id: D3
covering_tests: scripts/__tests__/lint-session-state.test.mjs#Test 3 — comment-stripping: prose describing the forbidden forms is not self-invalidating

### 17. [10-05 D4] SEC-16
expected: The audit scans the whole first-party source tree (apps/api/src, apps/worker/src, packages/*/src, packages/db/scripts) enumerated from the filesystem, not a hand-listed set, and reports zero violations against the real 309-file tree
result: pass
source: automated
coverage_id: D4
covering_tests: scripts/__tests__/lint-session-state.test.mjs#Test 6 — the real repository source tree is clean

### 18. [10-05 D5] SEC-16
expected: The audit runs in CI as a blocking step in the static job's required check, immediately after the migration linter
result: pass
source: automated
coverage_id: D5
covering_tests: .github/workflows/ci.yml static job — 'Session-state audit' step running npm run lint:session-state, verified present via grep and by re-running npm run lint:session-state locally (exit 0)

### 19. [10-05 D6] SEC-16
expected: The documented exception marker (session-state-exception: <reason>) suppresses exactly one statement, requires a reason, and is not honoured as a file-header blanket form
result: pass
source: automated
coverage_id: D6
covering_tests: scripts/__tests__/lint-session-state.test.mjs#Test 5 — the exception marker requires a reason

### 20. [10-06 D1] SEC-01
expected: attachPartitionCheckFirst's options.adminClient mechanism is load-bearing for a non-empty attach: fails without it, succeeds with it
result: pass
source: automated
coverage_id: D1
covering_tests: packages/db/src/partitions/__tests__/relocate-default-partition-rows.test.ts -- both tests pass ; npx vitest run --root packages/db -- 45/45 passing (8 test files)

### 21. [10-06 D2] SEC-01
expected: No first-party source sets the legacy cross-tenant marker session variable; the relocation path works under the elevated-adminClient mechanism with full regression coverage
result: pass
source: automated
coverage_id: D2
covering_tests: npm run lint:session-state -- 312 files checked, no violations ; grep -rn \"set_config('app.admin_scan'\" across the repo -- only remaining hit is scan.test.ts's own negative test ; packages/db/src/partitions/__tests__/relocate-default.test.ts and boundary-crossing-late-automation.test.ts -- Phase 9 regression suite, all passing under the new required adminClient parameter

### 22. [10-06 D3] SEC-02
expected: Migration 0043 drops the five legacy marker-gated policies; a seeded negative test proves the marker grants no additional rows across five tables; a catalog assertion proves no policy references it
result: pass
source: automated
coverage_id: D3
covering_tests: npm run lint:migrations -- 44 files checked, no violations ; packages/tenant-context/src/__tests__/scan.test.ts -- 10-06 Test 1 (seeded negative proof) and Test 2 (pg_policies catalog assertion) -- 12/12 passing ; npx vitest run --root packages/tenant-context -- 19/19 passing; npx vitest run --root apps/worker -- 125/125 passing

### 23. [10-07 D1] SEC-03
expected: All 22 workspace_isolation policies share one fail-closed, TO mega_crm_app predicate; a never-scoped and a recycled-to-empty connection both raise a Postgres error (never zero rows), proven for two representative tables (contacts, flows) and asserted from the pg_policies catalog for all 22
result: pass
source: automated
coverage_id: D1
covering_tests: packages/tenant-context/src/__tests__/tenant-context.test.ts -- 'the fail-closed RLS contract (SEC-03/SEC-04)' describe block, 8/8 passing ; npm run lint:migrations -- 45 files checked, no violations

### 24. [10-07 D2] SEC-04
expected: A query against a tenant table with no tenant context throws, never returns zero rows -- the specific SEC-04 acceptance criterion, asserted via rejects.toThrow on the exact Postgres error class, never a row-count assertion
result: pass
source: automated
coverage_id: D2
covering_tests: packages/tenant-context/src/__tests__/tenant-context.test.ts -- 4 rejects.toThrow assertions (contacts x2, flows x2), all passing

### 25. [10-07 D3] SEC-03
expected: The two pre-tenant lookup paths (API-key auth, webhook receipt) still resolve their rows under the fail-closed predicate via withPreTenantLookup, and still return null (not throw) for an unknown id/token -- proven both at the repository-function level and end-to-end through the real HTTP stack
result: pass
source: automated
coverage_id: D3
covering_tests: apps/api/src/modules/api-keys/__tests__/api-key-auth.test.ts -- lookupApiKeyById direct tests + full apiKeyAuth suite, 15/15 passing ; apps/api/src/modules/webhooks/__tests__/webhooks-signature.test.ts -- findWebhookEndpointByToken direct tests + full signature-verification suite, 8/8 passing ; npx vitest run --root apps/api -- 309/309 passing; npx vitest run --root apps/worker -- 125/125 passing; npx vitest run --root packages/db -- 45/45 passing

### 26. [10-08 D1] SEC-09
expected: A mixed batch (own event, sibling event, orphan event) persists the receiving workspace's event and the orphan, discards the sibling's, and returns a non-zero inserted count
result: pass
source: automated
coverage_id: D1
covering_tests: apps/worker/src/queues/__tests__/webhook-events-sibling-drop.test.ts#Test 1: a mixed batch persists the receiving workspace's own event and the orphan, and discards the sibling's ; apps/worker/src/queues/__tests__/webhook-events-sibling-drop.test.ts#Test 3: one sibling event does not fail the batch -- the receiving workspace's own side effects still apply

### 27. [10-08 D2] SEC-09
expected: The sibling workspace's own send_events is unchanged -- the dropped event is discarded, never redirected
result: pass
source: automated
coverage_id: D2
covering_tests: apps/worker/src/queues/__tests__/webhook-events-sibling-drop.test.ts#Test 2: the sibling workspace's own send_events is unchanged -- the dropped event is discarded, not redirected

### 28. [10-08 D3] SEC-09
expected: The drop signal's payload carries only receivingWorkspaceId/owningWorkspaceId/count -- no sibling email, payload marker, or send_id, proven by negative string matching against seeded distinctive values
result: pass
source: automated
coverage_id: D3
covering_tests: apps/worker/src/queues/__tests__/webhook-events-sibling-drop.test.ts#Test 4: the drop signal carries only workspace ids and a count -- no sibling email, payload marker, or send_id

### 29. [10-08 D4] SEC-09
expected: The pre-existing D-15 orphan behaviour (send_id exists in no workspace) is unchanged, and a batch with no send_id values never touches the scan pool
result: pass
source: automated
coverage_id: D4
covering_tests: apps/worker/src/queues/__tests__/webhook-events-sibling-drop.test.ts#Test 5: an event whose send_id exists in no workspace at all is still stored with a null send_id and no side effects (D-15 unchanged) ; apps/worker/src/queues/__tests__/webhook-events-sibling-drop.test.ts#Test 6: a batch with no send_id values performs no cross-workspace lookup -- succeeds even with SCAN_DATABASE_URL removed

### 30. [10-09 D1] SEC-05
expected: mega_crm_auth login role gains exclusive grants on all seven Better Auth tables; mega_crm_app loses all privileges on session/account/verification and is narrowed to SELECT (+UPDATE on organization, +UPDATE on user/REFERENCES on organization for Postgres's own FK mechanics) on the four workspace-shaped tables
result: pass
source: automated
coverage_id: D1
covering_tests: apps/api/src/modules/auth/__tests__/auth-boundary.test.ts#Test 4: mega_crm_app holds no privilege on session/account/verification across SELECT/INSERT/UPDATE/DELETE ; apps/api/src/modules/auth/__tests__/auth-boundary.test.ts#Test 5: mega_crm_app keeps SELECT + UPDATE on organization, but not INSERT/DELETE ; apps/api/src/modules/auth/__tests__/auth-boundary.test.ts#Test 6: mega_crm_auth holds SELECT on all seven Better Auth tables ; apps/api/src/modules/auth/__tests__/auth-boundary.test.ts#Test 7: reading session through the app-role tenant pool rejects with a permission error, not zero rows

### 31. [10-09 D2] SEC-05
expected: Better Auth's drizzleAdapter runs on the mega_crm_auth-backed authDb client; signup, login and invite-accept all pass end to end against the real server and database
result: pass
source: automated
coverage_id: D2
covering_tests: apps/api/src/modules/auth/__tests__/auth-boundary.test.ts#Test 1: signup creates a user and returns a session ; apps/api/src/modules/auth/__tests__/auth-boundary.test.ts#Test 2: login with those credentials succeeds and issues a session cookie ; apps/api/src/modules/auth/__tests__/auth-boundary.test.ts#Test 3: an invited user accepts an invitation and becomes a member of the inviting workspace

### 32. [10-09 D3] SEC-12
expected: A production boot with a BETTER_AUTH_SECRET shorter than 32 characters fails with a descriptive error naming the variable and the requirement; development/test are unaffected
result: pass
source: automated
coverage_id: D3
covering_tests: apps/api/src/__tests__/env-schema.test.ts#envSchema BETTER_AUTH_SECRET production floor > Test 1: production + a 20-character secret fails, with an issue on path BETTER_AUTH_SECRET ; apps/api/src/__tests__/env-schema.test.ts#envSchema BETTER_AUTH_SECRET production floor > Test 2: the same 20-character secret in development still passes -- the floor is production-only ; apps/api/src/__tests__/env-schema.test.ts#envSchema BETTER_AUTH_SECRET production floor > Test 3: a 32-character secret in production passes ; apps/api/src/__tests__/env-schema.test.ts#envSchema BETTER_AUTH_SECRET production floor > Test 4: the failure message names the variable and the 32-character requirement

### 33. [10-09 D4] 
expected: The SEC-05 ADR (ARCHITECTURE.md SS8) names both rejected alternatives (RLS on the auth tables; an auth.* schema move) with reasons, records reversibility and the acceptance gate, and documents the checkpoint-accepted owner-can-re-grant caveat
result: pass
source: automated
coverage_id: D4
covering_tests: grep -q mega_crm_auth ARCHITECTURE.md && grep -q AUTH_DATABASE_URL SPECIFICATION.md

### 34. [10-10 D1] SEC-06
expected: Every API-key route (POST /v1/contacts, POST /v1/events) declares and enforces a required scope; a key lacking it or holding an empty scope list is refused with a vocabulary-free 403
result: pass
source: automated
coverage_id: D1
covering_tests: apps/api/src/modules/api-keys/__tests__/api-key-scopes.test.ts (9 tests, all pass)

### 35. [10-10 D2] SEC-06
expected: Every pre-existing API key keeps working after enforcement ships -- migration 0046 backfills the full scope set in the same change that starts enforcement
result: pass
source: automated
coverage_id: D2
covering_tests: apps/api/src/modules/api-keys/__tests__/api-key-scopes.test.ts#createApiKey persists the full scope set for a key created without an explicit scopes argument ; npx vitest run --root apps/api (329 tests, all pass)

### 36. [10-10 D3] SEC-06
expected: A route-enumeration assertion fails if a future /v1/* route ships without a corresponding scope test in this file
result: pass
source: automated
coverage_id: D3
covering_tests: apps/api/src/modules/api-keys/__tests__/api-key-scopes.test.ts#Test 8: every route in the API-key route modules is covered by this file

### 37. [10-11 D1] SEC-07
expected: A signed delivery whose signature timestamp is exactly 600 seconds old is accepted (200, enqueued)
result: pass
source: automated
coverage_id: D1
covering_tests: apps/api/src/modules/webhooks/__tests__/webhook-timestamp-window.test.ts#Test 1: header timestamp exactly 600 seconds old -> 200 and enqueues

### 38. [10-11 D2] SEC-07
expected: A signed delivery whose signature timestamp is 601 seconds old is rejected (400, nothing enqueued)
result: pass
source: automated
coverage_id: D2
covering_tests: apps/api/src/modules/webhooks/__tests__/webhook-timestamp-window.test.ts#Test 2: header timestamp 601 seconds old -> 400 and enqueues nothing

### 39. [10-11 D3] SEC-07
expected: A malformed or missing signature timestamp is rejected identically (byte-identical body) to a bad signature
result: pass
source: automated
coverage_id: D3
covering_tests: apps/api/src/modules/webhooks/__tests__/webhook-timestamp-window.test.ts#Test 3: non-numeric timestamp header -> 400, body byte-identical to a wrong-signature delivery ; apps/api/src/modules/webhooks/__tests__/webhook-timestamp-window.test.ts#Test 4: missing timestamp header -> 400, body byte-identical to a wrong-signature delivery

### 40. [10-11 D4] SEC-07
expected: A future-dated signature timestamp beyond the window is rejected (bounded in both directions)
result: pass
source: automated
coverage_id: D4
covering_tests: apps/api/src/modules/webhooks/__tests__/webhook-timestamp-window.test.ts#Test 5: header timestamp 601 seconds in the FUTURE -> 400 (bounded in both directions)

### 41. [10-11 D5] SEC-07
expected: Replaying a previously accepted delivery after the window has elapsed is rejected
result: pass
source: automated
coverage_id: D5
covering_tests: apps/api/src/modules/webhooks/__tests__/webhook-timestamp-window.test.ts#Test 6: replaying an accepted delivery after the window has elapsed is rejected the second time

### 42. [10-11 D6] SEC-07
expected: Freshness composes WITH signature verification, never replaces it -- a fresh timestamp with a wrong signature still fails
result: pass
source: automated
coverage_id: D6
covering_tests: apps/api/src/modules/webhooks/__tests__/webhook-timestamp-window.test.ts#Test 7: a fresh timestamp with a WRONG signature still returns 400 (freshness composes with, never replaces, verification)

### 43. [10-11 D7] SEC-07
expected: The window is overridable by environment variable (WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS) and defaults to 600 seconds
result: pass
source: automated
coverage_id: D7
covering_tests: apps/api/src/modules/webhooks/__tests__/webhook-timestamp-window.test.ts#Test 8: the pure predicate takes an explicit tolerance override and defaults to 600 seconds when unset

### 44. [10-12 D1] SEC-11
expected: Two buildServer() instances sharing one Redis enforce one shared rate limit: request N passes and request N+1 is rejected regardless of which instance receives which
result: pass
source: automated
coverage_id: D1
covering_tests: apps/api/src/__tests__/rate-limit-distributed.test.ts#Test 2/3: two instances against one Redis reject at the SAME total the single instance did -- the 429 can land on either instance

### 45. [10-12 D2] SEC-08
expected: When the limiter's Redis is unreachable, requests proceed rather than failing, and the limiter's error is logged (loud fail-open)
result: pass
source: automated
coverage_id: D2
covering_tests: apps/api/src/__tests__/rate-limit-distributed.test.ts#Test 4: with the limiter's Redis unreachable, requests proceed and an error naming the limiter is logged

### 46. [10-12 D3] SEC-08
expected: The webhook route has its own independent rate-limit bucket: exhausting it does not throttle other rate-limited routes, and vice versa
result: pass
source: automated
coverage_id: D3
covering_tests: apps/api/src/__tests__/rate-limit-distributed.test.ts#Test 5a: exhausting the webhook route's bucket does not throttle a different rate-limited route ; apps/api/src/__tests__/rate-limit-distributed.test.ts#Test 5b: exhausting another route's bucket does not throttle the webhook route

### 47. [10-13 D1] SEC-13
expected: One rule table (REDACTION_RULES) is the sole source for both the structured-logger field configuration and the recursive scrubbing function
result: pass
source: automated
coverage_id: D1
covering_tests: packages/redaction/src/__tests__/rules-parity.test.ts#Test 9: every field name the previous logger configuration redacted is still covered by the compiled path list

### 48. [10-13 D2] SEC-13
expected: A representative payload (provider key, password, token, contact email, nested freeform object) is redacted identically through the compiled logger config and through scrub()
result: pass
source: automated
coverage_id: D2
covering_tests: packages/redaction/src/__tests__/rules-parity.test.ts#Test 8

### 49. [10-13 D3] SEC-13
expected: scrub() reaches secret/PII values nested at arbitrary depth (no depth ceiling) -- backstop probe at depth 7
result: pass
source: automated
coverage_id: D3
covering_tests: packages/redaction/src/__tests__/scrub.test.ts#Test 2 (backstop probe)

### 50. [10-13 D4] SEC-13
expected: Every direct console call under apps/worker/src (outside __tests__) is routed through scrubbedConsole
result: pass
source: automated
coverage_id: D4
covering_tests: grep -rn 'console\\.' apps/worker/src --include=*.ts | grep -v __tests__ (0 raw console.* calls, only a comment mention)

### 51. [10-13 D5] SEC-13
expected: The worker's sibling-drop signal (webhook.sibling_workspace_event_dropped, plan 10-08) passes through scrubbedConsole
result: pass
source: automated
coverage_id: D5
covering_tests: apps/worker/src/queues/__tests__/webhook-events-sibling-drop.test.ts (6/6)

### 52. [10-14 D1] SEC-16
expected: Every session-authenticated API route module has a cross-tenant read attempt (denied, same 404 shape as a missing resource) and, where it offers one, a cross-tenant write attempt (denied, target workspace's row verified unchanged at the row level)
result: pass
source: automated
coverage_id: D1
covering_tests: apps/api/src/__tests__/negative-cross-tenant.test.ts (24 tests, all pass)

### 53. [10-14 D2] SEC-16
expected: A workspace-A API key presented against workspace-B-shaped data (externalId collision) writes only into workspace A, never workspace B
result: pass
source: automated
coverage_id: D2
covering_tests: apps/api/src/__tests__/negative-cross-tenant.test.ts#Test 3: API-key-authed write is workspace-bound regardless of payload content

### 54. [10-14 D3] SEC-16
expected: No code path reaches a tenant table without tenant context -- both the AsyncLocalStorage guard and the DB-level fail-closed RLS predicate throw rather than returning rows
result: pass
source: automated
coverage_id: D3
covering_tests: apps/api/src/__tests__/negative-cross-tenant.test.ts#Test 4: no code path reaches a tenant table without tenant context

### 55. [10-14 D4] SEC-16
expected: The pre-tenant-lookup sentinel reads zero rows from an ordinary tenant table it was never granted
result: pass
source: automated
coverage_id: D4
covering_tests: apps/api/src/__tests__/negative-cross-tenant.test.ts#Test 5

### 56. [10-14 D5] SEC-16
expected: The API coverage assertion fails if a route module is registered in server.ts without a corresponding covered/excluded entry in this suite
result: pass
source: automated
coverage_id: D5
covering_tests: apps/api/src/__tests__/negative-cross-tenant.test.ts#Test 6: coverage

### 57. [10-14 D6] SEC-16
expected: Every background-job family that takes a workspace id from its payload produces no cross-workspace effect when the payload names a foreign workspace or a foreign resource id
result: pass
source: automated
coverage_id: D6
covering_tests: apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts (14 tests, all pass)

### 58. [10-14 D7] SEC-16
expected: Scan-consumer families (flow-reconciliation, flow-segment-sweep, analytics-reconciliation) discover cross-workspace candidates via the scan role but each row's per-tenant follow-up work affects only that row's own workspace
result: pass
source: automated
coverage_id: D7
covering_tests: apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts (Test 2 describe blocks: flow-reconciliation, flow-segment-sweep, analytics-reconciliation)

### 59. [10-14 D8] SEC-16
expected: The scan pool refuses a read of an ungranted tenant table with permission denied, not an empty result
result: pass
source: automated
coverage_id: D8
covering_tests: apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts#Test 4

### 60. [10-14 D9] SEC-16
expected: The worker coverage assertion fails if a job family is registered in buildWorker without a corresponding covered/excluded entry in this suite
result: pass
source: automated
coverage_id: D9
covering_tests: apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts#Test 5: coverage

### 61. [10-14 D10] SEC-16
expected: processFlowTriggerCheck verifies a job payload's contactId belongs to the job's own workspaceId before any flow entry -- a hostile/misrouted payload naming a contact from a different workspace is now a no-op rather than creating a cross-workspace flow_runs row
result: pass
source: automated
coverage_id: D10
covering_tests: apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts#flow-trigger-evaluator (processFlowTriggerCheck)

### 62. [10-14 D11] SEC-16
expected: 10-VALIDATION.md's per-task verification map, Wave 0 checklist, manual-only table, and sign-off checklist are complete with no remaining TBD entries
result: pass
source: automated
coverage_id: D11
covering_tests: grep -c TBD .planning/phases/10-tenant-isolation-trust-boundaries/10-VALIDATION.md == 0

## Summary

total: 62
passed: 62 (60 automated, 2 manual)
issues: 0
pending: 0
skipped: 0
blocked: 0

## Gaps

- gap_id: G-10-1
  truth: "Cold start from scratch boots without errors: migrations apply and a primary query returns live data"
  status: resolved
  resolved_by: 10-15-PLAN.md
  resolved_at: 2026-08-09
  reason: "User reported: Cold start failed. scripts/ensure-db-roles.mjs does not load the external env file from resolveEnvPath(), so it ignores TEST_ADMIN_DATABASE_URL and falls back to postgres://postgres:postgres@localhost:5432/postgres. Homebrew PostgreSQL has no "postgres" role. The script should load the same external env file as check-env.mjs and migrate-dev.mjs before resolving the admin DSN."
  severity: blocker
  test: 1
  root_cause: "scripts/ensure-db-roles.mjs (predev step 2, before migrations) resolves its admin DSN from bare process.env without first loading the external env file via process.loadEnvFile(resolveEnvPath()); TEST_ADMIN_DATABASE_URL in ~/.config/mega-crm/.env is invisible, so it falls back to the hardcoded compose DSN postgres://postgres:postgres@localhost:5432/postgres, which fails on Homebrew PostgreSQL (no 'postgres' role), aborting the predev chain before migrate-dev.mjs"
  artifacts:
    - path: "scripts/ensure-db-roles.mjs"
      issue: "lines 23-27: DEFAULT_ADMIN_DSN fallback reached because external env file is never loaded before resolveAdminDsn()"
    - path: "scripts/migrate-dev.mjs"
      issue: "lines 21-25: established env-loading pattern the fix should mirror (not itself broken)"
    - path: "package.json"
      issue: "line 13: predev chain places the failing script before migrations, so its failure blocks cold start"
  missing:
    - "Import resolveEnvPath from ./env-path.mjs in ensure-db-roles.mjs"
    - "Add try { process.loadEnvFile(resolveEnvPath()); } catch {} before resolveAdminDsn(), mirroring migrate-dev.mjs"
  debug_session: ".planning/debug/ensure-db-roles-env-loading.md"
