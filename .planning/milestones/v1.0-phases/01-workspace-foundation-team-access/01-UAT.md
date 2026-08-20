---
status: complete
phase: 01-workspace-foundation-team-access
source: [01-01-SUMMARY.md, 01-02-SUMMARY.md, 01-03-SUMMARY.md, 01-04-SUMMARY.md, 01-05-SUMMARY.md, 01-06-SUMMARY.md, 01-07-SUMMARY.md, 01-VERIFICATION.md]
mode: mvp
user_story: "As a marketer, I want to create a workspace, bring my team in with the right permissions, and connect my SendGrid account, so that my company's email marketing runs on data fully isolated from every other workspace from day one."
started: 2026-07-03T13:38:11Z
updated: 2026-07-03T20:39:54Z
---

## Current Test

[testing complete]

## Tests

### 1. Cold Start Smoke Test
expected: Kill any running server/service. Clear ephemeral state (temp DBs, caches, lock files). Start the application from scratch — docker-compose services come up, migrations apply cleanly, API boots without errors, and the web app loads live data (login page renders).
result: pass

### 2. Register a New Account
expected: Open /register. Fill name, email, password and submit. You are signed in without errors and routed to the create-workspace step.
result: pass
note: re-run after 01-07 gap closure — original ECONNREFUSED gap resolved (see Gaps), browser confirmation received

### 3. Create a Workspace, Become Owner
expected: Enter a workspace name and submit. You land at /w/{slug}; the workspace home shows the workspace name and your role Owner (live server data), and the onboarding checklist renders with pending items (connect SendGrid, invite team).
result: pass

### 4. Email Verification Banner + Real Verification Email
expected: As this freshly registered (unverified) user, a verification banner is visible. Clicking resend delivers a real verification email from the platform noreply@ address; the app remains usable before verifying; following the link marks you verified and the banner disappears.
result: pass
note: initial run failed (missing platform SendGrid key in .env, then a transient 500 before restart); after user configured PLATFORM_SENDGRID_API_KEY/PLATFORM_MAIL_FROM the email delivered and verification completed. Config issue, not code — see Gaps (resolved).

### 5. Password Reset via Real Email
expected: Log out. From the login page open the reset-request flow, submit your email. A reset email arrives from the platform noreply@ address; following the link lets you set a new password in the browser, and you can log in with the new password.
result: pass

### 6. Profile Page
expected: Open your profile page. Editing display name persists (visible after reload). Change-password flow works with your current password. There is no email-change or avatar control.
result: pass

### 7. Invite a Colleague + Accept Flows
expected: On the Team page, invite a colleague by email with a role. The invite email arrives with an /invite/{id} link (org name rendered as plain text, no markup). The copyable-link control works. A brand-new user opening the link registers with the invite's fixed email and immediately joins with the assigned role; an existing account accepting also joins with its assigned role.
result: pass

### 8. Role-Gated Team UI (Member vs Owner/Admin)
expected: Logged in as a Member, the Team page hides invite/role-change/remove/delete-workspace controls, and the pending-invites list is not readable. As Owner, delete-workspace requires typing the workspace name to confirm, and the deleted workspace disappears from the switcher.
result: pass

### 9. Connect SendGrid Key (Real Keys)
expected: As Owner (verified email) open SendGrid key settings. Pasting a valid key with mail.send scope validates live and shows: masked key, status badge, verified senders table, and a working re-check button; the onboarding checklist item flips to done. An invalid/revoked key or a key missing mail.send is rejected with the exact clear error copy. A Member does not see the connect control.
result: pass

### 10. Workspace Isolation (User-Story Outcome)
expected: With a second account in its own workspace, opening the first workspace's URLs directly (/w/{first-slug} and its SendGrid key settings/API) yields 404/not-found — never the other tenant's data. The workspace switcher lists only workspaces you belong to.
result: pass

### 11. Register → create workspace → Owner over HTTP (integration-tested)
expected: A new user can register (email/password) and create a workspace over HTTP, becoming its Owner with a unique slug
result: pass
source: automated
coverage_id: 01-01/D1

### 12. RLS isolation survives pooled-connection reuse (chaos-tested)
expected: Cross-tenant data isolation on workspace_sendgrid_keys holds even after a pooled connection is killed mid-transaction and reused by another workspace's request
result: pass
source: automated
coverage_id: 01-01/D2

