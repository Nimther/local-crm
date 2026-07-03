---
phase: 01-workspace-foundation-team-access
reviewed: 2026-07-03T13:09:31Z
depth: standard
files_reviewed: 71
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
findings:
  critical: 0
  warning: 5
  info: 4
  total: 9
status: issues_found
---

# Phase 01: Code Review Report

**Reviewed:** 2026-07-03T13:09:31Z
**Depth:** standard
**Files Reviewed:** 71
**Status:** issues_found

## Summary

Phase 01 (workspace foundation, team access, invite lifecycle, RLS-isolated tenant SendGrid key + KMS envelope encryption) is a well-structured, defensively-commented implementation. The multi-tenancy substrate (AsyncLocalStorage tenant context + `SET LOCAL` + Postgres RLS with `FORCE ROW LEVEL SECURITY`), the two-key separation (platform vs. tenant SendGrid), and the envelope-encryption scheme are correctly built and directly test-covered.

**The four prior blockers are confirmed fixed and hold:**
- **CR-01** (unauthenticated GET sendgrid-key): the GET route now calls `getCallerRoles`, which throws for unauthenticated/non-member/unknown-slug alike and maps every throw to the same 404 — no keyMask leak, no enumeration oracle. Verified by `sendgrid-key-connect.test.ts` ("GET returns 404 for an unauthenticated caller" and the non-member/nonexistent parity test).
- **CR-02** (orgName HTML injection in invite email): `escapeHtml` entity-escapes `orgName` in `templates/invite.ts` before interpolation; `platform-mail.test.ts` locks it in with a `<script>` payload assertion.
- **CR-03** (missing pg Pool error handler): `pool.on("error", ...)` added in `db.ts`.
- **WR-02** (Members reading invite accept tokens): `GET /invites` now sits behind `requirePermission("invitation", "create")`; `invite-flow.test.ts` asserts a plain Member is 403'd while the Owner gets 200.

No new BLOCKER-severity defects were found. The findings below are robustness, defense-in-depth, and consistency issues (WARNING) plus minor quality notes (INFO).

## Warnings

### WR-01: Invite `resend` route bypasses the Owner-only gate for admin-role invitations

**File:** `apps/api/src/modules/tenancy/invites.ts:137-176`
**Issue:** The invite-**create** route explicitly enforces D-18 ("only the Owner may invite someone directly as Admin") by checking `parsed.data.role === "admin"` and requiring the caller be an owner. The **resend** route (`/invites/:invitationId/resend`, gated only by `requirePermission("invitation", "create")`, which Admins hold) re-creates the invitation with `existing.role` and `resend: true` with **no** equivalent owner check. An Admin can therefore refresh/re-issue a pending *admin* invitation (extending its 7-day expiry and re-sending the email), which D-18 intends to keep exclusively in the Owner's hands. This is not a fresh privilege grant (the admin invite was originally authorized by an Owner), so severity is limited to a defense-in-depth / policy-consistency gap rather than direct escalation.
**Fix:** Mirror the create-route guard in resend:
```ts
if ((existing.role ?? "member") === "admin") {
  const callerRoles = await getCallerRoles(headers, slug);
  if (!callerRoles.includes("owner")) {
    return reply.code(403).send({ error: "Только владелец может назначать роль администратора" });
  }
}
```

### WR-02: register-from-invite orphans a created account when `acceptInvitation` fails

