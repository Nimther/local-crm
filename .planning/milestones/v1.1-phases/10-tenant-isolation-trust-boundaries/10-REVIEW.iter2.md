---
phase: 10-tenant-isolation-trust-boundaries
reviewed: 2026-08-09T00:00:00Z
depth: standard
files_reviewed: 96
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
  - scripts/__tests__/lint-session-state.test.mjs
  - scripts/check-env.mjs
  - scripts/ensure-db-roles.mjs
  - scripts/lint-session-state.mjs
  - scripts/vitest.config.ts
findings:
  critical: 1
  warning: 5
  info: 1
  total: 7
status: issues_found
---

# Phase 10: Code Review Report

**Reviewed:** 2026-08-09T00:00:00Z
**Depth:** standard
**Files Reviewed:** 96
**Status:** issues_found

## Summary

This phase hardens tenant isolation across the platform: least-privilege Postgres
login roles (`mega_crm_scan`, `mega_crm_auth`), a single audited cross-workspace
scan entry point (`withCrossWorkspaceScan`), retirement of the `app.admin_scan`
session-GUC pattern, fail-closed `workspace_isolation` RLS predicates (migration
0044), API-key scopes, webhook signature/timestamp verification ordering, and a
centralized log-redaction package. The implementation is unusually disciplined:
every mechanism is accompanied by an explicit negative test that attempts the
exact cross-tenant read/write it exists to prevent
(`negative-cross-tenant.test.ts`, `negative-cross-tenant-jobs.test.ts`,
`scan.test.ts`, `tenant-context.test.ts`), and the migrations' own comments
document the fail-open pitfalls they close (NULLIF guards, `missing_ok`
`current_setting`, unscoped permissive policies).

Tracing the RLS policy definitions (0041-0046), the scan-role grants, the
`withCrossWorkspaceScan`/`withPreTenantLookup`/`withTenantTransaction` helpers,
every reviewed route module's tenant-scoping pattern, and the worker-side
discovery-scan → per-tenant-re-verification pattern did not surface a
tenant-isolation *bypass*. The webhook signature/timestamp verification
ordering (raw-body capture before JSON parsing, signature-then-freshness-then-
parse, fail-closed on every branch) is correct.

One genuine availability-risk regression was found (CR-01): a module-level
Postgres pool introduced/exposed by this phase's changes has no `error`
listener, unlike every sibling pool this same phase touched — all of which
carry an explicit CR-03-precedent comment explaining why the listener is
required to avoid crashing the process on an idle-connection drop. The
remaining findings are narrower quality/defense-in-depth issues: a CSV
formula-injection risk in the CSV-import error-report download, duplicated
re-typed 404 body literals that drift from this codebase's own stated
"imported reference, not re-typed literal" discipline, an invite-revoke route
that (unlike its sibling resend route) has no local ownership check and relies
entirely on a third-party library's internal enforcement, a hand-rolled
pagination parser that admits non-integer `page` values where every sibling
route uses a validated schema, and one repository query that reintroduces the
null-tolerant GUC-read pattern migration 0044 otherwise eliminated everywhere
else.

## Critical Issues

### CR-01: `packages/db/src/index.ts`'s base Postgres pool has no `error` listener — crashes the whole process on an idle-connection drop

**File:** `packages/db/src/index.ts:58`
**Issue:**
Every other Postgres `Pool` instance touched or introduced by this phase
registers a `pool.on("error", ...)` listener, with an explicit comment
explaining why: node-postgres's `Pool` is an `EventEmitter`, and an idle
pooled client that gets terminated by the server (Postgres restart, failover,
or an idle timeout — all plausible in production) emits an `'error'` event on
the pool. With no listener attached, Node's default `EventEmitter` behavior
for an unhandled `'error'` event is to throw, which — uncaught — crashes the
whole process.