### 13. Schema + RLS migrations applied, zero pending
expected: Schema + RLS migrations are applied to the live database with zero pending migrations
result: pass
source: automated
coverage_id: 01-01/D3

### 14. /register signs in and routes to /create-workspace
expected: Visitor can register at /register and is signed in on success, routed to /create-workspace
result: pass
source: automated
coverage_id: 01-02/D1

### 15. Workspace home renders live server data
expected: Creating a workspace navigates to /w/{slug}; workspace home renders live server data (name + Owner role) via TanStack Query
result: pass
source: automated
coverage_id: 01-02/D2

### 16. Workspace switcher lists user's workspaces
expected: App shell shows a workspace switcher listing the user's workspaces with the active one highlighted, plus a 'Создать воркспейс' item
result: pass
source: automated
coverage_id: 01-02/D3

### 17. Onboarding checklist is data-driven and extensible
expected: Onboarding checklist renders extensible items (SendGrid, invite team) with per-item done/pending state, data-driven
result: pass
source: automated
coverage_id: 01-02/D4

### 18. Mutating buttons disable during requests
expected: Every mutating button shows a disabled + loading state during its request (no double-submit)
result: pass
source: automated
coverage_id: 01-02/D5

### 19. Platform mail client structurally isolated from tenant key module
expected: Platform SendGrid client (platformMail) dispatches sendReset/sendVerification/sendInvite using only PLATFORM_SENDGRID_API_KEY/PLATFORM_MAIL_FROM, structurally isolated from the tenant key module
result: pass
source: automated
coverage_id: 01-03/D1

### 20. Password reset token flow authenticates new password
expected: Password reset flow: request-reset issues an email via platformMail, consuming the token sets a new password that authenticates
result: pass
source: automated
coverage_id: 01-03/D2

### 21. Verification state + requireVerifiedEmail gate
expected: isEmailVerified reports false for a freshly registered (unverified) user; requireVerifiedEmail gate exists for downstream (01-05) use
result: pass
source: automated
coverage_id: 01-03/D3

### 22. Invite creation dispatches platform mail with accept URL
expected: Owner/Admin invites by email; an invitation is created and platformMail.sendInvite is called with a /invite/{id} accept URL
result: pass
source: automated
coverage_id: 01-04/D1

### 23. Register-from-invite joins with assigned role
expected: register-from-invite (D-12): a new user registers with the invite's fixed email + supplied name/password and immediately joins with the assigned role
result: pass
source: automated
coverage_id: 01-04/D2

### 24. Existing-account accept, expiry/revoke rejection, resend
expected: An existing-account invitee accepts and joins with the assigned role; a >7-day-old or revoked invite is rejected; resend reissues a fresh token
result: pass
source: automated
coverage_id: 01-04/D3

### 25. Role matrix enforced server-side
expected: Member is 403 on invite/updateMemberRole/removeMember/delete-workspace; Admin can invite/remove Member but is 403 assigning Admin role or transferring ownership; only Owner succeeds at both plus workspace delete
result: pass
source: automated
coverage_id: 01-04/D4

### 26. Workspace delete is Owner-only soft delete with name re-validation
expected: DELETE /api/workspaces/:slug is Owner-only, re-validates the submitted name server-side, sets deleted_at, and soft-deleted workspaces are excluded from list/read
result: pass
source: automated
coverage_id: 01-04/D5

### 27. Valid key validates live, envelope-encrypted at rest
expected: A valid key with mail.send validates live, is envelope-encrypted and stored, and verified senders are returned
result: pass
source: automated
coverage_id: 01-05/D1

### 28. Invalid/insufficient keys rejected with exact copy
expected: An invalid/revoked key and a key missing mail.send are each rejected with the exact UI-SPEC copy
result: pass
source: automated
coverage_id: 01-05/D2

### 29. Member 403; unverified-email Owner refused with verify copy
expected: A Member is refused (403); Owner succeeds. An unverified-email Owner is refused with the exact verify-email copy
result: pass
source: automated
coverage_id: 01-05/D3

### 30. KMS envelope round-trip and production-boot guard
expected: KMS envelope round-trip (encrypt/decrypt), no plaintext DEK exposure, DEK zeroed after use, workspaceId-bound encryption, and the local-provider production-boot guard
result: pass
source: automated
coverage_id: 01-05/D4

