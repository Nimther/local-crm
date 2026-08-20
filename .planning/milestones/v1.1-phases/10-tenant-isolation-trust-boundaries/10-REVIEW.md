---
phase: 10-tenant-isolation-trust-boundaries
reviewed: 2026-08-09T00:00:00Z
depth: standard
files_reviewed: 98
files_reviewed_list:
  - .github/workflows/ci.yml
  - apps/api/package.json
  - apps/api/src/__tests__/anti-enumeration-sweep.test.ts
  - apps/api/src/__tests__/env-schema.test.ts
  - apps/api/src/__tests__/negative-cross-tenant.test.ts
  - apps/api/src/__tests__/rate-limit-distributed.test.ts
  - apps/api/src/env.ts
  - apps/api/src/logger.ts
  - apps/api/src/middleware/role-guard.ts
  - apps/api/src/middleware/tenant-context.ts
  - apps/api/src/modules/analytics/dashboard.routes.ts
  - apps/api/src/modules/analytics/flow-analytics.routes.ts
  - apps/api/src/modules/analytics/timeline.routes.ts
  - apps/api/src/modules/api-keys/__tests__/api-key-auth.test.ts
  - apps/api/src/modules/api-keys/__tests__/api-key-scopes.test.ts
  - apps/api/src/modules/api-keys/api-key-auth.ts
  - apps/api/src/modules/api-keys/api-keys.repository.ts
  - apps/api/src/modules/auth/__tests__/auth-boundary.test.ts
  - apps/api/src/modules/auth/auth.ts
  - apps/api/src/modules/campaigns/campaigns.routes.ts
  - apps/api/src/modules/contacts/contacts-api.routes.ts
  - apps/api/src/modules/contacts/contacts.routes.ts
  - apps/api/src/modules/contacts/csv-import.routes.ts
  - apps/api/src/modules/events/__tests__/events-api.test.ts
  - apps/api/src/modules/events/events-api.routes.ts
  - apps/api/src/modules/flows/flows.routes.ts
  - apps/api/src/modules/segments/segments.routes.ts
  - apps/api/src/modules/send-log/send-log.routes.ts
  - apps/api/src/modules/tenancy/__tests__/invite-response-identity.test.ts
  - apps/api/src/modules/tenancy/__tests__/resolve-workspace-member.test.ts
  - apps/api/src/modules/tenancy/invites.ts
  - apps/api/src/modules/tenancy/resolve-workspace-member.ts
  - apps/api/src/modules/webhooks/__tests__/starkbank-ecdsa.d.ts
  - apps/api/src/modules/webhooks/__tests__/webhook-timestamp-window.test.ts
  - apps/api/src/modules/webhooks/__tests__/webhooks-signature.test.ts
  - apps/api/src/modules/webhooks/signature-verify.ts
  - apps/api/src/modules/webhooks/webhook-endpoint.repository.ts
  - apps/api/src/modules/webhooks/webhooks.routes.ts
  - apps/api/src/server.ts
  - apps/worker/package.json
  - apps/worker/src/queues/__tests__/campaign-scheduler-scan.test.ts
  - apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts
  - apps/worker/src/queues/__tests__/webhook-events-sibling-drop.test.ts
  - apps/worker/src/queues/analytics-reconciliation.worker.ts
  - apps/worker/src/queues/campaign-scheduler.worker.ts
  - apps/worker/src/queues/flows/flow-reconciliation.worker.ts
  - apps/worker/src/queues/flows/flow-segment-sweep.worker.ts
  - apps/worker/src/queues/flows/flow-trigger-evaluator.worker.ts
  - apps/worker/src/queues/partition-maintenance.worker.ts
  - apps/worker/src/queues/webhook-events.worker.ts
  - apps/worker/src/server.ts
  - apps/worker/src/test/failure-fixtures.ts
  - apps/worker/src/test/harness/sigkill-entrypoint.ts
  - docker/init-app-role.sql
  - docs/lint-rule-exceptions.md
  - docs/runbooks/relocate-default-partition-rows.md
  - packages/db/migrations/0041_scan_role_bootstrap.sql
  - packages/db/migrations/0042_scan_role_grants_and_policies.sql
  - packages/db/migrations/0043_retire_admin_scan_guc_policies.sql
  - packages/db/migrations/0044_workspace_isolation_fail_closed.sql
  - packages/db/migrations/0045_auth_role_grants.sql
  - packages/db/migrations/0046_api_key_scopes_backfill.sql
  - packages/db/migrations/meta/_journal.json
  - packages/db/scripts/relocate-default-partition-rows.ts
  - packages/db/src/index.ts
  - packages/db/src/partitions/__tests__/boundary-crossing-late-automation.test.ts
  - packages/db/src/partitions/__tests__/relocate-default-partition-rows.test.ts
  - packages/db/src/partitions/__tests__/relocate-default.test.ts
  - packages/db/src/partitions/ensure-partitions.ts
  - packages/db/src/partitions/relocate-default.ts
  - packages/db/src/schema/api-keys.ts
  - packages/redaction/package.json
  - packages/redaction/src/__tests__/rules-parity.test.ts
  - packages/redaction/src/__tests__/scrub.test.ts
  - packages/redaction/src/index.ts
  - packages/redaction/src/pino-redact.ts
  - packages/redaction/src/rules.ts
  - packages/redaction/src/scrub.ts
  - packages/redaction/src/scrubbed-console.ts
  - packages/redaction/tsconfig.json
  - packages/redaction/vitest.config.ts
  - packages/tenant-context/src/__tests__/scan.test.ts
  - packages/tenant-context/src/__tests__/tenant-context.test.ts
  - packages/tenant-context/src/index.ts
  - packages/tenant-context/src/scan.ts
  - packages/test-support/src/db-fixture.ts
  - packages/test-support/src/global-setup.ts
  - packages/test-support/src/index.ts
  - packages/test-support/src/provision-db.ts
  - scripts/__fixtures__/session-state/compliant.ts
  - scripts/__fixtures__/session-state/violating.ts
  - scripts/__tests__/ensure-db-roles-env.test.mjs
  - scripts/__tests__/lint-session-state.test.mjs
  - scripts/__tests__/predev-env-loading.test.mjs
  - scripts/check-env.mjs
  - scripts/ensure-db-roles.mjs
  - scripts/lint-session-state.mjs
  - scripts/vitest.config.ts
