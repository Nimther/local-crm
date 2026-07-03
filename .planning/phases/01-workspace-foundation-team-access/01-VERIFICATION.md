---
phase: 01-workspace-foundation-team-access
verified: 2026-07-03T11:47:53Z
status: gaps_found
score: 4/5 must-haves verified
behavior_unverified: 0
overrides_applied: 0
mode_note: "ROADMAP.md marks this phase mode: mvp, but the phase goal text does not match the required User Story format (`As a ..., I want ..., so that ....`) -- gsd_run query user-story.validate returned valid=false. Standard goal-backward verification (ROADMAP Success Criteria + PLAN must_haves) was used instead of MVP User-Flow-Coverage verification. Recommend either clearing mode: mvp or rewriting the goal as a proper User Story before the next MVP-mode phase runs."
gaps:
  - truth: "A user in one workspace cannot see or access any contact, event, campaign, or statistic belonging to another workspace (Success Criterion 5 / TENANT-05)"
    status: failed
    reason: "GET /api/workspaces/:slug/sendgrid-key has zero authentication and zero membership check (CR-01 in 01-REVIEW.md, still present on HEAD 4633372). The route resolves the workspace by slug and then reads the SendGrid key row under the app's own withTenant(workspace.id) context -- the app supplies the RLS tenant GUC itself regardless of who is asking. Any caller on the network, including a fully unauthenticated one, can fetch keyMask (first 6 + last 4 chars of the tenant's SendGrid key), status, and lastCheckedAt for ANY workspace by knowing or guessing its slug. This is a live cross-tenant information-disclosure bug, not a hypothetical: no session cookie, no membership row, and no permission check are required to reach the data of a workspace you do not belong to."
    artifacts:
      - path: "apps/api/src/modules/tenancy/sendgrid-key.ts"
        issue: "Lines 36-54: fastify.get(\"/api/workspaces/:slug/sendgrid-key\", ...) has no preHandler at all (contrast with the POST connect/recheck routes on the same file, which both carry requirePermission). The route comment ('visible to any workspace member') does not match the code (visible to literally anyone)."
    missing:
      - "Add a session + active-membership check (e.g. auth.api.getActiveMember scoped to workspace.id) before reading/returning the key row; return 404 for both a nonexistent workspace and a non-member caller so the route can't be used as a workspace-enumeration oracle."
      - "Add a regression test asserting 401/404 for an unauthenticated caller and for an authenticated non-member of that workspace (sendgrid-key-connect.test.ts currently only exercises POST; there is zero GET coverage, confirmed by grep -- no `method: \"GET\"` anywhere in that file)."
---

# Phase 1: Workspace Foundation & Team Access Verification Report

**Phase Goal:** A marketer can create a workspace, bring their team in with the right permissions, and connect their SendGrid account — with every workspace's data fully isolated from day one.
**Verified:** 2026-07-03T11:47:53Z
**Status:** gaps_found
**Re-verification:** No — initial verification

## Mode Discrepancy Note

ROADMAP.md sets `Mode: mvp` for Phase 1, but the phase goal ("A marketer can create a workspace...") is not phrased as a User Story (`As a ..., I want ..., so that ....`). Running the canonical validator confirms this:

```
gsd_run query user-story.validate --story "A marketer can create a workspace, bring their team in with the right permissions, and connect their SendGrid account — with every workspace's data fully isolated from day one." --pick valid
=> false
```