### 31. GET sendgrid-key uniform 404 for unauth/non-member (CR-01)
expected: GET /api/workspaces/:slug/sendgrid-key returns 404 (not 200) for unauthenticated and non-member callers, and the identical 404 body for a nonexistent workspace, closing the cross-tenant info-disclosure and enumeration oracle (CR-01 blocker).
result: pass
source: automated
coverage_id: 01-06/D1

### 32. GET /invites permission-gated (WR-02)
expected: GET /api/workspaces/:slug/invites is 403 for a plain Member (accept tokens no longer leak); Owner still gets 200 (WR-02).
result: pass
source: automated
coverage_id: 01-06/D2

### 33. Invite email escapes orgName (CR-02)
expected: Invite email HTML body HTML-escapes attacker-controlled orgName, neutralizing injected markup (CR-02).
result: pass
source: automated
coverage_id: 01-06/D3

### 34. pg Pool error listener (CR-03)
expected: Production pg Pool has an 'error' listener logging idle-connection termination instead of crashing the process (CR-03).
result: pass
source: automated
coverage_id: 01-06/D4

## Summary

total: 34
passed: 34
issues: 0
pending: 0
skipped: 0
blocked: 0

## Gaps

- truth: "Submitting the /register form signs the user in and routes to the create-workspace step"
  status: resolved
  resolved_by: "01-07 (commits 7572608, f039ebe, 5a93c99)"
  resolution: ".env/.env.example completed with platform-mail + KMS vars; env.ts now safeParses with a human-readable secret-safe boot error; scripts/check-env.mjs wired as predev so npm run dev fails loudly on missing env. Verifier re-ran the exact failing endpoint live against the real .env: POST /api/auth/sign-up/email → 200 + session cookie, create-workspace → 200 role:owner. Test 2 reset to pending for browser re-run."
  reason: "User reported: generic failure toast on submit; vite dev-server console shows http proxy error for /api/auth/sign-up/email — AggregateError ECONNREFUSED (API server unreachable from the web dev proxy)"
  severity: blocker
  test: 2
  root_cause: "Cold-start env drift: plans 01-03/01-05 added required env vars (PLATFORM_SENDGRID_API_KEY, PLATFORM_MAIL_FROM) to apps/api/src/env.ts but .env and .env.example were never updated. envSchema.parse throws a ZodError at import (env.ts:44), the API exits before listen(); tsx watch keeps the process tree alive so the stack looks up while nothing listens on :4000 — vite proxy gets ECONNREFUSED. Latent: KMS_LOCAL_KEK also missing (lazily validated — will break SendGrid key connect, UAT Test 9)."
  artifacts:
    - path: ".env"
      issue: "missing PLATFORM_SENDGRID_API_KEY, PLATFORM_MAIL_FROM (and KMS_PROVIDER/KMS_LOCAL_KEK)"
    - path: ".env.example"
      issue: "stale — never updated when 01-03/01-05 added required env vars; gives no hint on cold start"
    - path: "apps/api/src/env.ts"
      issue: "throws raw ZodError at import; crash is invisible under tsx watch (dev stack masquerades as healthy)"
  missing:
    - "Add PLATFORM_SENDGRID_API_KEY, PLATFORM_MAIL_FROM, KMS_PROVIDER=local, KMS_LOCAL_KEK to .env"
    - "Document all required env vars (incl. KMS_KEK_ID for aws) in .env.example"
    - "Human-readable missing-env boot error in env.ts instead of raw Zod stack"
    - "Dev script should fail loudly when the API cannot boot (no silent crash under tsx watch)"
  debug_session: .planning/debug/registration-api-econnrefused.md

- truth: "Clicking resend on the verification banner delivers a real verification email from the platform noreply@ address"
  status: resolved
  resolution: "Environment configuration, not code: .env had a placeholder platform SendGrid key. After the user set a real PLATFORM_SENDGRID_API_KEY/PLATFORM_MAIL_FROM (and the transient 500 cleared on retry), resend delivered the email and the verification link worked. No fix plan needed."
  reason: "User reported: не отправляется. В консоли ошибка: Failed to load resource: the server responded with a status of 500 (Internal Server Error) — before platform key configuration took effect"
  severity: blocker
  test: 4
  root_cause: "placeholder PLATFORM_SENDGRID_API_KEY in local .env (operator config)"
  artifacts: []
  missing: []
  debug_session: ""
