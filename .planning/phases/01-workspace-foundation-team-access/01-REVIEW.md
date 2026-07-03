---
phase: 01-workspace-foundation-team-access
reviewed: 2026-07-03T11:41:33Z
depth: standard
files_reviewed: 72
files_reviewed_list:
  - apps/api/package.json
  - apps/api/src/db.ts
  - apps/api/src/db/__tests__/rls-pooling-chaos.test.ts
  - apps/api/src/env.ts
  - apps/api/src/kms/__tests__/envelope.test.ts
  - apps/api/src/kms/aws-provider.ts
  - apps/api/src/kms/client.ts
  - apps/api/src/kms/local-provider.ts
  - apps/api/src/logger.ts
  - apps/api/src/middleware/role-guard.ts
  - apps/api/src/middleware/tenant-context.ts
  - apps/api/src/modules/auth/__tests__/password-reset.test.ts
  - apps/api/src/modules/auth/access-control.ts
  - apps/api/src/modules/auth/auth.ts
  - apps/api/src/modules/auth/plugin.ts
  - apps/api/src/modules/auth/verification-gate.ts
  - apps/api/src/modules/platform-mail/__tests__/platform-mail.test.ts
  - apps/api/src/modules/platform-mail/client.ts
  - apps/api/src/modules/platform-mail/templates/invite.ts
  - apps/api/src/modules/platform-mail/templates/reset-password.ts
  - apps/api/src/modules/platform-mail/templates/verify-email.ts
  - apps/api/src/modules/tenancy/__tests__/invite-flow.test.ts
  - apps/api/src/modules/tenancy/__tests__/role-guard.test.ts
  - apps/api/src/modules/tenancy/__tests__/sendgrid-key-connect.test.ts
  - apps/api/src/modules/tenancy/__tests__/workspace-creation.test.ts
  - apps/api/src/modules/tenancy/invites.ts
  - apps/api/src/modules/tenancy/member-roles.ts
  - apps/api/src/modules/tenancy/members.ts
  - apps/api/src/modules/tenancy/profile.ts
  - apps/api/src/modules/tenancy/sendgrid-client.ts
  - apps/api/src/modules/tenancy/sendgrid-key.repository.ts
  - apps/api/src/modules/tenancy/sendgrid-key.ts
  - apps/api/src/modules/tenancy/workspace-lookup.ts
  - apps/api/src/modules/tenancy/workspaces.ts
  - apps/api/src/server.ts
  - apps/api/src/test/db-fixture.ts
  - apps/api/vitest.config.ts
  - apps/web/e2e/register-create-workspace.spec.ts
  - apps/web/src/App.tsx
  - apps/web/src/features/app-shell/AppShell.tsx
  - apps/web/src/features/auth/VerifyEmailBanner.tsx
  - apps/web/src/features/onboarding/OnboardingChecklist.tsx
  - apps/web/src/features/profile/ProfilePage.tsx
  - apps/web/src/features/sendgrid-key/KeyStatusBadge.tsx
  - apps/web/src/features/sendgrid-key/SendGridKeySettings.tsx
  - apps/web/src/features/team/DeleteWorkspaceDialog.tsx
  - apps/web/src/features/team/InviteModal.tsx
  - apps/web/src/features/team/MemberRow.tsx
  - apps/web/src/features/team/TeamPage.tsx
  - apps/web/src/features/workspace-home/WorkspaceHome.tsx
  - apps/web/src/features/workspace-switcher/WorkspaceSwitcher.tsx
  - apps/web/src/lib/api.ts
  - apps/web/src/lib/authClient.ts
  - apps/web/src/lib/queryClient.ts
  - apps/web/src/main.tsx
  - apps/web/src/routes/create-workspace.tsx
  - apps/web/src/routes/invite-accept.tsx
  - apps/web/src/routes/login.tsx
  - apps/web/src/routes/register.tsx
  - apps/web/src/routes/reset-password.tsx
  - apps/web/src/routes/reset-request.tsx
  - docker-compose.yml
  - docker/init-app-role.sql
  - packages/db/migrations/0000_init_auth.sql
  - packages/db/migrations/0001_rls_policies.sql
  - packages/db/migrations/0002_invitation_created_at.sql
  - packages/db/src/schema/auth.ts
  - packages/db/src/schema/sendgrid-keys.ts
  - packages/shared-schemas/src/auth.ts
  - packages/shared-schemas/src/index.ts
  - packages/shared-schemas/src/invite.ts
  - packages/shared-schemas/src/sendgrid-key.ts
