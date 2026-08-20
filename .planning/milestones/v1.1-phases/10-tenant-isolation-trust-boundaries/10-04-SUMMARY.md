---
phase: 10-tenant-isolation-trust-boundaries
plan: 04
subsystem: api
tags: [fastify, security, anti-enumeration, better-auth, vitest]

# Dependency graph
requires:
  - phase: 10-tenant-isolation-trust-boundaries (plan 02)
    provides: "resolveWorkspaceMember + frozen NOT_FOUND_BODY constant every workspace-membership 404 path sends"
provides:
  - "apps/api/src/__tests__/anti-enumeration-sweep.test.ts -- parameterized sweep proving missing-vs-cross-tenant is byte-identical across 9 resource kinds + 2 workspace-level cases"
  - "role-guard.ts's requirePermission imports the shared NOT_FOUND_BODY (no re-typed literal) and catches hasPermission's non-member throw, closing a real 401-vs-404 enumeration oracle the sweep caught"
  - "invites.ts's GET /api/invites/:id shares one INVITATION_NOT_FOUND_BODY constant across both 404 branches; 200 payload field-by-field audited against apps/web's InviteAcceptPage"
  - "apps/api/src/modules/tenancy/__tests__/invite-response-identity.test.ts -- 4-test suite covering nonexistent id, org-gone id, exact-key-list 200, and repeat-request byte-identity"
