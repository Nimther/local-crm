---
phase: 01-workspace-foundation-team-access
plan: 04
subsystem: tenancy
tags: [better-auth, organization-plugin, invites, rbac, soft-delete, vitest]

# Dependency graph
requires:
  - phase: 01-01
    provides: better-auth org plugin instance (auth.ts) with createInvitation/acceptInvitation/cancelInvitation/listMembers/updateMemberRole/removeMember, access-control statement/owner/admin/member, organization.deleted_at column
  - phase: 01-02
    provides: AppShell, WorkspaceSwitcher, role-gated UI convention (hide, not disable, for Member)
  - phase: 01-03
    provides: platformMail.sendInvite({ to, inviteUrl, orgName })
provides:
  - Invite lifecycle over the org plugin -- create/accept-existing/register-from-invite/revoke/resend, all delegating to better-auth (no bespoke invitation table)
  - Role-gated member management (listMembers/updateMemberRole/removeMember) enforcing Member 403 and Owner-only Admin-assignment/ownership-transfer (D-17/D-18)
  - Owner-only, name-reconfirmed soft-delete for workspaces (D-20), with soft-deleted workspaces excluded from list/read
  - Team UI: TeamPage, InviteModal (copyable link fallback, D-10), MemberRow, DeleteWorkspaceDialog, invite-accept route (both accept paths)
affects: [01-05, phase-uat]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Invites/members/roles ride better-auth's organization plugin API exclusively -- no hand-rolled invitation table; server re-derives workspace+role from the stored invitation row at accept time, never from client input (T-01-15 mitigation)"
    - "Owner-only elevation check layered on top of requirePermission: the org plugin's default admin-can-manage-members behavior is insufficient for D-18, so an explicit owner-only branch guards Admin-role assignment and ownership transfer"
    - "Workspace soft-delete re-validates the typed confirmation name server-side (not just client-side gating) before setting deleted_at"
    - "Web reads workspace membership through /api/workspaces (already deleted_at-filtered) instead of better-auth's own organization.list, so a soft-deleted workspace can never reappear in RootRedirect or WorkspaceSwitcher"

key-files:
  created:
    - apps/api/src/modules/tenancy/invites.ts
    - apps/api/src/modules/tenancy/members.ts
    - apps/api/src/modules/tenancy/member-roles.ts
    - apps/api/src/modules/tenancy/workspace-lookup.ts
    - apps/api/src/modules/tenancy/__tests__/invite-flow.test.ts
    - apps/api/src/modules/tenancy/__tests__/role-guard.test.ts
    - packages/shared-schemas/src/invite.ts
    - apps/web/src/features/team/TeamPage.tsx
    - apps/web/src/features/team/InviteModal.tsx
    - apps/web/src/features/team/MemberRow.tsx
    - apps/web/src/features/team/DeleteWorkspaceDialog.tsx
    - apps/web/src/routes/invite-accept.tsx
    - packages/db/migrations/0002_invitation_created_at.sql
  modified:
    - apps/api/src/modules/auth/auth.ts
    - apps/api/src/modules/auth/access-control.ts
    - apps/api/src/middleware/role-guard.ts
    - apps/api/src/modules/tenancy/workspaces.ts
    - apps/api/src/server.ts
    - apps/api/src/test/db-fixture.ts
    - packages/shared-schemas/src/index.ts
    - packages/db/src/schema/auth.ts
    - apps/web/src/App.tsx
    - apps/web/src/features/app-shell/AppShell.tsx
    - apps/web/src/features/workspace-switcher/WorkspaceSwitcher.tsx
    - apps/web/src/lib/api.ts

key-decisions:
  - "Server-side owner-only branch added on top of requirePermission for Admin-role assignment and ownership transfer -- the org plugin's default admin permission set alone does not satisfy D-18"
  - "Web's RootRedirect and WorkspaceSwitcher switched from better-auth's organization.list to /api/workspaces (which already filters deleted_at) so a soft-deleted workspace cannot reappear anywhere in the UI (D-20)"
  - "Task 4 (human live-browser verification) DEFERRED to phase-level UAT -- see Deviations below"

requirements-completed: [TENANT-02, TENANT-03]

