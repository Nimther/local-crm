---
phase: 01-workspace-foundation-team-access
plan: 06
subsystem: api
tags: [fastify, better-auth, rls, sendgrid, pg, security-fix]

# Dependency graph
requires:
  - phase: 01-workspace-foundation-team-access
    provides: sendgrid-key routes, invites routes, platform-mail invite template, and the pg Pool from earlier 01-0x plans
provides:
  - Membership-gated GET /api/workspaces/:slug/sendgrid-key (closes CR-01 blocker / TENANT-05 gap)
  - Permission-gated GET /api/workspaces/:slug/invites (closes WR-02)
  - HTML-escaped orgName in invite emails (closes CR-02)
  - Production pg Pool error listener (closes CR-03)
affects: [phase-01-verification, any future phase touching sendgrid-key.ts, invites.ts, platform-mail templates, or db.ts]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Uniform-404 pattern for membership checks: wrap getCallerRoles in try/catch and map ANY throw (unauthenticated, unknown slug, non-member) to the same 404 body a nonexistent resource returns, closing enumeration oracles."
    - "Module-private escapeHtml() helper for entity-escaping user-controlled strings before interpolation into platform-sent HTML email bodies."

key-files:
  created: []
  modified:
    - apps/api/src/modules/tenancy/sendgrid-key.ts
    - apps/api/src/modules/tenancy/__tests__/sendgrid-key-connect.test.ts
    - apps/api/src/modules/tenancy/invites.ts
    - apps/api/src/modules/tenancy/__tests__/invite-flow.test.ts
    - apps/api/src/modules/platform-mail/templates/invite.ts
    - apps/api/src/modules/platform-mail/__tests__/platform-mail.test.ts
    - apps/api/src/db.ts

key-decisions:
  - "GET sendgrid-key uses a try/catch around getCallerRoles (not requirePermission), since the route must remain readable by any member and must return 404 (not 403) for non-members to close the enumeration oracle."
  - "GET /invites reuses the existing invitation:create permission (same as sibling POST create route) rather than introducing a new permission, since Owner/Admin already hold it and Member correctly lacks it per D-17."
  - "Invite email subject line left unescaped (deliberately) -- it is a JSON field rendered as plain text by mail clients, not an HTML sink, so escaping it would only surface literal entity codes."

requirements-completed: [TENANT-05, TENANT-04]

coverage:
  - id: D1
    description: "GET /api/workspaces/:slug/sendgrid-key returns 404 (not 200) for unauthenticated and non-member callers, and the identical 404 body for a nonexistent workspace, closing the cross-tenant info-disclosure and enumeration oracle (CR-01 blocker)."
    requirement: TENANT-05
    verification:
      - kind: unit
        ref: "apps/api/src/modules/tenancy/__tests__/sendgrid-key-connect.test.ts#GET returns 404 (no keyMask) for an unauthenticated caller (CR-01)"
        status: pass
      - kind: unit
        ref: "apps/api/src/modules/tenancy/__tests__/sendgrid-key-connect.test.ts#GET returns the same 404 for an authenticated non-member as for a nonexistent workspace (no enumeration oracle)"
        status: pass
      - kind: unit
        ref: "apps/api/src/modules/tenancy/__tests__/sendgrid-key-connect.test.ts#GET returns 200 for a plain Member (not over-restricted to Owner/Admin)"
        status: pass
      - kind: unit
        ref: "apps/api/src/modules/tenancy/__tests__/sendgrid-key-connect.test.ts#GET returns 200 with keyMask for the Owner after a successful connect"
        status: pass
    human_judgment: false
  - id: D2
    description: "GET /api/workspaces/:slug/invites is 403 for a plain Member (accept tokens no longer leak); Owner still gets 200 (WR-02)."
    verification:
      - kind: unit
        ref: "apps/api/src/modules/tenancy/__tests__/invite-flow.test.ts#a plain Member is 403'd from GET /invites (cannot read pending invites or accept tokens); the Owner still gets 200 (WR-02)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Invite email HTML body HTML-escapes attacker-controlled orgName, neutralizing injected markup (CR-02)."
    verification:
      - kind: unit
        ref: "apps/api/src/modules/platform-mail/__tests__/platform-mail.test.ts#renderInviteHtml HTML-escapes an attacker-controlled orgName (CR-02)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Production pg Pool has an 'error' listener logging idle-connection termination instead of crashing the process (CR-03)."
    verification:
      - kind: other
        ref: "grep -n 'pool.on(\"error\"' apps/api/src/db.ts (source assertion; no cheap behavioral harness exists for a real idle-connection-drop event)"
        status: pass
    human_judgment: false

duration: 2min
completed: 2026-07-03
status: complete
---

# Phase 01 Plan 06: Gap Closure — CR-01 Blocker + WR-02/CR-02/CR-03 Summary

