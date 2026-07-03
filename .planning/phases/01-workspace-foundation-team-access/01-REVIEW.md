---
phase: 01-workspace-foundation-team-access
reviewed: 2026-07-03T14:29:09Z
depth: standard
files_reviewed: 69
files_reviewed_list:
  - apps/api/package.json
  - apps/api/src/db.ts
  - apps/api/src/db/__tests__/rls-pooling-chaos.test.ts
  - apps/api/src/env.ts
  - apps/api/src/kms/__tests__/envelope.test.ts
  - apps/api/src/kms/aws-provider.ts
  - apps/api/src/kms/client.ts
  - apps/api/src/kms/local-provider.ts
  - apps/api/src/middleware/role-guard.ts
  - apps/api/src/middleware/tenant-context.ts
  - apps/api/src/modules/auth/__tests__/password-reset.test.ts
  - apps/api/src/modules/auth/access-control.ts
  - apps/api/src/modules/auth/auth.ts
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
  - packages/db/migrations/0000_init_auth.sql
  - packages/db/migrations/0001_rls_policies.sql
  - packages/db/migrations/0002_invitation_created_at.sql
  - packages/db/src/schema/auth.ts
  - packages/db/src/schema/sendgrid-keys.ts
  - packages/shared-schemas/src/auth.ts
  - packages/shared-schemas/src/index.ts
  - packages/shared-schemas/src/invite.ts
  - packages/shared-schemas/src/sendgrid-key.ts
  - scripts/check-env.mjs
findings:
  critical: 0
  warning: 4
  info: 4
  total: 8
status: issues_found
---

# Phase 1: Code Review Report

**Reviewed:** 2026-07-03T14:29:09Z
**Depth:** standard
**Files Reviewed:** 69
**Status:** issues_found

## Summary

Reviewed the workspace-foundation / team-access phase: env + boot config (the 01-07
gap-closure surface), the KMS envelope-encryption client, tenant-context/RLS plumbing,
better-auth-backed workspace/member/invite/sendgrid-key routes, and the full React
front end.

The code is careful and defensive. I independently confirmed the four prior findings
are still fixed in current code:
- **CR-01** (unauthenticated sendgrid-key GET): `GET /sendgrid-key` calls
  `getCallerRoles` and maps *any* throw to the same 404 as a nonexistent workspace;
  verified `getActiveMemberRole` throws `FORBIDDEN` for non-members/unauthenticated in
  better-auth's dist source. Enumeration-oracle test present. **Holds.**
- **CR-02** (orgName HTML injection): `templates/invite.ts` entity-escapes `orgName`
  before interpolation; test asserts `<script>` is neutralised. **Holds.**
- **CR-03** (missing pg Pool error handler): `db.ts` registers `pool.on("error", ...)`.
  **Holds.**
- **WR-02** (invite-token leak to Members): `GET /invites` is gated by
  `requirePermission("invitation","create")`; test asserts a plain Member is 403'd.
  **Holds.**

No Critical issues found. Four Warnings concern robustness/consistency (an asymmetric
env guard that lets the API boot into a runtime crash, an orphaned-account path in
register-from-invite, unguarded SendGrid response parsing, and stale active-org state
after soft-delete). Info items are minor consistency nits.

## Narrative Findings (AI reviewer)

## Warnings

### WR-01: Env schema requires `KMS_KEK_ID` for `aws` but does NOT require `KMS_LOCAL_KEK` for `local` — API boots then crashes at first key-connect

**File:** `apps/api/src/env.ts:18-42`
**Issue:** The `superRefine` enforces `KMS_KEK_ID` when `KMS_PROVIDER=aws`, but there is
no matching guard requiring `KMS_LOCAL_KEK` when `KMS_PROVIDER=local` (the default).
`KMS_LOCAL_KEK` is declared `z.string().optional()`, so the schema `safeParse` succeeds
with the `local` provider and no KEK. The missing-KEK error is deferred to runtime inside
`kms/local-provider.ts:getLocalKek()` (`throw new Error("KMS_LOCAL_KEK must be set...")`),
which surfaces as a 500 the first time a tenant connects a SendGrid key.
`scripts/check-env.mjs` catches this in dev, but only when `npm run dev` is launched from
the repo root (the `predev` hook). Launching the API directly (`npm run dev -w apps/api`,
or any staging/test path that sets `KMS_PROVIDER=local`) bypasses the checker and boots a
process that is guaranteed to fail on first use — precisely the "boot succeeds, breaks
later" masquerade class 01-07 set out to eliminate. The env schema, not the wrapper
script, should be the authoritative guarantee.
**Fix:** Add a symmetric guard in the `superRefine`:
```ts
if (val.KMS_PROVIDER === "local" && !val.KMS_LOCAL_KEK) {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: "KMS_LOCAL_KEK is required when KMS_PROVIDER=local (dev: `openssl rand -base64 32`)",
    path: ["KMS_LOCAL_KEK"],
  });
}
```

### WR-02: `register-from-invite` can leave an orphaned account that can never complete the invite