coverage:
  - id: D1
    description: "Owner/Admin invites by email; an invitation is created and platformMail.sendInvite is called with a /invite/{id} accept URL"
    requirement: "TENANT-02"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/tenancy/__tests__/invite-flow.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "register-from-invite (D-12): a new user registers with the invite's fixed email + supplied name/password and immediately joins with the assigned role"
    requirement: "TENANT-02"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/tenancy/__tests__/invite-flow.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "An existing-account invitee accepts and joins with the assigned role; a >7-day-old or revoked invite is rejected; resend reissues a fresh token"
    requirement: "TENANT-02"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/tenancy/__tests__/invite-flow.test.ts"
        status: pass
    human_judgment: false
  - id: D4
    description: "Member is 403 on invite/updateMemberRole/removeMember/delete-workspace; Admin can invite/remove Member but is 403 assigning Admin role or transferring ownership; only Owner succeeds at both plus workspace delete"
    requirement: "TENANT-03"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/tenancy/__tests__/role-guard.test.ts"
        status: pass
    human_judgment: false
  - id: D5
    description: "DELETE /api/workspaces/:slug is Owner-only, re-validates the submitted name server-side, sets deleted_at, and soft-deleted workspaces are excluded from list/read"
    requirement: "TENANT-03"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/tenancy/__tests__/role-guard.test.ts"
        status: pass
    human_judgment: false
  - id: D6
    description: "Team UI (TeamPage/InviteModal/MemberRow/DeleteWorkspaceDialog/invite-accept.tsx) renders correctly, hides Member/Admin-forbidden controls, and the copyable-link + type-name-confirm interactions work in a live browser"
    verification:
      - kind: unit
        ref: "apps/web tsc --noEmit / npm run build (structural checks only)"
        status: pass
    human_judgment: true
    rationale: "Structural/build checks pass and role-gating logic is unit-proven server-side, but the full interactive lifecycle (email delivery, copyable link, both accept paths, expired/revoked messaging, live role-gating in the DOM, type-name delete removing the workspace from the switcher) was not exercised in a real browser. DEFERRED to phase-level UAT (checkpoint unavailable at execution time)."

# Metrics
duration: 7min
completed: 2026-07-03
status: complete
---

# Phase 01 Plan 04: Team Invites, Roles, and Safe Delete Summary

**Invite lifecycle, role-gated member management, and type-name-to-confirm soft delete built entirely over better-auth's organization plugin, with an explicit Owner-only elevation check layered on top for D-18.**

## Performance

- **Duration:** 7 min (Tasks 1-3, per commit timestamps 15:53:18-15:59:49)
- **Started:** 2026-07-03T15:53:18+05:00
- **Completed:** 2026-07-03T15:59:49+05:00 (Tasks 1-3); checkpoint deferral resolved 2026-07-03
- **Tasks:** 3 of 4 executed automatically; Task 4 (human-verify) deferred to phase UAT
- **Files modified:** 28 (16 created, 12 modified, per `git diff --stat`)