**Membership-gated GET sendgrid-key route (closing a live unauthenticated cross-tenant key-metadata leak), permission-gated GET /invites, HTML-escaped invite emails, and a production pg Pool error listener.**

## Performance

- **Duration:** 2 min (execution) — commits span 17:53:10 to 17:54:41
- **Started:** 2026-07-03T17:53:10+05:00
- **Completed:** 2026-07-03T17:54:41+05:00
- **Tasks:** 3
- **Files modified:** 7

## Accomplishments
- Closed the Phase 1 verification blocker (CR-01): GET /api/workspaces/:slug/sendgrid-key now requires the caller to be an authenticated workspace member, and returns a uniform 404 (identical to the nonexistent-workspace body) for unauthenticated callers and non-members alike, eliminating both the info-disclosure and the workspace-enumeration oracle.
- Closed WR-02: GET /api/workspaces/:slug/invites now requires `invitation:create` permission, so a plain Member can no longer list pending invites or read `inviteUrl` accept tokens.
- Closed CR-02: `renderInviteHtml` now routes `orgName` through a new `escapeHtml()` helper before interpolating it into the invite email's h1/p markup, neutralizing HTML/anchor injection from attacker-controlled workspace names.
- Closed CR-03: the production `pg` Pool now has an `error` listener that logs idle-connection termination (Postgres restart/failover/timeout) instead of letting it crash the API process via an uncaught exception.
- Full API suite (`npx vitest run --root apps/api`) passes with 38/38 tests (32 prior + 6 new).

## Task Commits

Each task was committed atomically:

1. **Task 1: Gate GET sendgrid-key on workspace membership (CR-01 blocker) + regression tests** - `0bcff83` (fix)
2. **Task 2: Permission-gate GET /invites so Members cannot harvest accept tokens (WR-02) + regression test** - `bb75739` (fix)
3. **Task 3: Escape orgName in invite emails (CR-02) + add production pg Pool error listener (CR-03)** - `fe25bbe` (fix)

_Note: All three tasks are `tdd="true"`; each commit bundles the new regression test alongside the fix since the plan directs adding the test and the fix together per task, and the pre-existing suite already passed (no separate RED-only commit possible without breaking the shared test files)._

## Files Created/Modified
- `apps/api/src/modules/tenancy/sendgrid-key.ts` - GET handler now wraps `getCallerRoles` in try/catch, mapping any throw to 404
- `apps/api/src/modules/tenancy/__tests__/sendgrid-key-connect.test.ts` - 4 new GET regression tests (unauth 404, non-member 404 matching nonexistent-workspace body, Member 200, Owner-connected 200 with keyMask)
- `apps/api/src/modules/tenancy/invites.ts` - GET /invites route now carries `requirePermission("invitation", "create")` preHandler
- `apps/api/src/modules/tenancy/__tests__/invite-flow.test.ts` - new Member-403/Owner-200 regression test; `signUp` helper extended to also return `userId`
- `apps/api/src/modules/platform-mail/templates/invite.ts` - new `escapeHtml()` helper; `renderInviteHtml` now escapes `orgName` before interpolation
- `apps/api/src/modules/platform-mail/__tests__/platform-mail.test.ts` - new escaping regression test for `renderInviteHtml`
- `apps/api/src/db.ts` - `pool.on("error", ...)` listener added, logging via the shared Pino logger

## Decisions Made
- GET sendgrid-key deliberately does NOT use `requirePermission` (which would 403 non-members and over-restrict Members) — it uses a raw `getCallerRoles` try/catch mapped uniformly to 404, matching the plan's explicit rationale for closing the enumeration oracle while keeping the route member-readable.
- GET /invites reuses the existing `invitation:create` permission rather than adding a new one, since it's the exact permission set that already distinguishes Owner/Admin from Member per D-17.
- Left the invite email subject line unescaped per the plan's explicit rationale (JSON field rendered as plain text by mail clients, not an HTML sink).

## Deviations from Plan

None — plan executed exactly as written. All four `must_haves.truths` and all `key_links` from the plan frontmatter are satisfied by the committed diffs (verified via the plan's own grep-based acceptance criteria, all of which passed).

## Issues Encountered
None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 1's CR-01 blocker is closed; the phase is ready for re-verification.
- WR-02/CR-02/CR-03 warning findings from the same code-review surface are also closed in this plan.
- Full API test suite green (38/38); no new debt markers (`TBD|FIXME|XXX|TODO|HACK|PLACEHOLDER`) introduced in non-test source.
- Out of scope by design (per plan's scope guardrail): WR-01/WR-03..WR-07/IN-01..IN-09 and the 16 human-verification/UAT items remain untouched, still tracked in STATE.md's Blockers/Concerns for phase-level UAT.

---
*Phase: 01-workspace-foundation-team-access*
*Completed: 2026-07-03*

## Self-Check: PASSED

All 7 files_modified from plan frontmatter found on disk. All 3 task commit hashes (0bcff83, bb75739, fe25bbe) found in git log.
