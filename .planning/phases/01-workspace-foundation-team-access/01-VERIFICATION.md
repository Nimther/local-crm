---
phase: 01-workspace-foundation-team-access
verified: 2026-07-03T18:20:00Z
status: passed
score: 5/5 must-haves verified
behavior_unverified: 0
overrides_applied: 0
mode_note: "ROADMAP.md marks this phase mode: mvp, but the phase goal text does not match the required User Story format (`As a ..., I want ..., so that ....`) -- gsd_run query user-story.validate returned valid=false. Standard goal-backward verification (ROADMAP Success Criteria + PLAN must_haves) was used instead of MVP User-Flow-Coverage verification, unchanged from the previous verification run. Recommend either clearing mode: mvp or rewriting the goal as a proper User Story before the next MVP-mode phase runs."
re_verification:
  previous_status: gaps_found
  previous_score: 4/5
  gaps_closed:
    - "A user in one workspace cannot see or access any contact, event, campaign, or statistic belonging to another workspace (Success Criterion 5 / TENANT-05) — GET /api/workspaces/:slug/sendgrid-key was unauthenticated (CR-01)."
  gaps_remaining: []
  regressions: []
deferred:
  - truth: "Member is blocked from launching campaigns/flows (the second half of Success Criterion 3 / TENANT-03)"
    addressed_in: "Phase 4 (Broadcast Campaigns & Send Pipeline) / Phase 6 (Flows)"
    evidence: "ROADMAP.md Phase 4 goal covers broadcast campaigns; Phase 6 goal covers triggered flows. Neither a campaign nor a flow entity exists yet in this codebase — nothing to gate. The campaign/flow actions are already pre-declared in access-control.ts's statement for those phases to enforce."
---

# Phase 1: Workspace Foundation & Team Access Verification Report

**Phase Goal:** A marketer can create a workspace, bring their team in with the right permissions, and connect their SendGrid account — with every workspace's data fully isolated from day one.
**Verified:** 2026-07-03T18:20:00Z
**Status:** passed
**Re-verification:** Yes — after gap closure (plan 01-06, commits `0bcff83`, `bb75739`, `fe25bbe`, `362916a`)

## Mode Discrepancy Note

ROADMAP.md sets `Mode: mvp` for Phase 1, but the phase goal is not phrased as a User Story. Re-confirmed unchanged from the prior verification run:

```
gsd_run query user-story.validate --story "A marketer can create a workspace, bring their team in with the right permissions, and connect their SendGrid account — with every workspace's data fully isolated from day one." --pick valid
=> false
```

Standard goal-backward verification (ROADMAP Success Criteria + PLAN must_haves) is used, as in the prior run. Recommend the developer resolve the mode/goal mismatch before Phase 2 is planned in `mvp` mode.

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A new user can register and create a workspace, becoming its Owner. | VERIFIED | `workspace-creation.test.ts` — passing integration tests over real HTTP (`app.inject`) assert 200 + workspace row + owner membership + unique-slug collision retry + non-member rejection. Regression-confirmed in this run's full test-suite pass (38/38). |
| 2 | An Owner/Admin can invite a colleague by email who then joins the workspace with an assigned role (Owner/Admin/Member). | VERIFIED | `invite-flow.test.ts` exercises invite create → accept (existing account) and register-from-invite; `invites.ts` wires `sendInvitationEmail` → `platformMail.sendInvite`; `InviteModal.tsx` (substantive, 165 lines) posts to the invite route and shows a copyable fallback link. Regression-confirmed. |
| 3 | A Member is blocked from changing the SendGrid key and from launching campaigns/flows, while Owner/Admin can do both. | VERIFIED (SendGrid-key half); DEFERRED (campaigns/flows half — see Deferred Items) | `role-guard.test.ts` + `sendgrid-key-connect.test.ts` assert 403 for a Member on POST `/sendgrid-key`, invite, role-change, remove, delete-workspace; success for Owner/Admin. `campaign`/`flow` actions are pre-declared in `access-control.ts` but have no launchable entity to gate yet — out of scope for Phase 1. |
| 4 | A user can paste a SendGrid API key and see it validated on connect (accepted if valid, rejected with a clear error if not); the stored key is encrypted at rest. | VERIFIED | `sendgrid-key-connect.test.ts`: valid key → 200 + verified senders; invalid key → 422 with clear Russian-language error copy; missing-scope key → distinct 422 error copy; a dedicated test asserts no DB column contains the plaintext key. `kms/client.ts` + `kms/local-provider.ts` implement provider-agnostic envelope encryption; `local-provider.ts` refuses to boot under `NODE_ENV=production`. |
| 5 | A user in one workspace cannot see or access any contact, event, campaign, or statistic belonging to another workspace. | **VERIFIED (gap closed)** | The CR-01 blocker from the previous verification run is closed. `GET /api/workspaces/:slug/sendgrid-key` (`sendgrid-key.ts:44-68`) now resolves the workspace first (404 for nonexistent/soft-deleted), then wraps `getCallerRoles(toFetchHeaders(request), slug)` in try/catch and maps ANY throw (unauthenticated, unknown slug, non-member) to the identical `{ error: "Workspace not found" }` 404 — no enumeration oracle. Verified directly against the code (not just the SUMMARY): read the live handler at `sendgrid-key.ts:44-68`, confirmed the guard is unconditional and precedes the `withTenant` read. Confirmed the 4 new regression tests exist and assert the exact behavior (unauth→404 no keyMask, non-member→404 matching nonexistent-workspace body, Member→200, Owner-after-connect→200+keyMask) and pass in this run's own full-suite execution (`npx vitest run --root apps/api` → 8 files / 38 tests / all pass, run independently by this verifier, not taken from SUMMARY). `rls-pooling-chaos.test.ts` independently confirms RLS isolation holds at the DB layer across a killed pooled connection. |