findings:
  critical: 0
  warning: 2
  info: 2
  total: 4
status: issues_found
---

# Phase 10: Code Review Report (Iteration 3 — post gap-closure, plan 10-15 focus)

**Reviewed:** 2026-08-09T00:00:00Z
**Depth:** standard
**Files Reviewed:** 98
**Status:** issues_found

## Summary

Iteration 3 of the review/fix loop for phase 10. Iteration 1 found 7 issues
(CR-01, WR-01..WR-05, IN-01); iteration 2's commits fixed CR-01 and
WR-01..WR-05, leaving IN-01 (Info) intentionally unfixed. This pass re-verifies
that iteration-2 fix set did not regress, and gives the two newest files
(`scripts/__tests__/ensure-db-roles-env.test.mjs`,
`scripts/__tests__/predev-env-loading.test.mjs`) and the `ensure-db-roles.mjs`
/ `check-env.mjs` env-loading fix from plan 10-15 the closest scrutiny, per
this run's task context.

**WR-01..WR-05 re-verified, no regressions:**

- **WR-01** (`invites.ts` revoke route) — the `existing.organizationId ===
  workspace.id` ownership check is present and unconditional on the revoke
  path; matches the sibling resend handler.
- **WR-02** (`contacts.routes.ts` `/contacts/:id/events`) —
  `contactEventsQuerySchema` (`z.coerce.number().int().min(1).optional()`)
  replaces the old `Math.max(1, Number(...) || 1)` hand-parse; a non-integer
  or zero/negative `page` now 400s instead of silently coercing.
- **WR-03** (`webhook-endpoint.repository.ts`) —
  `getWebhookEndpointByWorkspace` now binds `getWorkspaceId()` as `$1`
  instead of re-reading `current_setting('app.current_workspace_id', true)`
  in SQL; consistent with the fail-closed RLS predicate migration 0044
  established for every other repository function.
- **WR-04** (`csv-import.routes.ts` `csvEscape`) — a value starting with
  `=`, `+`, `-`, `@`, tab, or CR is prefixed with `'` before the existing
  RFC 4180 quote-escaping runs against the neutralized string; applied
  uniformly to header and data cells.
- **WR-05** (`invites.ts`/`campaigns.routes.ts`/`flows.routes.ts`) — every
  hand-typed `{ error: "Workspace not found" }` literal in the three touched
  files now imports and reuses `NOT_FOUND_BODY`.

**Plan 10-15 (env-loading gap G-10-1) verified correct:**

`scripts/ensure-db-roles.mjs` now calls `process.loadEnvFile(resolveEnvPath())`
at module scope, mirroring `migrate-dev.mjs`'s existing pattern, before
`resolveAdminDsn()` can ever run. Traced through what each of the three
`ensure-db-roles-env.test.mjs` cases would observe with the fix reverted
(confirmed each assertion would actually fail without the fix — none of the
three passes vacuously): Test 1 asserts the connection-refused error names
port `59999` (the file's DSN) and not `5432` (the compose-default fallback
that would fire without the load); Test 3 confirms a missing/unreadable env
file is tolerated (caught by the existing bare `catch {}`, matching every
other env-file loader in this codebase) and the exported fallback DSN still
resolves. `predev-env-loading.test.mjs`'s static rule (every predev-chain
script mentioning a `DATABASE_URL`-suffixed variable must import
`./env-path.mjs`) correctly parses the enumeration from `package.json`'s
`predev` script rather than hand-listing it, so a future fourth predev step
is covered automatically.