affects: [Phase 15 request_id/workspace_id log tagging, any future resource-scoped route (must add a row to the sweep)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Anti-enumeration sweep as a single parameterized it.each matrix -- new resource routes add a row, never a new bespoke test file"
    - "requirePermission's non-member-of-a-real-workspace throw from better-auth's hasPermission is caught and mapped to the same NOT_FOUND_BODY 404 as a nonexistent workspace, mirroring resolveWorkspaceMember's own catch pattern"

key-files:
  created:
    - apps/api/src/__tests__/anti-enumeration-sweep.test.ts
    - apps/api/src/modules/tenancy/__tests__/invite-response-identity.test.ts
  modified:
    - apps/api/src/middleware/role-guard.ts
    - apps/api/src/modules/tenancy/invites.ts

key-decisions:
  - "requirePermission's hasPermission call is wrapped in try/catch: better-auth throws (not `{success:false}`) when the caller isn't a member of the target organization at all, which uncaught surfaced a bare 401 for a real foreign workspace slug vs this same guard's own 404 for a nonexistent slug -- a genuine enumeration oracle the sweep caught mid-execution (Rule 1 auto-fix, not a pre-planned task item)."
  - "RESEARCH.md Open Question #1 resolved as interpretation (a): tighten the invite-preview 404 path only, keep the 200 preview intact for a genuinely actionable (pending/expired/revoked/accepted) invitation -- a legitimate invitee with no account yet must still see who invited them (D-12). Interpretation (b), shrinking the expired/revoked payload, was considered and explicitly NOT taken."
  - "'segment-scoped analytics resource' (plan's minimum coverage list) is represented by GET /segments/:id/members -- D-12's paginated membership list, existence-gated on the same getSegment(id) check as the segment resource itself."
  - "The 'invitation exists but its organization row is gone' state (invitation.organizationId has ON DELETE CASCADE, so ordinary deletion cascades the invitation away too) is produced in the test by momentarily DROPping and re-ADDing the FK as NOT VALID around a single DELETE -- table-owner privilege, no superuser required, unlike DISABLE TRIGGER ALL or session_replication_role=replica which both failed with permission denied against the mega_crm_app role."

patterns-established:
  - "New resource-scoped route: add one row to apps/api/src/__tests__/anti-enumeration-sweep.test.ts's resourceCases matrix rather than writing a new missing-vs-forbidden test."

requirements-completed: [SEC-10, SEC-15]

coverage:
  - id: D1
    description: "Parameterized sweep proves a missing id and a cross-tenant id return byte-identical status+body across 9 resource kinds (contact, campaign, flow, flow-analytics, segment, segment-members, send-log entry, csv import, api key) under an authenticated workspace-A-only member"
    requirement: "SEC-10"
    verification:
      - kind: unit
        ref: "apps/api/src/__tests__/anti-enumeration-sweep.test.ts (it.each over resourceCases, 9 cases)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Workspace-level anti-enumeration holds on both resolveWorkspaceMember-backed routes and requirePermission-backed routes (a nonexistent slug and a non-member-of-a-real-workspace slug return byte-identical 404)"
    requirement: "SEC-15"
    verification:
      - kind: unit
        ref: "apps/api/src/__tests__/anti-enumeration-sweep.test.ts (workspace-level resolveWorkspaceMember + requirePermission cases)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Positive control proves the sweep fixture reaches real handlers (not vacuously 401ing) -- workspace A's own contact returns 200"
    requirement: "SEC-10"
    verification:
      - kind: unit
        ref: "apps/api/src/__tests__/anti-enumeration-sweep.test.ts (positive control test)"
        status: pass
    human_judgment: false
  - id: D4
    description: "role-guard.ts's requirePermission shares resolveWorkspaceMember's NOT_FOUND_BODY constant (missing-workspace branch) and maps hasPermission's non-member throw to the same 404 (permission-check branch), closing a real 401-vs-404 enumeration oracle"
    requirement: "SEC-15"
    verification:
      - kind: unit
        ref: "apps/api/src/__tests__/anti-enumeration-sweep.test.ts (requirePermission workspace-level case) + apps/api/src/modules/tenancy/__tests__/role-guard.test.ts (regression, 4 tests)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Invite preview endpoint returns identical 404 for a nonexistent invitation id and one whose organization row is gone, byte-identical across repeat requests, and returns exactly the 5-field audited payload for a pending invitation"
    requirement: "SEC-10"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/tenancy/__tests__/invite-response-identity.test.ts (4 tests)"
        status: pass
    human_judgment: false

# Metrics
duration: 55min
completed: 2026-08-07
status: complete
---

# Phase 10 Plan 04: Anti-Enumeration Sweep & Invite Preview Identity Summary

**Parameterized missing-vs-cross-tenant sweep across 9 resource kinds plus two workspace-level cases, which caught and fixed a real 401-vs-404 enumeration oracle in `requirePermission` (not just the planned literal-drift risk), plus an invite-preview endpoint that now shares one not-found constant and carries only its audited 5-field payload.**

## Performance

- **Duration:** 55 min
- **Tasks:** 2
- **Files modified:** 4 (2 created, 2 modified)

## Accomplishments
- `apps/api/src/__tests__/anti-enumeration-sweep.test.ts`: a single `it.each`-driven matrix seeds two workspaces, then for 9 resource kinds (contact, campaign, flow, flow-analytics, segment, segment-members, send-log entry, csv import, api key) issues a missing-id request and a cross-tenant (workspace-B) id request as an authenticated workspace-A-only member, asserting equal status codes and byte-identical raw response bodies. Two additional workspace-level tests cover both `resolveWorkspaceMember`-backed routes and `requirePermission`-backed routes for a nonexistent-slug-vs-non-member-slug comparison. A positive control proves the fixture reaches real 200 handlers, ruling out a vacuous pass.
- `role-guard.ts`'s `requirePermission` now imports `NOT_FOUND_BODY` from `resolve-workspace-member.ts` instead of a re-typed literal for its missing-workspace 404 branch (byte-identical either way, but now drift-proof).
- Mid-sweep, the workspace-level `requirePermission` test failed with `401` instead of `404`: better-auth's `hasPermission` **throws** (not `{success:false}`) when the caller isn't a member of the target organization at all, which was uncaught and surfaced a bare 401 for a *real* foreign workspace slug — distinguishable from this same guard's 404 for a nonexistent slug, a genuine enumeration oracle. Fixed by wrapping the `hasPermission` call in try/catch and mapping any throw (when a workspace was resolved) to the identical `NOT_FOUND_BODY` 404, mirroring `resolveWorkspaceMember`'s own non-member catch branch.
- `invites.ts`'s `GET /api/invites/:invitationId` now sends a single module-level `INVITATION_NOT_FOUND_BODY` from both 404 branches (nonexistent id; id exists but its organization row is gone). The handler doc comment resolves RESEARCH.md Open Question #1 as interpretation (a) and records a field-by-field audit of the 200 payload against `apps/web/src/routes/invite-accept.tsx`'s `InviteAcceptPage` — all 5 fields (`email`, `role`, `organizationName`, `organizationSlug`, `status`) are actually read; none were removed.
- New `invite-response-identity.test.ts` (4 tests): nonexistent id 404s with the shared body; an invitation whose organization row was forced gone (via a momentary FK drop/re-add-`NOT VALID` around one `DELETE`, since ordinary deletion would cascade-delete the invitation too) returns the byte-identical 404; a pending invitation returns exactly the 5 audited keys; two consecutive misses return byte-identical bodies.
- Full `apps/api` suite (54 files, 305 tests), `npm run lint`, and `npm run build --workspace=apps/api` all pass.

## Task Commits

Each task was committed atomically:

1. **Task 1: Parameterized missing-vs-forbidden sweep across every resource route** - `c00a711` (test)
2. **Lint follow-up on Task 1's role-guard.ts** - `9871e1e` (fix)
3. **Task 2: Invite preview endpoint — identical responses and minimal payload** - `46efc6d` (test)

**Plan metadata:** worktree mode — `.planning/` is gitignored in this repo; no separate docs commit per repo convention (see `10-02-SUMMARY.md`).

_Note: worktree-isolated execution — STATE.md/ROADMAP.md are NOT updated here; the orchestrator owns those writes after all wave agents complete._

## Files Created/Modified
- `apps/api/src/__tests__/anti-enumeration-sweep.test.ts` - platform-wide anti-enumeration contract; 9-resource-kind + 2-workspace-level + 1-positive-control test matrix
- `apps/api/src/middleware/role-guard.ts` - `requirePermission` imports `NOT_FOUND_BODY`, catches `hasPermission`'s non-member throw
- `apps/api/src/modules/tenancy/invites.ts` - hoisted `INVITATION_NOT_FOUND_BODY`, handler doc comment records the interpretation-(a) decision and the payload audit
- `apps/api/src/modules/tenancy/__tests__/invite-response-identity.test.ts` - 4-test suite for the invite preview endpoint's identity + minimality contract

## Decisions Made
- `requirePermission`'s `hasPermission` throw-on-non-member is mapped to `NOT_FOUND_BODY` 404 only when a workspace was actually resolved (`organizationId` set) — for the (currently nonexistent in this codebase) case of a slug-less `requirePermission` route, the original error still propagates rather than being silently swallowed.
- Kept the invite preview's 200 payload exactly as-is (5 fields) rather than trimming it for the expired/revoked/accepted states — RESEARCH.md's locked interpretation (a) only requires the 404 paths to be identical; shrinking the 200 payload for those states would change legitimate-invitee UX, not attacker-visible behavior, and was explicitly out of scope.
- "Segment-scoped analytics resource" (the plan's 8th minimum resource kind) is represented by `GET /segments/:id/members` rather than a dedicated analytics endpoint that doesn't exist for segments — documented in the sweep test's doc comment as the interpretation taken.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `requirePermission` leaked workspace existence via 401-vs-404 for a real foreign workspace**
- **Found during:** Task 1 (running the new workspace-level sweep case against the `api-keys` list route)
- **Issue:** `auth.api.hasPermission` throws when the caller isn't a member of `organizationId` at all (distinct from "member but insufficient role", which resolves `{success:false}`). Uncaught, this surfaced a bare `401` for a genuinely-existing foreign workspace, while the same guard's own missing-workspace branch returns `404` — an authenticated caller could distinguish "workspace doesn't exist" from "workspace exists but I'm not in it" on every `requirePermission`-gated route (api-keys, campaigns launch/schedule/cancel/duplicate, flows publish/pause/resume/eject/delete, invites, members, sendgrid-key, webhook-settings, send-settings, organization-delete).
- **Fix:** Wrapped `hasPermission` in try/catch; any throw when a workspace was resolved is mapped to the identical `NOT_FOUND_BODY` 404, mirroring `resolveWorkspaceMember`'s established non-member catch pattern.
- **Files modified:** `apps/api/src/middleware/role-guard.ts`
- **Verification:** New workspace-level `requirePermission` sweep case passes; full `role-guard.test.ts` regression suite (4 tests) still passes.
- **Committed in:** `c00a711` (Task 1 commit)

**2. [Rule 3 - Blocking] Redundant type assertion after adding the try/catch's typed `let` binding**
- **Found during:** `npm run lint` (this plan's own verification step)
- **Issue:** `@typescript-eslint/no-unnecessary-type-assertion` — the `let result: {success?:boolean}|boolean` declaration already narrows the assignment target's type, making the `as {success?:boolean}|boolean` cast on the same expression redundant.
- **Fix:** Removed the cast.
- **Files modified:** `apps/api/src/middleware/role-guard.ts`
- **Verification:** `npm run lint` exits 0; full `apps/api` suite still 305/305.
- **Committed in:** `9871e1e`

---

**Total deviations:** 2 auto-fixed (1 bug/security, 1 blocking/lint)
**Impact on plan:** The 401-vs-404 fix is a genuine security correctness fix directly within SEC-15's scope (this plan's own threat model T-10-04-02 anticipated literal drift risk on this exact code path; the sweep found a deeper live bug there, not just the drift risk). No scope creep — both fixes are confined to `role-guard.ts`, the file this plan's Task 1 already targets.

## Issues Encountered
- Producing "an invitation whose organization row is gone" for Test 2 of the invite-response-identity suite required working around `invitation.organizationId`'s `ON DELETE CASCADE` FK, which makes this state unreachable via ordinary deletion (the invitation cascades away with the organization). `ALTER TABLE ... DISABLE TRIGGER ALL` and `SET session_replication_role = replica` both failed with `permission denied` against the test DB's `mega_crm_app` role (neither is superuser, and disabling a system-generated FK-enforcement trigger requires it). Resolved by dropping and re-adding the FK constraint as `NOT VALID` around a single `DELETE` — an operation table-owner privilege is sufficient for, and which re-enables enforcement for every subsequent insert/update without needing to re-validate the now-orphaned row.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- `anti-enumeration-sweep.test.ts`'s `resourceCases` matrix is the platform-wide contract point: any future resource-scoped route should add a row there rather than a new bespoke missing-vs-forbidden test file.
- `requirePermission`'s non-member catch pattern (map any workspace-scoped auth throw to `NOT_FOUND_BODY`) is now precedent for any future permission-gated route needing the same anti-enumeration guarantee.

---
*Phase: 10-tenant-isolation-trust-boundaries*
*Plan: 04*
*Completed: 2026-08-07*

## Self-Check: PASSED

- FOUND: apps/api/src/__tests__/anti-enumeration-sweep.test.ts
- FOUND: apps/api/src/modules/tenancy/__tests__/invite-response-identity.test.ts
- FOUND: apps/api/src/middleware/role-guard.ts
- FOUND: apps/api/src/modules/tenancy/invites.ts
- FOUND commit: c00a711
- FOUND commit: 9871e1e
- FOUND commit: 46efc6d