This exact failure mode (and fix) is documented at length in this very file's
own `authPool` (lines ~92-98, this phase's own SEC-05 addition), in
`packages/tenant-context/src/index.ts` (the tenant-scoped `pool`), in
`packages/tenant-context/src/scan.ts` (`scanPool`, this phase's own SEC-01/02
addition), and in `apps/worker/src/queues/partition-maintenance.worker.ts`
(`partitionMaintenancePool`) — all citing "CR-03" as precedent. The base
`pool` in this file (constructed at line 58, backing the exported `db`
Drizzle client) is the one pool touched by this phase's changes that was
missed.

`db` is not a minor code path: it is the client
`apps/api/src/modules/tenancy/workspace-lookup.ts`, `workspaces.ts`,
`invites.ts`, and `members.ts` all use for every organization/member/
invitation/user lookup — i.e. every `resolveWorkspaceMember`/
`requirePermission` call in the codebase resolves through this connection.
`apps/worker` also imports `@mega-crm/db` for its own non-tenant queries (per
this file's own doc comment on `authDb`). A single idle-connection
termination on this pool — an ordinary, expected event in production, not an
edge case — crashes both `apps/api` and `apps/worker` instead of the pool
silently recovering, which is exactly the behavior the identical listener
achieves on every sibling pool in this same phase.

**Fix:**
```typescript
const pool = new Pool({ connectionString: databaseUrl });

// CR-03 precedent (see authPool below / @mega-crm/tenant-context's pool.on):
// without this listener an idle-connection termination surfaces as an
// uncaught 'error' event and crashes the process.
pool.on("error", (err) => {
  console.error("idle pg pool client error (connection dropped)", err);
});

export const db = drizzle(pool, { schema });
```

## Warnings

### WR-01: Invitation revoke route has no explicit cross-workspace ownership check, unlike its sibling resend route

**File:** `apps/api/src/modules/tenancy/invites.ts:128-146`
**Issue:** `POST /api/workspaces/:slug/invites/:invitationId/revoke` is gated
only by `requirePermission("invitation", "cancel")`, which checks that the
caller has the `cancel` permission on the workspace resolved from the URL's
`:slug` — it never checks that `invitationId` actually belongs to that
workspace. The handler then calls
`auth.api.cancelInvitation({ headers, body: { invitationId } })` with no
`organizationId` and no local lookup.

This is the one place in `invites.ts` that skips the "look up the resource,
confirm `existing.organizationId === workspace.id`, 404 otherwise" pattern its
own sibling route uses one function below (`resend`):
```ts
const existing = await db.query.invitation.findFirst({ where: eq(invitation.id, invitationId) });
if (!existing || existing.organizationId !== workspace.id) {
  return reply.code(404).send({ error: "Invitation not found" });
}
```
The `invitation` table carries no Row-Level Security at all (migration
`0045_auth_role_grants.sql`'s own header comment: "RLS is deliberately NOT
used here, and no policy is added to any of the seven [better-auth] tables"),
so there is no RLS backstop the way there is for every one of the 22 tenant
tables covered by migration 0044. The entire cross-tenant boundary for this
route rests on whatever `auth.api.cancelInvitation` does internally with the
caller's session and the invitation's own resolved organization — behavior of
a third-party dependency this review cannot verify from source.
`negative-cross-tenant.test.ts` (`ATTEMPT_CASES` → `registerInviteRoutes`)
does exercise exactly this cross-tenant revoke attempt, which is reassuring,
but the route itself still carries zero local defense-in-depth, unlike every
comparable route in this file and unlike the "never trust a payload id
without a local ownership re-check" discipline applied throughout
`apps/worker` (e.g. `flow-trigger-evaluator.worker.ts`'s explicit
`SELECT id FROM contacts WHERE id = $1 AND workspace_id = $2` re-verification,
added specifically because a job payload's `workspaceId` cannot be trusted
without it — see T-10-14-03).

**Fix:** Add the same explicit ownership check the `resend` handler already
has, before calling `cancelInvitation` (this also requires resolving
`workspace` via `findActiveWorkspaceBySlug(slug)` first, which the handler
does not currently do at all):
```ts
const { slug, invitationId } = request.params as { slug: string; invitationId: string };
const workspace = await findActiveWorkspaceBySlug(slug);
if (!workspace) {
  return reply.code(404).send({ error: "Workspace not found" });
}
const existing = await db.query.invitation.findFirst({ where: eq(invitation.id, invitationId) });
if (!existing || existing.organizationId !== workspace.id) {
  return reply.code(404).send({ error: "Invitation not found" });
}
```

### WR-02: GET /contacts/:id/events bypasses the zod pagination pattern used by every sibling route, admitting non-integer `page` values

**File:** `apps/api/src/modules/contacts/contacts.routes.ts:119-135`
**Issue:** Every other paginated route in this codebase (e.g.
`timeline.routes.ts`'s `page: z.coerce.number().int().min(1).optional()`,
`send-log.routes.ts`, `segments.routes.ts`) validates `page` through a zod
schema with `.int()`, so a malformed value 400s cleanly. This route instead
hand-parses it:
```ts
const query = request.query as { page?: string };
const page = query.page ? Math.max(1, Number(query.page) || 1) : 1;
```
`Number("1.7")` is `1.7` (truthy, so `|| 1` does not fire), and
`Math.max(1, 1.7)` is `1.7` — there is no `.int()`-equivalent floor here. A
request like `?page=1.7` passes a non-integer `page` straight into
`listContactEvents(id, { page })`, whose repository computes an
`OFFSET`/`LIMIT` from it — a value Postgres will reject for an integer-typed
parameter, surfacing as an unhandled 500 instead of the clean 400 every other
malformed-query-param case in this codebase produces.

**Fix:** Replace the manual parse with the same schema shape used elsewhere:
```ts
const contactEventsQuerySchema = z.object({ page: z.coerce.number().int().min(1).optional() });
...
const parsed = contactEventsQuerySchema.safeParse(request.query);
if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
const page = parsed.data.page ?? 1;
```

### WR-03: `getWebhookEndpointByWorkspace` reads the tenant GUC with `missing_ok=true` instead of the bound `getWorkspaceId()` every other repository function uses

**File:** `apps/api/src/modules/webhooks/webhook-endpoint.repository.ts:77-88`
**Issue:** Every other tenant-scoped repository function in this codebase
resolves the workspace id via `getWorkspaceId()` (which throws if no tenant
context is set) and passes it as a bound parameter. This one function instead
re-reads the GUC directly inside SQL with the nullable form:
```sql
WHERE workspace_id = current_setting('app.current_workspace_id', true)::uuid
```
`current_setting(key, true)` returns `NULL` rather than raising when the GUC
is unset — the exact fail-*open* shape migration 0044 deliberately eliminated
from every `workspace_isolation` policy ("the `missing_ok` second argument to
`current_setting` must ALSO go, or a genuinely untouched connection still
returns zero rows instead of erroring" — 0044's own header comment). This one
call site still uses it. It is not currently exploitable: this function only
ever runs inside `withTenantTransaction`, so the RLS policy itself
(bare-cast, fail-closed as of 0044) would already throw before this WHERE
clause could matter today. But it is the one place in the reviewed diff that
reintroduces the null-tolerant pattern the rest of the migration set was
written specifically to retire, and it will silently do the wrong thing
(return zero rows instead of raising, masking a programming error as "no such
record") if this function is ever reused from a context where the GUC
genuinely isn't set.

**Fix:** Use `getWorkspaceId()` and a bound parameter, matching every sibling
repository function:
```ts
const workspaceId = getWorkspaceId();
const { rows } = await client.query<WebhookEndpointRow>(
  `SELECT ... FROM workspace_webhook_endpoints WHERE workspace_id = $1`,
  [workspaceId]
);
```

### WR-04: CSV error-report download does not neutralize spreadsheet formula characters (CSV/formula injection)

**File:** `apps/api/src/modules/contacts/csv-import.routes.ts:46-51,271-294`
**Issue:** `GET /api/workspaces/:slug/imports/:id/errors` streams the
tenant's own uploaded row data back out as a downloadable CSV, escaped only
for RFC 4180 special characters:
```typescript
function csvEscape(value: string): string {
  if (/["\n,]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
```
A cell value beginning with `=`, `+`, `-`, or `@` is interpreted as a formula
by Excel, LibreOffice Calc, and Google Sheets when the downloaded file is
opened — the well-known CSV/formula-injection class (CWE-1236). A crafted CSV
row (e.g. an unmapped/error-column value of
`=HYPERLINK("http://evil/","x")`) survives into the error-report CSV
verbatim and executes when a marketer opens it in a vulnerable spreadsheet
client — e.g. a workspace member uploading a CSV containing another member's
name (or a supply-chain list from a third party) crafted to trigger a
formula when whoever reviews the import error report opens it.

**Fix:** Prefix any value starting with `=`, `+`, `-`, `@`, tab, or CR with a
neutralizing character (commonly `'`) before quoting:
```typescript
function csvEscape(value: string): string {
  const neutralized = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  if (/["\n,]/.test(neutralized)) {
    return `"${neutralized.replace(/"/g, '""')}"`;
  }
  return neutralized;
}
```

### WR-05: Locally re-typed 404 body literals duplicate `NOT_FOUND_BODY` instead of importing it

**File:** `apps/api/src/modules/tenancy/invites.ts:70,104,154`; `apps/api/src/modules/campaigns/campaigns.routes.ts:301,351,386,406`; `apps/api/src/modules/flows/flows.routes.ts:255,303,327,417,445`
**Issue:** `resolve-workspace-member.ts` defines and documents
`NOT_FOUND_BODY` as "the ONE shared 404 body every workspace-membership
failure path sends... Frozen so no caller can mutate a shared reference and
accidentally desync the four failure paths that must stay byte-identical,"
and `role-guard.ts`'s own `requirePermission` deliberately imports that exact
constant rather than re-typing it, with a comment explaining why: "an
imported reference, not a re-typed literal, so this independently-written 404
branch cannot silently drift from the resolver's byte-identical
missing-vs-forbidden contract."

The routes listed above — every `requirePermission`-gated route in
`campaigns.routes.ts` and `flows.routes.ts` that calls
`findActiveWorkspaceBySlug` directly
(schedule/cancel/duplicate/publish/pause/resume/eject/delete), and every
`findActiveWorkspaceBySlug`-based branch in `invites.ts`'s
create/list/resend routes — instead send a hand-typed
`{ error: "Workspace not found" }` literal. Today the bytes happen to match
`NOT_FOUND_BODY`, so there is no live behavioral bug, but this is exactly the
drift risk the codebase's own SEC-14/T-10-04-02 discipline was written to
prevent: a future edit to `NOT_FOUND_BODY`'s shape (e.g. adding a `code`
field, or changing the message for i18n) will silently diverge across these
~12 call sites, reintroducing a workspace-enumeration oracle the rest of the
codebase deliberately closed one call site at a time.

**Fix:** Import `NOT_FOUND_BODY` from `resolve-workspace-member.ts` and reuse
it in every one of these branches:
```typescript
import { NOT_FOUND_BODY } from "../tenancy/resolve-workspace-member.js";
// ...
const workspace = await findActiveWorkspaceBySlug(slug);
if (!workspace) {
  return reply.code(404).send(NOT_FOUND_BODY);
}
```

## Info

### IN-01: `requirePermission`'s catch-all maps every thrown error to a 404, not only "not a member"

**File:** `apps/api/src/middleware/role-guard.ts:64-81`
**Issue:** The `catch` block around `auth.api.hasPermission(...)` is
documented as handling the specific case where better-auth throws for
"caller isn't a member of `organizationId`," but the code catches
unconditionally: any error from `hasPermission` — a network hiccup, a
malformed body, an internal library bug — is mapped to the same generic 404
whenever `organizationId` is set. This mirrors `resolveWorkspaceMember`'s own
documented "any throw → 404" anti-enumeration design, so it is consistent
with an established codebase convention rather than a new defect, but it does
mean a genuine internal error on this path is indistinguishable from "not a
member" in logs/monitoring unless the error is also logged before being
swallowed.

**Fix:** Consider logging the caught error (at debug/warn level, since the
404 itself must stay silent to the caller) so an operator can tell "the
anti-enumeration guard worked as designed" apart from "hasPermission is
broken" without needing to reproduce the request.

---

_Reviewed: 2026-08-09T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