**File:** `apps/api/src/modules/tenancy/invites.ts:287-313`
**Issue:** The D-12 flow calls `auth.api.signUpEmail` (creating the user account) and then, in a *separate* `auth.api.acceptInvitation` call, joins the workspace. If `acceptInvitation` throws (invite raced to canceled/expired between the earlier validity check and here, or any transient better-auth error), the newly-created account persists but is not attached to any workspace, and the response is an error. The user cannot retry register-from-invite (the `existingUser` check now returns 409) and is left with a dangling account they must separately log into. There is no compensating rollback/delete of the just-created user.
**Fix:** Either wrap account creation + accept so a failed accept deletes the just-created user, or detect this state on the accept path (user exists, not yet a member of the invite's org) and re-run accept using the current session rather than returning a hard error. At minimum, return a more actionable error directing the user to log in and accept.

### WR-03: `validateTenantSendGridKey` dereferences `scopes` and `results` without shape guards

**File:** `apps/api/src/modules/tenancy/sendgrid-client.ts:40-53`
**Issue:** After `scopesRes.ok`, the code does `const { scopes } = await scopesRes.json()` then `scopes.includes("mail.send")`. If SendGrid returns a 200 with an unexpected body (missing `scopes`, or `scopes` not an array — e.g. an API contract drift or a proxy/error page returning 200), `scopes.includes` throws a `TypeError`, which propagates out of the connect route as an unhandled 500 (it is not an `APIError`, so the route's `catch` rethrows). The same applies to `.results.map(...)` on the verified-senders response. This turns a recoverable "treat as invalid" outcome into a crash-shaped 500.
**Fix:** Validate the parsed shape before use, e.g. `const scopes = Array.isArray(body?.scopes) ? body.scopes : null; if (!scopes) return { valid: false, reason: "invalid" };` and guard `results` similarly (`Array.isArray(body?.results) ? body.results : []`). Parsing the external response with a Zod schema (already the project convention) is the cleanest fix.

### WR-04: `withTenantTransaction` error path relies on pg-pool internals, not the documented `release(true)` its own comment claims

**File:** `apps/api/src/middleware/tenant-context.ts:56-66`
**Issue:** The `catch` block's comment states "releasing below with `destroy=true` handles that case," but the `finally` calls `client.release()` with **no** argument. The connection is only reliably removed from the pool because pg-pool's internal `_release` independently checks `!client._queryable || client._ending` and removes dead clients (confirmed by reading `pg-pool/index.js`) — an undocumented internal, not the public `release(err)` contract. In practice it works, but the code is fragile: it depends on the socket-error having already flipped `_queryable` before `release()` runs; if a dead connection is released before that flag propagates, it can briefly re-enter the pool and fail the next acquirer's first query (a 500, not a cross-tenant leak — `SET LOCAL` on a terminated backend cannot bleed state). Separately, the `ROLLBACK` failure is swallowed with no log.
**Fix:** Make the intent explicit and correct: on the error path call `client.release(err)` (a truthy arg forces destroy), matching the comment. E.g. release with the captured error inside `catch` before rethrow, or track a `broken` flag and pass it to `release()` in `finally`. Log the swallowed ROLLBACK failure at debug level.

### WR-05: `KMS_LOCAL_KEK` is not validated at boot when `KMS_PROVIDER=local`, deferring failure to first key operation

**File:** `apps/api/src/env.ts:22-42`
**Issue:** The `superRefine` fails fast for two cases (local+production, and aws-without-KEK_ID) but does **not** require `KMS_LOCAL_KEK` to be present/valid when `KMS_PROVIDER=local`. A misconfigured local/staging deploy therefore boots and serves traffic successfully, then throws at the first SendGrid-key connect/recheck (inside `getLocalKek()` in `local-provider.ts`), surfacing as a runtime 500 on a user action rather than a boot failure. This contradicts the "fail before the server even starts listening" philosophy the file itself documents for the sibling KMS guards.
**Fix:** Add a `superRefine` branch: when `KMS_PROVIDER === "local"`, require `KMS_LOCAL_KEK` to be set and decode to exactly 32 bytes (hoist the check from `local-provider.ts`), so a bad local KEK is a boot error like the AWS path.

## Info

### IN-01: `maskKey` reveals the entire key for pathologically short inputs

**File:** `apps/api/src/modules/tenancy/sendgrid-key.ts:22-27`
**Issue:** `maskKey` takes `slice(0, min(6, len))` as prefix and `slice(-4)` as suffix. For any key ≤ 4 chars the prefix and suffix overlap and the mask reproduces the full key (e.g. a 4-char key → `abcd…abcd`). Real SendGrid keys are ~69 chars and are live-validated before `maskKey` runs, so this is not reachable in practice — but the masking function itself is not self-defending.
**Fix:** Guard against short inputs, e.g. return a fixed placeholder when `apiKey.length < 12`, or compute the suffix from chars after the prefix so they never overlap.

### IN-02: `GET /members` is an enumeration oracle (403 vs 404), inconsistent with the deliberately-hardened sendgrid-key GET

**File:** `apps/api/src/modules/tenancy/members.ts:24-51`
**Issue:** For a non-member the members list returns 403 (from `listMembers`), while a nonexistent slug returns 404 (from `findActiveWorkspaceBySlug`). The sendgrid-key GET route went out of its way to collapse both cases to an identical 404 to avoid a workspace-existence oracle (T-01-06/07/11); the members route leaves that oracle open. Low impact (slugs are user-chosen, not secret), but the inconsistency is worth noting since the codebase treats this as a real concern elsewhere.
**Fix:** For parity, resolve the workspace via `findActiveWorkspaceBySlug` first and map a non-member `listMembers` failure to the same 404, matching the sendgrid-key route's pattern.

### IN-03: `createUniqueWorkspaceSlug` has a check-then-insert TOCTOU race surfacing as an unhandled 500

**File:** `apps/api/src/modules/tenancy/workspaces.ts:27-41,78-96`
**Issue:** The slug uniqueness loop `SELECT`s for a free candidate, then `createOrganization` `INSERT`s it later. Two concurrent creates with the same name can both observe the base slug free and both attempt it; the DB `organization_slug_unique` constraint correctly rejects the loser, but that error is a driver error (not `APIError`), so the route rethrows it as a 500 rather than retrying or returning a clean 4xx. Data integrity is preserved (the constraint holds); only the error surface is poor.
**Fix:** Catch the unique-violation (SQLSTATE `23505`) around `createOrganization` and retry slug generation a bounded number of times, or restructure as insert-with-retry rather than pre-checking.

### IN-04: Test-fixture secrets hardcoded in `vitest.config.ts`

**File:** `apps/api/vitest.config.ts:33-41`
**Issue:** A static `KMS_LOCAL_KEK` and a fake `PLATFORM_SENDGRID_API_KEY` are hardcoded as fallback defaults. These are clearly labeled test-only, are overridden by env when present, and never touch a real network (nock intercepts). Not a production-secret exposure, but flagged for completeness since a secret-scanner will match the base64 KEK literal.
**Fix:** No action required for correctness. Optionally source these from a `.env.test` to keep literal key material out of committed source.

---

_Reviewed: 2026-07-03T13:09:31Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