No new Critical issues were found. Two new Warning-level findings surfaced
while reading `csv-import.routes.ts` (in scope for WR-04 verification) and
`ensure-db-roles-env.test.mjs` (in scope as the newest change); the
iteration-1/2 IN-01 finding (`role-guard.ts`) remains unfixed and is carried
forward.

## Warnings

### WR-06: Unvalidated `:id` route param flows into `Content-Disposition` header (CSV import error report)

**File:** `apps/api/src/modules/contacts/csv-import.routes.ts:277-298`
**Issue:** `GET /api/workspaces/:slug/imports/:id/errors` builds the response
header as:
```ts
reply.header("Content-Disposition", `attachment; filename="import-${id}-errors.csv"`);
```
`id` is the raw route param — never validated as a UUID (no zod schema on
this route) and never escaped before being embedded in a quoted header
value. Node's header-value validator blocks CR/LF (no classic header
splitting), but does **not** reject a literal `"` (0x22 is inside the
permitted `\x20-\x7e` range). A caller can request e.g.
`.../imports/x%22;%20filename%3D%22evil.html/errors` and get back a
`Content-Disposition` header with an injected second `filename` parameter —
and this happens unconditionally, independent of whether an import with
that id actually exists (`getErrorRows(id)` just returns an empty array for
a bogus id; the header is still built from the raw string first). Impact is
bounded today (session-authenticated, scoped to the caller's own workspace
membership, so it can only affect the requester's own response), but it's a
missing-input-validation gap that becomes a real problem the moment this
handler or a copy of it sits behind a link a victim can be induced to open.
**Fix:** Validate `id` as a UUID before use (400 otherwise), or at minimum
escape `"` when building the header value:
```ts
const parsedId = z.string().uuid().safeParse(id);
if (!parsedId.success) {
  return reply.code(400).send({ error: "Invalid import id" });
}
```

### WR-07: `ensure-db-roles-env.test.mjs` Test 2's docstring overstates what it proves

**File:** `scripts/__tests__/ensure-db-roles-env.test.mjs:87-106`
**Issue:** The test is titled "a directly exported admin DSN still outranks
the file," but it sets the file's `TEST_ADMIN_DATABASE_URL` and the
environment's `GSD_ADMIN_DATABASE_URL` — two **different** variable names.
`resolveAdminDsn()`'s `||` chain already prefers `GSD_ADMIN_DATABASE_URL`
over `TEST_ADMIN_DATABASE_URL` regardless of where either value came from,
so this test passes for a reason unrelated to env-file-loading precedence.
It never proves that `process.loadEnvFile()` leaves an already-exported
value alone when the **same** key (e.g. `TEST_ADMIN_DATABASE_URL`) is both
pre-set in the environment and present in the loaded file. Node's documented
`loadEnvFile`/`--env-file` behavior is "environment wins," so the real-world
risk is low, but as written this test would still pass even if that
assumption were violated for this codebase's Node version, because it never
exercises the same-key case its own title claims to cover.
**Fix:** Add (or repurpose) a case that exports `TEST_ADMIN_DATABASE_URL`
directly in `env` AND writes a different value for the same key into the
file, then asserts the exported value's port wins.

## Info

### IN-01: `requirePermission`'s `hasPermission` catch-all re-throws for the no-`:slug` case (carried forward, unfixed by design)

**File:** `apps/api/src/middleware/role-guard.ts:64-81`
**Issue:** Unchanged since iteration 1. When `auth.api.hasPermission` throws
and the route has no `:slug` param (`organizationId` is `undefined`), the
catch block re-throws (`throw err;`) instead of mapping to a defined HTTP
response, relying entirely on Fastify's default error handler. Every route
currently calling `requirePermission` does have a `:slug` param, so this
path is not reachable today, but it is a silent trap for a future
`:slug`-less route added under this guard.

This finding was explicitly scoped out of iteration 1's and iteration 2's
fix passes (Info severity, out of fix scope) and remains unfixed; carried
forward again per this iteration's instructions.

**Fix:** Add an explicit fallback in the `else` branch:
```ts
if (organizationId) {
  await reply.code(404).send(NOT_FOUND_BODY);
  return;
}
await reply.code(401).send({ error: "Not authenticated" });
```

### IN-02: `phone` value-pattern redaction rule remains a broad heuristic

**File:** `packages/redaction/src/rules.ts:90-106`
**Issue:** Documented and deliberate (the comment explains the prior
UUID-false-positive bug this pattern was tuned to avoid), but the
10-15-digit `\+?\(?\d(?:[\s().-]*\d){9,14}\b` pattern will still match many
non-phone numeric strings of the right length embedded in freeform event
properties (e.g. long order/reference numbers), redacting benign data. Not a
security gap (over-redaction is the safe failure direction) — noted for
awareness only, no action required this phase.
**Fix:** None required.

---

_Reviewed: 2026-08-09T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