Per the MVP-mode verification contract this phase should either have its `mode: mvp` cleared or its goal rewritten as a User Story before MVP-mode verification (User Flow Coverage table) can be produced in good faith. Rather than refuse verification entirely and leave a live security bug (see gap below) unreported, this report proceeds with **standard goal-backward verification** against the five ROADMAP Success Criteria and each PLAN's `must_haves` frontmatter, which is well-defined regardless of MVP-mode status. Recommend the developer resolve the mode/goal mismatch before Phase 2 is planned in `mvp` mode.

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A new user can register and create a workspace, becoming its Owner. | VERIFIED | `workspace-creation.test.ts` — 3 passing integration tests over real HTTP (`app.inject`) assert 200 + workspace row + owner membership + unique-slug collision retry + non-member rejection. Full suite run confirms these pass now (`npx vitest run --root apps/api` → 8 files / 32 tests / all pass). |
| 2 | An Owner/Admin can invite a colleague by email who then joins the workspace with an assigned role (Owner/Admin/Member). | VERIFIED | `invite-flow.test.ts` exercises invite create → accept (existing account) and register-from-invite; `apps/api/src/modules/tenancy/invites.ts` wires `sendInvitationEmail` → `platformMail.sendInvite` (confirmed by grep in `auth.ts`/`platform-mail/client.ts`); `InviteModal.tsx` (165 lines, substantive) posts to the invite route and shows a copyable fallback link. |
| 3 | A Member is blocked from changing the SendGrid key and from launching campaigns/flows, while Owner/Admin can do both. | VERIFIED (SendGrid-key half); DEFERRED (campaigns/flows half) | `role-guard.test.ts` + `sendgrid-key-connect.test.ts` assert 403 for a Member on POST `/sendgrid-key`, invite, role-change, remove, and delete-workspace, and success for Owner/Admin. The `campaign:["launch"]`/`flow:["publish"]` actions are pre-declared in `access-control.ts`'s `statement` (per 01-01 plan, "defined now even though only sendgridKey is enforced this phase") but have no launchable campaign/flow entity to gate yet — that functional half is explicitly Phase 4 (CAMP/SEND) and Phase 6 (FLOW) work, not a Phase-1 gap. |
| 4 | A user can paste a SendGrid API key and see it validated on connect (accepted if valid, rejected with a clear error if not); the stored key is encrypted at rest. | VERIFIED | `sendgrid-key-connect.test.ts`: valid key → 200 + verified senders; invalid key → 422 `"SendGrid отклонил ключ..."`; missing-scope key → 422 `"...не имеет права mail.send..."`; a dedicated test asserts no DB column contains the plaintext key. `kms/client.ts` + `kms/local-provider.ts` implement provider-agnostic envelope encryption; `local-provider.ts` refuses to boot under `NODE_ENV=production` (asserted by `envelope.test.ts`). |
| 5 | A user in one workspace cannot see or access any contact, event, campaign, or statistic belonging to another workspace. | **FAILED** | `rls-pooling-chaos.test.ts` proves RLS isolation holds for `workspace_sendgrid_keys` even across a killed/reused pooled connection **when the app itself sets the correct tenant context for the correct caller**. But `GET /api/workspaces/:slug/sendgrid-key` (`apps/api/src/modules/tenancy/sendgrid-key.ts:36-54`) has **no authentication and no membership check at all** — confirmed still present on HEAD (`4633372`, the same commit that added `01-REVIEW.md`'s CR-01 finding; no fix commit follows it). Any unauthenticated caller who knows/guesses a workspace slug can read that workspace's SendGrid key mask, status, and last-checked timestamp. This is a live violation of "a user in one workspace cannot see... data belonging to another workspace" — worse, in fact, since no authentication of any kind is required. See Gaps below. |

**Score:** 4/5 truths verified (1 failed as a hard gap; the "campaigns/flows" clause of Truth 3 is out-of-scope-for-this-phase, not a gap — filed under Deferred Items)

### Deferred Items

| # | Item | Addressed In | Evidence |
|---|------|-------------|----------|
| 1 | Member is blocked from *launching campaigns/flows* (the second half of Truth 3) | Phase 4 (Broadcast Campaigns & Send Pipeline) / Phase 6 (Flows) | ROADMAP.md Phase 4 goal: "...throttled, idempotent, suppression-aware broadcasts..."; Phase 6 goal: "...visually build, publish, and run automated triggered chains..." Neither a campaign nor a flow entity exists yet in this codebase (confirmed: no `campaigns`/`flows` module under `apps/api/src/modules`), so there is nothing to gate yet. The `campaign`/`flow` actions are already pre-declared in `access-control.ts`'s statement, ready for those phases to enforce without an access-control migration. |

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps/api/src/middleware/tenant-context.ts` | AsyncLocalStorage + withTenant/withTenantTransaction (SET LOCAL) | VERIFIED | Present, wired into all tenancy routes; chaos-tested. |
| `packages/db/migrations/0001_rls_policies.sql` | ENABLE/FORCE ROW LEVEL SECURITY + workspace_isolation policy | VERIFIED | Confirmed via 01-01-SUMMARY.md `SELECT relrowsecurity, relforcerowsecurity` → `t, t`; independently re-confirmed by the passing chaos test in this run. |
| `apps/api/src/modules/tenancy/workspaces.ts` | POST /api/workspaces, GET /api/workspaces/:slug | VERIFIED | 200-line file, role-gated delete, tested. |
| `apps/web/src/routes/register.tsx`, `create-workspace.tsx` | Registration + onboarding forms | VERIFIED | Substantive (122 / 79 lines), react-hook-form + zod, wired to API. |
| `apps/web/src/features/workspace-home/WorkspaceHome.tsx`, `workspace-switcher/WorkspaceSwitcher.tsx` | Live workspace data + switcher | VERIFIED | Both use `useQuery`; substantive. |
| `apps/api/src/modules/platform-mail/client.ts` | Platform SendGrid client (system email) | VERIFIED | Structurally separate from tenant client (does not import kms/sendgrid-key modules). |
| `apps/api/src/modules/auth/verification-gate.ts` | requireVerifiedEmail preHandler | VERIFIED | Wired into the SendGrid-connect POST route. |
| `apps/api/src/modules/tenancy/invites.ts`, `members.ts` | Invite + member management routes | VERIFIED, but see WR-02 below | Role-gated on create/cancel/update/delete; **GET /invites has no `requirePermission` preHandler** (confirmed at `invites.ts:87`) — a plain Member can list all pending invites and read `inviteUrl` (the accept token) for invites they weren't sent, including pending Admin invites. This is a Warning, not a blocker of Truth 2/3 (invite creation and role differentiation both work correctly), but is a real permission gap in the same must-have surface. |
| `apps/api/src/kms/client.ts`, `local-provider.ts` | Envelope encryption, provider-agnostic | VERIFIED | `local-provider.ts` refuses production boot; asserted by test. |
| `apps/api/src/modules/tenancy/sendgrid-key.ts` | Connect/recheck/status routes | **PARTIAL** | POST connect/recheck are correctly role- and verify-gated. **GET status route has zero auth** (CR-01) — see Gaps. |
| `apps/web/src/features/sendgrid-key/SendGridKeySettings.tsx` | Connect form, masked display, verified senders, recheck | VERIFIED | 228 lines, substantive. |
| `apps/web/src/features/team/TeamPage.tsx`, `InviteModal.tsx`, `DeleteWorkspaceDialog.tsx`, `apps/web/src/routes/invite-accept.tsx` | Team management UI | VERIFIED | All substantive (90-224 lines each), wired to their respective API routes. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `apps/web/src/routes/create-workspace.tsx` | `apps/api/src/modules/tenancy/workspaces.ts` | POST /api/workspaces | WIRED | Confirmed by e2e spec + integration test. |
| `apps/api/src/middleware/tenant-context.ts` | `packages/db/migrations/0001_rls_policies.sql` | `SET LOCAL app.current_workspace_id` ↔ `current_setting('app.current_workspace_id')` | WIRED | Chaos test passes. |
| `apps/api/src/modules/auth/auth.ts` | `apps/api/src/modules/platform-mail/client.ts` | `sendInvitationEmail` → `platformMail.sendInvite` | WIRED | Confirmed by grep at `auth.ts:91-92`. |
| `apps/api/src/modules/tenancy/sendgrid-key.ts` (POST) | `apps/api/src/kms/client.ts` | `encryptTenantSecret` before storing | WIRED | Confirmed at `sendgrid-key.ts:77`. |
| `apps/api/src/modules/tenancy/sendgrid-key.ts` (POST/recheck) | `apps/api/src/middleware/role-guard.ts` | `requirePermission("sendgridKey","update")` | WIRED | Confirmed at `sendgrid-key.ts:59,103`. |
| `apps/api/src/modules/tenancy/sendgrid-key.ts` (**GET**) | `apps/api/src/middleware/role-guard.ts` | **none** | **NOT WIRED** | No `preHandler` on the GET route at all (`sendgrid-key.ts:36`) — this is the CR-01 gap. |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full Phase-1 API test suite passes for real (not just per SUMMARY claim) | `npx vitest run --root apps/api` (single full run, once) | `Test Files 8 passed (8)` / `Tests 32 passed (32)` | PASS |
| CR-01 remains unfixed on HEAD | `git log -1` → `4633372` (the code-review commit itself, nothing after it); `sed -n '36,54p' sendgrid-key.ts` shows no preHandler; `grep -n "method: \"GET\"" sendgrid-key-connect.test.ts` → no matches | Confirmed unfixed, confirmed untested | FAIL (expected — this is the gap) |
| Debt markers (TBD/FIXME/XXX/TODO/HACK/PLACEHOLDER) in phase source | `grep -rn -E "TBD|FIXME|XXX|TODO|HACK|PLACEHOLDER" apps/api/src apps/web/src packages/db/src packages/shared-schemas/src` (excluding tests) | No matches | PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| TENANT-01 | 01-01, 01-02 | Register + create workspace, become Owner | SATISFIED | `workspace-creation.test.ts`, e2e spec, WorkspaceHome live role display. |
| TENANT-02 | 01-04 | Invite colleagues by email | SATISFIED | `invite-flow.test.ts`, `platformMail.sendInvite` wiring, `InviteModal.tsx`. |
| TENANT-03 | 01-01, 01-04, 01-05 | Owner/Admin/Member role differentiation (SendGrid key + campaigns/flows) | SATISFIED for the SendGrid-key and team-management surface that exists this phase; the campaigns/flows half is pre-declared but has nothing to enforce yet (see Deferred Items) | `role-guard.test.ts`, `sendgrid-key-connect.test.ts` Member-403 assertions. |
| TENANT-04 | 01-05 | SendGrid key connect: validated + encrypted at rest | SATISFIED, with a caveat | Connect/validate/encrypt flow fully works and is tested; however the **GET status route's unauthenticated cross-tenant exposure (CR-01)** touches this requirement's data (key mask/status), even though the encrypted ciphertext itself is never exposed. Flagged under TENANT-05 gap below rather than double-counted here. |
| TENANT-05 | 01-01 (RLS), 01-05 (GET route) | Full workspace data isolation | **BLOCKED** | RLS/chaos-test isolation mechanism is sound, but the GET sendgrid-key route bypasses it at the application layer by supplying the target workspace's tenant context for an unauthenticated/unverified caller. This is the phase's one hard gap. |

No orphaned requirements — REQUIREMENTS.md's Phase-1 row (TENANT-01..05) matches exactly what all 5 plans declared.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `apps/api/src/modules/tenancy/sendgrid-key.ts` | 36-54 | Missing auth/membership check on a route serving tenant-scoped secret-adjacent data | 🛑 Blocker | CR-01 — cross-tenant information disclosure (see Gaps) |
| `apps/api/src/modules/platform-mail/templates/invite.ts` | 5, 7 | Unescaped user-controlled `orgName` interpolated into HTML email + subject | ⚠️ Warning | CR-02 in 01-REVIEW.md — phishing/content-spoofing vector using the platform's own sending reputation. Still present on HEAD; not covered by a must-have truth this phase but bears on the invite feature (Truth 2) being safe to use in production. |
| `apps/api/src/db.ts` | 13 | No `pool.on("error", ...)` listener on the production `pg.Pool` (only present in the test-only chaos file) | ⚠️ Warning | CR-03 in 01-REVIEW.md — any idle-connection termination (Postgres restart/failover/timeout) is an uncaught exception that kills the API process in production. Not a must-have-truth failure by itself, but a standing operational-reliability risk across every feature this phase ships. |
| `apps/api/src/modules/tenancy/invites.ts` | 87-111 | `GET /invites` has no `requirePermission` preHandler; leaks `inviteUrl` (accept token) to any Member | ⚠️ Warning | WR-02 in 01-REVIEW.md — a Member can obtain the accept link for a pending Admin invite. Doesn't break Truth 2/3's core functional claims, but is a real least-privilege gap on the same surface. |

*(The remaining review findings — WR-01, WR-03..WR-07, IN-01..IN-09 — are lower-severity code-quality/robustness issues (dead connection recycling, soft-delete edge cases on invite-preview, non-atomic register-from-invite, missing fetch timeouts, session revocation on password change, etc.). They don't individually break any must-have truth for this phase; they're listed in 01-REVIEW.md and should be triaged as follow-up work, not re-litigated here.)*

## Human Verification Required

The following 16 items were explicitly deferred by plans 01-03/01-04/01-05 from their in-plan `checkpoint:human-verify` to phase-level UAT (per `<verify><human-check>` blocks harvested from each PLAN.md, matching STATE.md's Blockers/Concerns entries). Automated coverage for all of them is green (11/11, 21/21, 32/32 vitest at time of each plan's completion; 32/32 in this verification's own full run), but none has been exercised in a real browser against real SendGrid/email delivery. These are legitimate human-verification items, not failures.

### From 01-03 (password reset / soft verification / profile) — 3 items

1. **Password reset email delivery.** Test: from `/login`, click "Забыли пароль?", enter your email, confirm a reset email arrives from `noreply@` (platform key) and the new password works to log in. Why human: real email delivery + inbox check can't be asserted by grep/unit test.
2. **Soft-verification banner + resend.** Test: as a freshly registered (unverified) user, confirm the amber "Подтвердите email…" banner appears, click resend, confirm a verification email arrives, and confirm the app remains usable before verifying. Why human: real email delivery + visual banner state.
3. **Profile display-name/password-change in a real browser.** Test: on `/w/{slug}/profile`, change display name (persists) and change password (toast "Пароль изменён"); confirm no email-change/avatar control exists. Why human: visual confirmation + real browser session behavior.

### From 01-04 (invites / roles / delete) — 6 items

4. **Invite email + copyable link.** Test: as Owner, invite a second email from the Team page; confirm the invite email arrives AND the modal shows a working copyable link with a "Скопировано" confirmation. Why human: real email delivery + clipboard UX.
5. **Register-from-invite in a fresh browser/incognito session.** Test: open the invite link with no account, "Создать аккаунт и присоединиться" with email pre-filled/locked, confirm the new account joins with the assigned role. Why human: multi-session browser flow.
6. **Accept-with-existing-account.** Test: open an invite link while already logged into an existing account; confirm "Присоединиться к воркспейсу" joins correctly. Why human: real session/account state.
7. **Expired/revoked invite messaging.** Test: confirm an expired link shows "Срок действия приглашения истёк…" and a revoked link shows "Это приглашение больше не действует…". Why human: requires waiting out/triggering real invite-lifecycle state in the UI.
8. **Member control hiding + Owner-only Admin-assignment/ownership-transfer.** Test: confirm a Member's Team page hides invite/role/remove/delete controls; confirm only the Owner (not an Admin) can assign Admin or transfer ownership. Why human: visual UI-gating confirmation alongside the already-automated server-side 403s.
9. **Type-name delete removes the workspace from the switcher.** Test: delete a throwaway workspace via type-name confirmation, confirm it disappears from the WorkspaceSwitcher. Why human: visual UI state after a destructive action.

### From 01-05 (SendGrid key connect) — 7 items

10. **Empty state.** Test: with no key connected, `/w/{slug}/settings/sendgrid` shows "SendGrid не подключён". Why human: visual empty-state confirmation.
11. **Invalid / missing-scope key copy.** Test: paste a real SendGrid key without `mail.send` → exact "Ключ действителен, но не имеет права mail.send…" copy; paste an invalid key → "SendGrid отклонил ключ…". Why human: requires real SendGrid API round-trip with a real (if deliberately scoped-down) key — the automated tests mock this response shape but don't prove SendGrid's real API returns it identically.
12. **Valid-key connect + verified senders + recheck.** Test: paste a valid `mail.send` key, confirm masked display (`SG.xxxx…yyyy`, monospace), "Активен" badge, verified-senders list, and that "Проверить сейчас" refreshes the badge. Why human: real SendGrid account state + visual confirmation.
13. **Unverified-email gate in the browser.** Test: as an unverified-email user, confirm connect is blocked with "Подтвердите email, чтобы подключить SendGrid…". Why human: visual error-copy confirmation alongside the automated 403 test.
14. **Member control hiding for SendGrid settings.** Test: as a Member, confirm the connect/change control isn't shown in the UI (server already refuses if forced). Why human: visual UI-gating confirmation.
15. **Onboarding checklist done-detection.** Test: confirm the workspace-home checklist marks "Подключите SendGrid" done after connect, and "Пригласите команду" done once a second member exists. Why human: cross-feature live-state visual confirmation.
16. **Plaintext-at-rest DB spot check (optional integrity check).** Test: inspect the `workspace_sendgrid_keys` row directly and confirm no column contains the plaintext key. Why human: direct DB inspection as a secondary confirmation beyond the automated assertion.

## Gaps Summary

Phase 1 delivers a genuinely solid foundation: the register→create-workspace→Owner path, the AsyncLocalStorage+SET LOCAL+RLS tenant-isolation pattern (chaos-tested across a killed pooled connection), the invite/accept/role-management lifecycle, and the SendGrid key connect/validate/encrypt flow are all implemented, wired, and covered by a full green test suite (32/32) as of this verification's own run — not just per the SUMMARY narrative.

However, one BLOCKER survives from the phase's own committed code review (01-REVIEW.md, CR-01) into the current HEAD with no fix commit: `GET /api/workspaces/:slug/sendgrid-key` has no authentication or membership check whatsoever, so any unauthenticated network caller can read another workspace's SendGrid key mask/status/last-checked timestamp by slug. This is a direct, currently-exploitable violation of ROADMAP Success Criterion 5 / TENANT-05 ("a user in one workspace cannot see or access... any... statistic belonging to another workspace") — the phase's own core value proposition ("with every workspace's data fully isolated from day one"). It is not a hypothetical or edge case: no test exercises the unauthenticated path, and the code plainly lacks any preHandler. This must be fixed (add the same membership check the review's suggested fix demonstrates, plus a regression test for the unauthenticated/non-member cases) before this phase can be considered to have met its isolation guarantee.

Two further Warning-level findings from the same review (CR-02 HTML-injection phishing vector in invite emails; CR-03 missing production `pool.on("error")` handler) remain unfixed and are worth remediating promptly, though they don't individually break a must-have truth for this phase.

16 items are legitimately deferred to human/browser verification (real email delivery, real SendGrid account state, visual UI confirmation) — these are not gaps, they are appropriately-deferred UAT and should be run through end-of-phase human verification rather than blocking autonomous completion.

---

_Verified: 2026-07-03T11:47:53Z_
_Verifier: Claude (gsd-verifier)_