findings:
  critical: 3
  warning: 7
  info: 9
  total: 19
status: issues_found
---

# Phase 1: Code Review Report

**Reviewed:** 2026-07-03T11:41:33Z
**Depth:** standard
**Files Reviewed:** 72
**Status:** issues_found

## Summary

Reviewed the full Phase 1 surface: Fastify API (auth, tenancy, invites, members, SendGrid key connect, KMS envelope encryption, RLS tenant context), Drizzle schema + migrations + RLS policies, shared Zod schemas, React web app, and the test suite. The core architecture is sound — `SET LOCAL` GUC inside AsyncLocalStorage-scoped transactions, `FORCE ROW LEVEL SECURITY` on the domain table, envelope encryption with workspace-bound AAD/EncryptionContext, and the two-key (platform vs tenant SendGrid) separation are all correctly implemented and well-tested. Better-auth internals cited in comments (custom `ac` roles replacing defaults, `cancelInvitation` scoping to the invitation's own org, last-owner protection on role update/removal) were verified against `node_modules/better-auth/dist` and hold.

However, three ship-blocking defects exist: an **entirely unauthenticated endpoint** exposing tenant SendGrid key masks/status cross-tenant, **HTML injection** of the attacker-controllable workspace name into platform-sent invite emails, and a **missing `pg` Pool error handler** that will crash the production API process on any idle-connection termination. Several role/permission and invite-lifecycle gaps degrade the D-17/D-18/D-20 guarantees below.

## Critical Issues

### CR-01: GET sendgrid-key status endpoint has no authentication or membership check

**File:** `apps/api/src/modules/tenancy/sendgrid-key.ts:36-54`
**Issue:** The route comment says "visible to any workspace member", but the handler performs **no session check and no membership check whatsoever**. It resolves the slug via `findActiveWorkspaceBySlug` (a plain DB lookup) and then reads the key row under `withTenant(workspace.id, ...)` — the app itself supplies the RLS GUC, so RLS grants access. Any caller on the network, **including fully unauthenticated ones**, can fetch `keyMask` (first 6 + last 4 characters of the tenant's SendGrid API key), `status`, and `lastCheckedAt` for **any workspace** by guessing or knowing its slug (slugs are derived from company names, e.g. `acme-marketing`). This is a cross-tenant information disclosure of partial secret material and a workspace-enumeration oracle. No test covers the unauthenticated case (sendgrid-key-connect.test.ts only exercises POST).
**Fix:**
```ts
fastify.get("/api/workspaces/:slug/sendgrid-key", async (request, reply) => {
  const { slug } = request.params as { slug: string };
  const workspace = await findActiveWorkspaceBySlug(slug);
  if (!workspace) return reply.code(404).send({ error: "Workspace not found" });

  // Require an authenticated member of THIS workspace before revealing anything.
  try {
    await auth.api.getActiveMember({
      headers: toFetchHeaders(request),
      query: { organizationId: workspace.id },
    });
  } catch {
    return reply.code(404).send({ error: "Workspace not found" });
  }
  // ... existing withTenant(getKey()) logic
});
```
Add a regression test asserting 401/404 for an unauthenticated caller and for a non-member session.

### CR-02: HTML injection of workspace name into platform invite emails (phishing vector)

**File:** `apps/api/src/modules/platform-mail/templates/invite.ts:5,7` (and subject at `apps/api/src/modules/platform-mail/client.ts:49`)
**Issue:** `renderInviteHtml` interpolates `params.orgName` directly into the HTML body with no escaping. Workspace names are arbitrary user input (`createWorkspaceSchema`: any string up to 120 chars). Any user can register, create a workspace named e.g. `x</h1><a href="https://evil.example">Войти в CRM</a>`, and invite **any email address** — the platform then delivers attacker-controlled HTML from the platform's own SendGrid identity (`PLATFORM_MAIL_FROM`). This is a phishing/content-spoofing vector that burns the platform's sender reputation (the exact asset D-07 exists to protect). The same unescaped value also lands in the subject line.
**Fix:**
```ts
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
// in renderInviteHtml:
const orgName = escapeHtml(params.orgName);
```
Apply escaping to every user-influenced value in every template going forward (URLs here are server-constructed, but escape them too as defense-in-depth).

### CR-03: Production pg Pool has no `error` listener — idle-connection termination crashes the API process

**File:** `apps/api/src/db.ts:13`
**Issue:** node-postgres emits `'error'` on the `Pool` when an **idle** pooled client's connection dies (Postgres restart, failover, `idle_in_transaction` timeout, network blip). With no listener, Node treats it as an uncaught exception and **kills the process**. The chaos test (`apps/api/src/db/__tests__/rls-pooling-chaos.test.ts:31`) attaches `pool.on("error", ...)` and its own comment states "a pool-wide swallow is the correct, permanent guard — not a per-test workaround" — yet the handler exists **only in the test file**, never in production code. Verified: no `pool.on("error")` anywhere under `apps/api/src` outside `__tests__`. Every routine Postgres maintenance event will take down the API in production.
**Fix:**
```ts
// apps/api/src/db.ts
export const pool = new Pool({ connectionString: env.DATABASE_URL });
pool.on("error", (err) => {
  logger.error({ err }, "idle pg pool client error (connection dropped)");
});
```

## Warnings

### WR-01: `withTenantTransaction` returns dead connections to the pool despite comment claiming otherwise

**File:** `apps/api/src/middleware/tenant-context.ts:56-66`
**Issue:** The ROLLBACK catch block's comment says "releasing below with `destroy=true` handles that case", but the `finally` calls `client.release()` with **no argument** — the (potentially poisoned/mid-aborted) connection is returned to the pool intact. The next request that checks it out will fail its first query. The code does not do what its comment claims.
**Fix:**
```ts
let failed: unknown;
try {
  ...
} catch (err) {
  failed = err;
  try { await client.query("ROLLBACK"); } catch { /* dead conn */ }
  throw err;
} finally {
  // destroy the connection instead of recycling it when the transaction failed
  client.release(failed !== undefined ? true : undefined);
}
```

### WR-02: Invite listing has no permission gate — a plain Member can harvest invite URLs (accept tokens)

**File:** `apps/api/src/modules/tenancy/invites.ts:87-111` (with `toInviteResponse` at :22-37)
**Issue:** `GET /api/workspaces/:slug/invites` has no `requirePermission` preHandler. Verified against `better-auth/dist/plugins/organization/routes/crud-invites.mjs:524-541`: `listInvitations` only checks **membership**, not any `invitation` permission. Per D-17, a Member has zero invitation permissions — yet a Member can list every pending invite, and the response includes `inviteUrl`, where the invitation ID **is** the accept credential (`/invite/{id}`). A Member can obtain the invite link for a pending **admin** invite. Exploitation requires controlling the invitee mailbox to accept, but this still discloses invitee emails, assigned roles, and live tokens beyond the Member role's grant.
**Fix:** Add `{ preHandler: requirePermission("invitation", "create") }` to the list route (Team page only renders invite rows for Owner/Admin anyway), or strip `inviteUrl` from the payload for non-managers.

### WR-03: Soft-deleted workspaces are never checked in the invite preview/accept/register paths

**File:** `apps/api/src/modules/tenancy/invites.ts:182-222` (preview), `:267-271` (register), `:224-247` (accept)
**Issue:** The public preview looks up the organization with `eq(organization.id, ...)` — not `findActiveWorkspaceBySlug` — so it ignores `deletedAt`. Register-from-invite checks only `status === "pending"` and expiry. better-auth's `acceptInvitation` knows nothing about the project-added `deletedAt` field. Result: an invite to a workspace the Owner soft-deleted (D-20) still previews as "pending" and can be accepted/registered — creating an account + membership in a workspace that 404s everywhere else. D-20's "excluded from reads exactly like a non-existent one" contract is broken on this path.
**Fix:** In the preview handler and the register handler, treat `org.deletedAt != null` as `404 Invitation not found` (or status `revoked`), mirroring `findActiveWorkspaceBySlug` semantics.

### WR-04: Register-from-invite is non-atomic — accept failure strands a signed-up account with no session

**File:** `apps/api/src/modules/tenancy/invites.ts:283-315`
**Issue:** The handler calls `signUpEmail` (account created, session issued), then `acceptInvitation`. If the accept fails (invite revoked/accepted between the pending-check at :270 and the accept at :300 — a real race with the revoke endpoint), the error response is returned **without forwarding the session cookies** (the `reply.header("set-cookie", ...)` at :311 is only reached on success). The user now has an account they don't know exists; retrying the form hits the 409 "already exists" branch with no way forward except guessing they must log in. The account creation is a committed side effect of a failed request.
**Fix:** Forward `setCookies` on the accept-failure path too (the user is at least signed in and can be routed to log-in-and-retry UX), or validate the invite status again via better-auth's accept error and return a body flag (`accountCreated: true`) the frontend can act on.

### WR-05: SendGrid validation fetches have no timeout and trust the response shape

**File:** `apps/api/src/modules/tenancy/sendgrid-client.ts:33-45`
**Issue:** Both `fetch` calls have no `AbortSignal` — a hung SendGrid API call hangs the connect/recheck request (and its DB-adjacent work) indefinitely; there is no route-level timeout either. Additionally, `const { scopes } = await scopesRes.json()` then `scopes.includes(...)` at :41 will throw `TypeError: Cannot read properties of undefined` (→ 500) if SendGrid ever returns 200 with an unexpected body.
**Fix:**
```ts
const scopesRes = await fetch("https://api.sendgrid.com/v3/scopes", {
  headers: { Authorization: `Bearer ${apiKey}` },
  signal: AbortSignal.timeout(10_000),
});
...
const body = (await scopesRes.json()) as Partial<SendGridScopesResponse>;
if (!Array.isArray(body.scopes)) return { valid: false, reason: "invalid" };
```
Wrap the whole call so an `AbortError`/network error maps to a clean 502/422 rather than an unhandled 500.

### WR-06: `requirePermission` does not handle `hasPermission` throwing — non-members get raw better-auth errors, not the guard's 403

**File:** `apps/api/src/middleware/role-guard.ts:50-63` (also `apps/api/src/modules/tenancy/workspaces.ts:140-147`)
**Issue:** Verified in `better-auth/dist/plugins/organization/organization.mjs:60-77`: the `hasPermission` endpoint **throws** `APIError("UNAUTHORIZED")` when the caller is not a member of the target organization (and the session middleware throws 401 when unauthenticated) — it only returns `{ success: false }` for members lacking the permission. `requirePermission` has no try/catch, so for non-members/unauthenticated callers the guard's 403/404 contract is bypassed and Fastify's default error handler serializes better-auth's raw error body (different shape from the app's `{ error: string }`, and confirms workspace membership state via status-code differences). Same pattern: `GET /api/workspaces` (list) calls `auth.api.listOrganizations` with no try/catch. All existing tests only exercise member-with/without-permission cases, so this path is untested.
**Fix:** Wrap the `auth.api.hasPermission` call in try/catch; on `APIError`, send 403 (or 404 to avoid membership disclosure) with the app's error shape.

### WR-07: Password change does not revoke other sessions

**File:** `apps/api/src/modules/tenancy/profile.ts:52-59`
**Issue:** `auth.api.changePassword` is called without `revokeOtherSessions: true`. With D-04's 30-day sliding sessions, a user changing their password after suspected compromise leaves the attacker's stolen session valid for up to 30 more days. This is the standard reason password-change flows revoke other sessions.
**Fix:**
```ts
await auth.api.changePassword({
  headers: toFetchHeaders(request),
  body: { currentPassword, newPassword, revokeOtherSessions: true },
});
```

## Info

### IN-01: Dead `process.env.DATABASE_URL` assignments in every test `beforeAll`

**File:** `apps/api/src/db/__tests__/rls-pooling-chaos.test.ts:23` (repeated in workspace-creation, invite-flow, role-guard, sendgrid-key-connect, password-reset tests)
**Issue:** `process.env.DATABASE_URL = getTestDatabaseUrl()` runs after `env.ts` has already parsed the environment at module import (and `vitest.config.ts` already injects `DATABASE_URL` from `TEST_DATABASE_URL`). The assignment is a no-op that misleads readers about what actually routes tests to the test DB.
**Fix:** Delete the assignments; rely on (and document) the `vitest.config.ts` `test.env` block.

### IN-02: Production-boot-guard test may be passing via env.ts, not the local-provider guard

**File:** `apps/api/src/kms/__tests__/envelope.test.ts:62-68`
**Issue:** After `vi.resetModules()` + `NODE_ENV=production`, importing `local-provider.js` re-imports `env.js`, whose `superRefine` throws a ZodError whose message also matches `/production/i` (env.ts:31). The test cannot distinguish which guard fired, so the module-level guard in local-provider.ts:16-20 may be untested.
**Fix:** Assert on the local-provider-specific message (`/local-provider\.ts must never be imported/`), or stub `env` so only the module guard can throw.

### IN-03: Comma-joined multi-role strings break client-side role logic

**File:** `apps/web/src/features/team/MemberRow.tsx:123` (also `ROLE_LABELS` lookups in TeamPage/WorkspaceHome/invite-accept)
**Issue:** The API joins normalized roles with `","` (`members.ts:42`), and better-auth supports multi-role strings (`"owner,admin"` — its own guards `split(",")`). `row.role === "owner"` and `ROLE_LABELS[row.role]` do exact-match, so a multi-role member renders a raw string and dodges the client-side owner/admin gating (server-side enforcement still holds).
**Fix:** Split on `","` client-side (`row.role.split(",").includes("owner")`) or have the API return a role array.

### IN-04: Revoke route doesn't scope the invitation to the slug workspace; resend lets an Admin refresh an Owner-created Admin invite

**File:** `apps/api/src/modules/tenancy/invites.ts:113-131` (revoke), `:133-172` (resend)
**Issue:** Unlike resend (which verifies `existing.organizationId === workspace.id`), revoke passes `invitationId` straight to better-auth. Verified safe cross-tenant (better-auth re-checks permission against the invitation's own org, crud-invites.mjs:427-439), but the slug in the URL is decorative — inconsistent with the sibling route. Separately, resend re-creates the invite with its stored role without re-running the D-18 owner-only check, so an Admin can indefinitely extend an admin-role invite's validity (cannot create one, though).
**Fix:** Add the same `organizationId` ownership check to revoke; in resend, re-apply the `role === "admin" → owner-only` check.

### IN-05: `maskKey` can reveal an entire short key (mask overlap)

**File:** `apps/api/src/modules/tenancy/sendgrid-key.ts:21-26`
**Issue:** For keys shorter than 10 chars, `slice(0, 6)` and `slice(-4)` overlap and the "mask" reproduces the whole key. `connectSendgridKeySchema` only enforces `min(1)`. Only reachable if SendGrid live-validates such a key (real keys are 69 chars), so impact is theoretical.
**Fix:** Enforce a realistic minimum (`min(20)` and/or `startsWith("SG.")`) in `connectSendgridKeySchema`, or return a fixed-shape mask when `apiKey.length < 12`.

### IN-06: Slug generation TOCTOU and pre-auth work on POST /api/workspaces

**File:** `apps/api/src/modules/tenancy/workspaces.ts:27-41,70-76`
**Issue:** (a) Two concurrent creates with the same name can both pass the `findFirst` uniqueness probe; the loser hits the DB unique constraint inside `createOrganization`, surfacing as an unhandled non-APIError → 500 rather than a retry. (b) `createUniqueWorkspaceSlug` runs before any session check, so unauthenticated callers burn up to 6 DB queries per request before the 401.
**Fix:** Check the session first; on unique-violation from `createOrganization`, retry slug generation once.

### IN-07: RootRedirect misroutes to /create-workspace when the workspace list query errors

**File:** `apps/web/src/App.tsx:45-49`
**Issue:** If `GET /api/workspaces` fails (transient 5xx, race on session), `workspaces` is `undefined` with `isPending` false, and the user with existing workspaces is redirected to the create-workspace onboarding screen. No `isError` branch exists.
**Fix:** Handle `isError` with a retry/error state instead of falling through to the empty-list branch.

### IN-08: Unhandled promise rejections in reset-request submit and verify-banner resend

**File:** `apps/web/src/routes/reset-request.tsx:39-45`, `apps/web/src/features/auth/VerifyEmailBanner.tsx:24-39`
**Issue:** Both handlers `await` an authClient call with no `catch`. better-auth's client normally returns `{ error }`, but a thrown network error (offline, proxy down) escapes: reset-request never reaches `setSubmitted(true)` and shows nothing; the banner's `try/finally` resets `sending` but re-throws into an unhandled rejection.
**Fix:** Wrap both in try/catch and surface the generic error copy.

### IN-09: Hardcoded dev DB credentials in checked-in init script

**File:** `docker/init-app-role.sql:10`, `docker-compose.yml:8`
**Issue:** `mega_crm_app / mega_crm_dev_pw` and `postgres/postgres` are hardcoded. Acceptable for the local docker-compose dev loop, but nothing in the file prevents the script's reuse against a non-dev database.
**Fix:** Add a loud "LOCAL DEV ONLY" header comment and/or read the password from a compose env var.

---

_Reviewed: 2026-07-03T11:41:33Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