**Score:** 5/5 truths verified (the "campaigns/flows" clause of Truth 3 remains out-of-scope-for-this-phase, filed under Deferred Items — not a gap)

### Deferred Items

| # | Item | Addressed In | Evidence |
|---|------|-------------|----------|
| 1 | Member is blocked from *launching campaigns/flows* (second half of Truth 3) | Phase 4 (Broadcast Campaigns & Send Pipeline) / Phase 6 (Flows) | ROADMAP.md Phase 4/6 goals; no campaign/flow entity exists yet in this codebase (confirmed: no `campaigns`/`flows` module under `apps/api/src/modules`). `campaign`/`flow` actions are already pre-declared in `access-control.ts`'s statement. |

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps/api/src/middleware/tenant-context.ts` | AsyncLocalStorage + withTenant/withTenantTransaction (SET LOCAL) | VERIFIED | 67 lines, present, wired into all tenancy routes; chaos-tested. |
| `packages/db/migrations/0001_rls_policies.sql` | ENABLE/FORCE ROW LEVEL SECURITY + workspace_isolation policy | VERIFIED | 33 lines, present; re-confirmed by passing chaos test in this run. |
| `apps/api/src/modules/tenancy/workspaces.ts` | POST /api/workspaces, GET /api/workspaces/:slug | VERIFIED | 183 lines, role-gated delete, tested. |
| `apps/web/src/routes/register.tsx`, `create-workspace.tsx` | Registration + onboarding forms | VERIFIED | 122 / 79 lines, react-hook-form + zod, wired to API. |
| `apps/api/src/modules/platform-mail/client.ts` | Platform SendGrid client (system email) | VERIFIED | 53 lines, structurally separate from tenant client. |
| `apps/api/src/modules/auth/verification-gate.ts` | requireVerifiedEmail preHandler | VERIFIED | 36 lines, wired into the SendGrid-connect POST route. |
| `apps/api/src/modules/tenancy/invites.ts`, `members.ts` | Invite + member management routes | VERIFIED | Role-gated on create/cancel/update/delete; **GET /invites now carries `requirePermission("invitation", "create")`** (`invites.ts:87-89`), closing the WR-02 gap present in the previous run — confirmed directly in source, not from SUMMARY, and by the passing `invite-flow.test.ts` Member-403/Owner-200 regression test. |
| `apps/api/src/kms/client.ts`, `local-provider.ts` | Envelope encryption, provider-agnostic | VERIFIED | 76 / 66 lines; `local-provider.ts` refuses production boot; asserted by test. |
| `apps/api/src/modules/tenancy/sendgrid-key.ts` | Connect/recheck/status routes | **VERIFIED (was PARTIAL)** | POST connect/recheck remain role- and verify-gated. **GET status route is now membership-gated** (`sendgrid-key.ts:44-68`) — CR-01 closed, confirmed by direct code read plus 4 passing regression tests. |
| `apps/api/src/modules/platform-mail/templates/invite.ts` | Invite email HTML template | VERIFIED, CR-02 closed | `escapeHtml()` helper (lines 1-9) entity-escapes `orgName` before both interpolation sites (lines 13, 16, 18); confirmed by direct code read and a passing escaping regression test in `platform-mail.test.ts` (asserts `&lt;`/`&gt;` present, raw tag absent). |
| `apps/api/src/db.ts` | Production pg Pool | VERIFIED, CR-03 closed | `pool.on("error", ...)` listener added (line 19), logs via shared Pino logger instead of crashing the process on idle-connection termination. Confirmed by direct code read. |
| `apps/web/src/features/sendgrid-key/SendGridKeySettings.tsx` | Connect form, masked display, verified senders, recheck | VERIFIED | 228 lines, substantive. |
| `apps/web/src/features/team/TeamPage.tsx`, `InviteModal.tsx`, `DeleteWorkspaceDialog.tsx`, `apps/web/src/routes/invite-accept.tsx` | Team management UI | VERIFIED | All substantive, wired to their respective API routes. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `apps/web/src/routes/create-workspace.tsx` | `apps/api/src/modules/tenancy/workspaces.ts` | POST /api/workspaces | WIRED | Confirmed by e2e spec + integration test. |
| `apps/api/src/middleware/tenant-context.ts` | `packages/db/migrations/0001_rls_policies.sql` | `SET LOCAL app.current_workspace_id` ↔ `current_setting('app.current_workspace_id')` | WIRED | Chaos test passes. |
| `apps/api/src/modules/auth/auth.ts` | `apps/api/src/modules/platform-mail/client.ts` | `sendInvitationEmail` → `platformMail.sendInvite` | WIRED | Confirmed by grep at `auth.ts:91-92`. |
| `apps/api/src/modules/tenancy/sendgrid-key.ts` (POST) | `apps/api/src/kms/client.ts` | `encryptTenantSecret` before storing | WIRED | Confirmed at `sendgrid-key.ts:91`. |
| `apps/api/src/modules/tenancy/sendgrid-key.ts` (POST/recheck) | `apps/api/src/middleware/role-guard.ts` | `requirePermission("sendgridKey","update")` | WIRED | Confirmed at `sendgrid-key.ts:73,117`. |
| `apps/api/src/modules/tenancy/sendgrid-key.ts` (**GET**) | `apps/api/src/modules/tenancy/member-roles.ts` | `getCallerRoles(headers, slug)` wrapped in try/catch → uniform 404 | **WIRED (fixed)** | Confirmed at `sendgrid-key.ts:51-55` — the CR-01 gap from the prior run is closed; this is the previously NOT_WIRED link. |
| `apps/api/src/modules/tenancy/invites.ts` (GET /invites) | `apps/api/src/middleware/role-guard.ts` | `requirePermission("invitation","create")` | **WIRED (fixed)** | Confirmed at `invites.ts:87-89` — closes WR-02. |
| `apps/api/src/modules/platform-mail/templates/invite.ts` | (module-internal) `escapeHtml` | orgName routed through escapeHtml before interpolation | **WIRED (fixed)** | Confirmed at `invite.ts:13`. |
| `apps/api/src/db.ts` | Pino `logger` | `pool.on("error", ...)` → `logger.error` | **WIRED (fixed)** | Confirmed at `db.ts:19`. |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full Phase-1 API test suite passes for real (independently run by this verifier, not taken from SUMMARY) | `npx vitest run --root apps/api` (single full run, once) | `Test Files 8 passed (8)` / `Tests 38 passed (38)` | PASS |
| CR-01 is fixed on HEAD | `git log -1` → `6b133d7`; direct read of `sendgrid-key.ts:44-68` shows unconditional membership guard before the tenant read; `grep -n "method: \"GET\"" sendgrid-key-connect.test.ts` → 4 GET test cases present and passing | Confirmed fixed, confirmed tested | PASS |
| WR-02 is fixed on HEAD | Direct read of `invites.ts:87-89` shows `requirePermission("invitation","create")` on the GET route; `invite-flow.test.ts` Member-403/Owner-200 test passes | Confirmed fixed, confirmed tested | PASS |
| CR-02 is fixed on HEAD | Direct read of `invite.ts:1-13` shows `escapeHtml` applied to `orgName`; `platform-mail.test.ts` escaping test passes | Confirmed fixed, confirmed tested | PASS |
| CR-03 is fixed on HEAD | Direct read of `db.ts:16-19` shows `pool.on("error", ...)` listener | Confirmed fixed (source-level; no cheap behavioral harness for a real idle-connection-drop event, consistent with plan's own acceptance criteria) | PASS |
| Debt markers (TBD/FIXME/XXX/TODO/HACK/PLACEHOLDER) in phase source | `grep -rn -E "TBD\|FIXME\|XXX\|TODO\|HACK\|PLACEHOLDER" apps/api/src apps/web/src packages/db/src packages/shared-schemas/src` (excluding tests) | No matches | PASS |
| Key regression artifacts still present (no accidental deletion during gap-closure) | `wc -l` on 11 previously-verified core files (tenant-context.ts, RLS migration, workspaces.ts, register/create-workspace routes, platform-mail client, verification-gate, KMS client/local-provider, SendGridKeySettings, TeamPage) | All 11 present with expected non-trivial line counts | PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| TENANT-01 | 01-01, 01-02 | Register + create workspace, become Owner | SATISFIED | `workspace-creation.test.ts`, e2e spec, WorkspaceHome live role display. |
| TENANT-02 | 01-04 | Invite colleagues by email | SATISFIED | `invite-flow.test.ts`, `platformMail.sendInvite` wiring, `InviteModal.tsx`. |
| TENANT-03 | 01-01, 01-04, 01-05 | Owner/Admin/Member role differentiation (SendGrid key + campaigns/flows) | SATISFIED for the SendGrid-key and team-management surface that exists this phase; campaigns/flows half pre-declared, nothing to enforce yet (Deferred Items) | `role-guard.test.ts`, `sendgrid-key-connect.test.ts` Member-403 assertions. |
| TENANT-04 | 01-05, 01-06 | SendGrid key connect: validated + encrypted at rest | SATISFIED | Connect/validate/encrypt flow fully works and is tested; the GET status route's prior cross-tenant exposure (CR-01) — which also touched this requirement's key-mask/status data — is now closed (01-06). |
| TENANT-05 | 01-01 (RLS), 01-06 (GET route fix) | Full workspace data isolation | **SATISFIED (was BLOCKED)** | RLS/chaos-test isolation mechanism is sound at the DB layer; the GET sendgrid-key route's application-layer bypass (CR-01) is now closed by a membership guard, confirmed by direct code read and passing regression tests independently run in this verification. |

No orphaned requirements — REQUIREMENTS.md's Phase-1 row (TENANT-01..05) matches exactly what all 6 plans (01-01..01-06) declared, and REQUIREMENTS.md's Traceability table marks all five `Complete`.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `apps/api/src/modules/tenancy/invites.ts` | 137-176 | `resend` route re-issues a pending admin-role invite without the Owner-only D-18 check that the sibling `create` route enforces | ⚠️ Warning (WR-01 in 01-REVIEW.md) | Policy-consistency gap, not a fresh privilege escalation (the admin invite was already Owner-authorized). Does not break any Phase-1 must-have truth. |
| `apps/api/src/modules/tenancy/invites.ts` | 287-313 | register-from-invite can orphan a created user account if `acceptInvitation` fails after `signUpEmail` succeeds | ⚠️ Warning (WR-02 in fresh 01-REVIEW.md, distinct from the now-closed WR-02 in the earlier review numbering) | Edge-case reliability gap; does not break Truth 2's core functional claim (register-from-invite works on the happy path, tested). |
| `apps/api/src/modules/tenancy/sendgrid-client.ts` | 40-53 | `scopes`/`results` dereferenced without shape guards on a 200 response | ⚠️ Warning (WR-03) | Could surface as a 500 instead of a clean "invalid" result on an unexpected-but-200 SendGrid response shape; does not affect the happy/known-error paths that Truth 4 requires. |
| `apps/api/src/middleware/tenant-context.ts` | 56-66 | Error-path `release()` relies on undocumented pg-pool internals rather than explicit `release(err)` | ⚠️ Warning (WR-04) | Fragile but not incorrect today; RLS isolation itself (Truth 5) is unaffected since `SET LOCAL` on a terminated backend cannot bleed state. |
| `apps/api/src/env.ts` | 22-42 | `KMS_LOCAL_KEK` not validated at boot when `KMS_PROVIDER=local` | ⚠️ Warning (WR-05) | Misconfiguration surfaces as a runtime 500 on first key operation rather than a boot failure; doesn't affect Truth 4 in a correctly-configured environment (which is what's tested). |

No 🛑 Blocker-severity anti-patterns found on HEAD. All four blockers/warnings from the phase's own committed CR-01/CR-02/CR-03/WR-02 (earlier numbering) findings are closed by plan 01-06 and independently re-confirmed in this verification. The five Warning items above are net-new findings from the fresh 01-REVIEW.md (0 critical / 5 warning / 4 info) — they are robustness/consistency issues, none of which breaks a Phase-1 must-have truth; recommended as follow-up work, not phase-blocking.

No debt markers (TBD/FIXME/XXX/TODO/HACK/PLACEHOLDER) in non-test phase source.

## Human Verification Required

None new. The 16 items previously deferred by plans 01-03/01-04/01-05 (`<verify><human-check>` blocks: password reset delivery, verification banner, profile changes, invite email delivery, register-from-invite in a fresh session, accept-with-existing-account, expired/revoked invite messaging, member control hiding, delete-workspace UI state, SendGrid empty/invalid/valid-key states, unverified-email gate, onboarding checklist done-detection, plaintext-at-rest DB spot check) remain legitimate end-of-phase UAT items — they require real browser sessions and/or real SendGrid/email delivery that cannot be asserted by grep/unit test. They are unaffected by the 01-06 gap-closure plan (which touched only `sendgrid-key.ts`, `invites.ts`, `platform-mail/templates/invite.ts`, and `db.ts` at the route/handler/template/pool-config level — no UI surface). They should be run through the existing end-of-phase human-verification checkpoint (STATE.md Blockers/Concerns), not re-listed here as a phase-blocking gap.

## Gaps Summary

No gaps remain. The one hard blocker from the previous verification run — `GET /api/workspaces/:slug/sendgrid-key` having zero authentication/membership check (CR-01), a live cross-tenant information-disclosure violating Success Criterion 5 / TENANT-05 — is confirmed closed on HEAD (`6b133d7`) by direct source inspection (not SUMMARY claims): the route now resolves the workspace, then wraps a membership-roles lookup in try/catch, mapping any failure (unauthenticated, unknown slug, non-member) to an identical 404, before ever reading the key row. Four independent regression tests lock this behavior and pass in a full test-suite run executed directly by this verifier (38/38, not copied from any SUMMARY narrative).

The three Warning-level findings from the same review round (CR-02 HTML-injection in invite emails, CR-03 missing production `pool.on("error")` handler, WR-02/earlier-numbering unguarded GET /invites) are also confirmed closed by direct code read and passing regression tests.

A fresh code review (01-REVIEW.md, reviewed after the gap-closure commits, `files_reviewed: 71`) independently confirms all four fixes hold and finds 0 new critical/blocker issues — only 5 warnings and 4 info-level items, none of which breaks a Phase-1 must-have truth (WR-01 admin-resend gate inconsistency, a distinct WR-02 orphaned-account edge case, WR-03 unguarded SendGrid response shape, WR-04 pg-pool release() fragility, WR-05 KMS_LOCAL_KEK boot-validation gap). These are recommended as follow-up work but do not block this phase.

All five ROADMAP Success Criteria are now VERIFIED (with the campaigns/flows half of Criterion 3 correctly deferred to Phase 4/6, where the gating entities will first exist). Phase 1's core value proposition — "every workspace's data fully isolated from day one" — now holds end-to-end, confirmed against the running code and a fresh, independently-executed test suite, not against summary narrative.

---

_Verified: 2026-07-03T18:20:00Z_
_Verifier: Claude (gsd-verifier)_