**File:** `apps/api/src/modules/tenancy/invites.ts:287-319`
**Issue:** The handler creates the account (`auth.api.signUpEmail`) and *then* accepts the
invitation in a second, non-atomic step. If `acceptInvitation` fails (APIError → early
return, or any other throw → 500), the user record already exists but the invitation is
not accepted and no session cookie is returned to the browser. On retry, the
`existingUser` check at lines 278-285 returns 409 ("account already exists — log in to
accept"), stranding the user: the account exists, the invite may still be pending, and the
UI's register path can no longer be used to complete it. The two writes should be atomic or
the failure path should be recoverable.
**Fix:** On `acceptInvitation` failure after a successful sign-up, forward the sign-up
`set-cookie` so the user lands signed-in on the invite-accept page (where the
existing-session accept button can retry), and/or in the 409 branch detect "own account,
matching email, invite still pending" and attempt the accept instead of hard-rejecting.

### WR-03: `validateTenantSendGridKey` assumes SendGrid response shape and doesn't guard `fetch` rejection — unhandled 500 on malformed/failed responses

**File:** `apps/api/src/modules/tenancy/sendgrid-client.ts:32-56`
**Issue:** Two unguarded assumptions:
1. `const { scopes } = (await scopesRes.json()) as SendGridScopesResponse;` then
   `scopes.includes("mail.send")`. If `scopesRes.ok` but the body lacks a `scopes` array
   (proxy/HTML 200, or an API shape change), `scopes` is `undefined` and `.includes`
   throws `TypeError`. Likewise `(...).results.map(...)` assumes `results` exists whenever
   `sendersRes.ok`.
2. A network-level `fetch` rejection (DNS failure, timeout) propagates out of
   `validateTenantSendGridKey`; the connect route (`sendgrid-key.ts:86`) has no try/catch
   around it, so it becomes an unhandled 500 rather than the friendly `INVALID_KEY_ERROR`.
**Fix:** Defensively coerce and wrap:
```ts
const body = (await scopesRes.json().catch(() => null)) as SendGridScopesResponse | null;
if (!body || !Array.isArray(body.scopes)) return { valid: false, reason: "invalid" };
if (!body.scopes.includes("mail.send")) return { valid: false, reason: "missing_scope" };
```
and treat a thrown `fetch` (or a non-array `results`) as `{ valid: false, reason: "invalid" }`
(or catch at the route and return 422 with `INVALID_KEY_ERROR`).

### WR-04: Custom soft-delete leaves stale `activeOrganizationId` that better-auth's own delete clears

**File:** `apps/api/src/modules/tenancy/workspaces.ts:159-182`
**Issue:** The DELETE handler deliberately bypasses better-auth's `organization.delete`
(to keep the row for soft-delete) and only runs `UPDATE organization SET deletedAt`.
better-auth's own `deleteOrganization` additionally calls
`adapter.setActiveOrganization(session.token, null)` (verified in `crud-org.mjs:280-284`).
Skipping that leaves every member's `session.activeOrganizationId` still pointing at the
now-deleted workspace. In this phase nothing routes off `activeOrganizationId` (tenant
context is resolved from the URL slug), so impact is currently cosmetic — but any future
code that trusts the session's active org, or any better-auth call that falls back to
`session.activeOrganizationId` when no explicit `organizationId` is passed, will silently
operate against a deleted workspace.
**Fix:** In the soft-delete handler also null out active-org state for affected sessions
(`UPDATE session SET "activeOrganizationId" = NULL WHERE "activeOrganizationId" = $1`), so
session state matches the deletion.

## Info

### IN-01: SendGrid recheck route is not gated by `requireVerifiedEmail` (inconsistent with connect)

**File:** `apps/api/src/modules/tenancy/sendgrid-key.ts:115-118`
**Issue:** `POST /sendgrid-key` (connect) uses `preHandler: [requirePermission(...),
requireVerifiedEmail]`, but `POST /sendgrid-key/recheck` uses only `requirePermission`.
Currently harmless (a key can only exist if an already-verified owner connected it), but
the asymmetry becomes a gap if verification state can ever be revoked.
**Fix:** Add `requireVerifiedEmail` to the recheck `preHandler`, or comment why it is
intentionally omitted.

### IN-02: `scripts/check-env.mjs` parser diverges from `tsx --env-file` semantics (no quote stripping)

**File:** `scripts/check-env.mjs:29-37`
**Issue:** The hand-rolled `.env` parser takes the raw slice after `=` without stripping
surrounding quotes or inline comments. It only checks presence/non-emptiness, so its
notion of "present" can diverge from what `tsx watch --env-file` actually loads for edge
cases, producing a green check for an env the API then rejects. Dev-only impact.
**Fix:** Reuse Node's own env parsing (`util.parseEnv` on Node 22) so checker and runtime
agree, or document that the checker is a presence-only heuristic.

### IN-03: `GET /api/workspaces/:slug` collapses a multi-role member to `role[0]`

**File:** `apps/api/src/modules/tenancy/workspaces.ts:122`
**Issue:** `Array.isArray(role) ? role[0] : role` returns only the first role and passes a
possibly comma-joined string (`"owner,admin"`) straight through. Front-end `ROLE_LABELS`
lookups (`WorkspaceHome.tsx`, `MemberRow.tsx`) then miss and render the raw string. Single
roles are the norm this phase, so cosmetic — but inconsistent with `members.ts`, which uses
`normalizeRoles(...).join(",")`.
**Fix:** Route this through `normalizeRoles` for one canonical representation.

### IN-04: `resend` on a non-pending (canceled) invitation silently creates a brand-new invite

**File:** `apps/api/src/modules/tenancy/invites.ts:137-176`
**Issue:** The resend route verifies workspace ownership, then calls `createInvitation({
..., resend: true })`. better-auth only *refreshes* an existing invite when
`findPendingInvitation` returns a row (`crud-invites.mjs:128-160`); if the original was
canceled/expired there is no pending row, so it falls through and creates a fresh
invitation. The caller believes it resent the same invite.
**Fix:** Guard for `existing.status === "pending"` before resending (return 400/409 for
canceled invites), or document that resend-of-canceled intentionally issues a new invite.

---

_Reviewed: 2026-07-03T14:29:09Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