## Accomplishments
- `invites.ts`: create-invite (wires `platformMail.sendInvite` via the org plugin's `sendInvitationEmail` callback in `auth.ts`), accept-existing, register-from-invite (D-12: account created with the invite's fixed email, then joins), revoke, resend -- all delegating to the better-auth organization plugin API, no bespoke invitation table
- `@fastify/rate-limit` applied to accept/register-from-invite routes (T-01-13 invite-token brute-force mitigation)
- `members.ts`: `listMembers`/`updateMemberRole`/`removeMember`, each guarded by `requirePermission` plus an explicit Owner-only check for Admin-role assignment and ownership transfer (D-18; the org plugin's default admin permission set alone is insufficient)
- `workspaces.ts` gains an Owner-only `DELETE /api/workspaces/:slug`: server re-validates the submitted name equals the workspace name, then sets `deleted_at` (soft delete, D-20); soft-deleted workspaces are excluded from list/read
- Web: `TeamPage.tsx` (member table + pending-invite rows, role-gated controls), `InviteModal.tsx` (copyable fallback link + copy feedback, D-10), `MemberRow.tsx` (remove/revoke confirmations), `DeleteWorkspaceDialog.tsx` (type-name-to-confirm), `invite-accept.tsx` (valid/expired/revoked/already-member states, both accept paths)
- `RootRedirect` and `WorkspaceSwitcher` switched to reading `/api/workspaces` (already `deleted_at`-filtered) instead of better-auth's own `organization.list`, so a soft-deleted workspace cannot reappear anywhere in the UI

## Task Commits

Each task was committed atomically:

1. **Task 1: Failing tests — invite lifecycle and role/permission gating** - `1dfa195` (test)
2. **Task 2: Invite/member/delete backend over better-auth org plugin + role gates** - `2ef6ec4` (feat)
3. **Task 3: Team UI — member table, invite modal, accept page, dialogs** - `ec888af` (feat)

**Task 4 status:** `checkpoint:human-verify` — DEFERRED to phase-level UAT (see below). No implementation work was skipped; automated coverage for Tasks 1-3 is green.

_Note: This plan used TDD (tdd="true" on Tasks 2 and 3); RED (`1dfa195`) precedes GREEN (`2ef6ec4`, `ec888af`)._

## Verification Performed (this continuation session)

- `cd apps/api && npx vitest run` → **6 test files passed, 21/21 tests passed** (includes the 10 new invite-flow/role-guard tests)
- `cd apps/api && npm run build` (tsc) → clean, exit 0
- `cd apps/web && npx tsc --noEmit` → clean, exit 0
- `cd apps/web && npm run build` (tsc + vite build) → clean, exit 0
- Migration `packages/db/migrations/0002_invitation_created_at.sql` present and applied (per prior session; re-confirmed present on disk)

## Files Created/Modified
- `apps/api/src/modules/tenancy/invites.ts` - create/accept-existing/register-from-invite/revoke/resend over the org plugin
- `apps/api/src/modules/tenancy/members.ts` - listMembers/updateMemberRole/removeMember with role gates
- `apps/api/src/modules/tenancy/member-roles.ts` / `workspace-lookup.ts` - supporting helpers for role-gate checks and slug lookups
- `apps/api/src/modules/tenancy/workspaces.ts` - Owner-only soft-delete route + deleted_at filtering
- `apps/api/src/modules/auth/auth.ts` - `sendInvitationEmail` wired to `platformMail.sendInvite`
- `apps/api/src/modules/auth/access-control.ts`, `apps/api/src/middleware/role-guard.ts` - Owner-only elevation checks for Admin-assignment/ownership-transfer
- `packages/shared-schemas/src/invite.ts` - `inviteSchema`/`acceptInviteSchema`/`registerFromInviteSchema`
- `packages/db/migrations/0002_invitation_created_at.sql` + schema change in `packages/db/src/schema/auth.ts`
- `apps/web/src/features/team/{TeamPage,InviteModal,MemberRow,DeleteWorkspaceDialog}.tsx`, `apps/web/src/routes/invite-accept.tsx`
- `apps/web/src/App.tsx`, `AppShell.tsx` - route registration + "Команда" nav link
- `apps/web/src/features/workspace-switcher/WorkspaceSwitcher.tsx`, `apps/web/src/lib/api.ts` - deleted_at-safe workspace reads, `apiDelete` helper
- `apps/api/src/modules/tenancy/__tests__/{invite-flow,role-guard}.test.ts` - RED/GREEN test coverage

## Decisions Made
- Owner-only branch layered on top of `requirePermission` for Admin-role assignment and ownership transfer, since the org plugin's default admin permission set does not enforce D-18 on its own.
- Web reads workspace membership via `/api/workspaces` (already `deleted_at`-filtered) rather than better-auth's `organization.list`, guaranteeing a soft-deleted workspace never resurfaces in `RootRedirect` or `WorkspaceSwitcher`.
- Task 4 (human browser verification) is DEFERRED to phase-level UAT rather than blocking plan completion — see Deviations.

## Deviations from Plan

None beyond the Task 4 checkpoint deferral (Rule 4 does not apply — no architectural change was made; the deferral is a checkpoint-scheduling decision, not a code deviation).

### Checkpoint Deferral (Task 4)

**Task 4 — Human verification — invites, roles, and safe delete** was reached in a prior execution session. The user was unavailable at the checkpoint. Per orchestrator ruling, the browser-based human verification is **DEFERRED to phase-level UAT** rather than blocking completion of this plan, on the strength of:
- 21/21 vitest passing (including the 10 new invite-flow/role-guard tests added in this plan)
- Clean `apps/api` and `apps/web` builds
- Clean `tsc --noEmit`
- Migration `0002_invitation_created_at.sql` applied to test and dev databases

**Task 4 is recorded as DEFERRED, not PASSED.** The following manual checks remain outstanding and must be completed during phase-level UAT in a real browser:

1. **Invite email delivery + copyable-link fallback** — As Owner, open `/w/{slug}/team` → «Пригласить коллегу» → invite a second email; confirm the invite email actually arrives AND the modal shows a copyable link («Скопировать ссылку» → «Скопировано»), with toast «Приглашение отправлено».
2. **Register-from-invite in incognito** — Open the invite link in a separate browser/incognito with no account → «Создать аккаунт и присоединиться» (email pre-filled/locked) → confirm the user joins the workspace with the assigned role.
3. **Join-with-existing-account via invite link** — Open an invite link for an already-existing account → «Присоединиться к воркспейсу» joins.
4. **Expired/revoked link messaging** — Confirm an expired link shows «Срок действия приглашения истёк…» and a revoked link shows «Это приглашение больше не действует…» (distinct copy).
5. **Member sees no invite/role/remove/delete controls** — As that Member, confirm the team page hides (not disables) invite/role/remove/delete controls.
6. **Owner-only Admin-assignment/ownership-transfer** — As Owner, confirm only the Owner (not an Admin) can assign the Admin role / transfer ownership.
7. **Type-name-to-confirm workspace delete** — Delete a throwaway workspace via the type-name confirmation and confirm it disappears from the switcher.

No live browser interaction was attempted during this continuation session, per resume instructions. Only automated verification (vitest, tsc, builds) was re-run to confirm the green state still holds before closing the plan.

## Issues Encountered
None beyond the documented Task 4 deferral.

## User Setup Required

None new for this plan. (Platform SendGrid credentials required for invite-email delivery were already specified in 01-03's `user_setup` and must be in place before phase UAT exercises check #1 above.)

## Next Phase Readiness
- Invite/member/role/soft-delete surface is ready for 01-05 to build on (workspace settings / SendGrid-connect, which sits behind the same role gates).
- Phase-level UAT must complete the 7 deferred manual checks above before this plan's `must_haves.truths` are considered fully proven end-to-end — automated coverage proves the code paths (creation, role gating, server-side re-validation, exclusion from list/read); UAT proves the live browser experience (email delivery, copy interactions, distinct error messaging, DOM-level control hiding, switcher removal).

---
*Phase: 01-workspace-foundation-team-access*
*Completed: 2026-07-03*
