---
phase: 10-tenant-isolation-trust-boundaries
plan: 02
subsystem: api
tags: [fastify, better-auth, rls, security, deduplication]

# Dependency graph
requires: []
provides:
  - Single `resolveWorkspaceMember` implementation in `apps/api/src/modules/tenancy/resolve-workspace-member.ts`
  - Shared `NOT_FOUND_BODY` constant every workspace-membership 404 path sends
  - `WorkspaceMemberResolution` return contract (`{ workspace, roles }`) for future callers
affects: [10-04 anti-enumeration sweep, Phase 15 request_id/workspace_id log tagging]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "One shared resolver + one frozen NOT_FOUND_BODY constant for every workspace-membership failure path, mirroring api-key-auth.ts's UNAUTHORIZED_BODY precedent"

key-files:
  created:
    - apps/api/src/modules/tenancy/resolve-workspace-member.ts
    - apps/api/src/modules/tenancy/__tests__/resolve-workspace-member.test.ts
  modified:
    - apps/api/src/modules/contacts/contacts.routes.ts
    - apps/api/src/modules/contacts/csv-import.routes.ts
    - apps/api/src/modules/send-log/send-log.routes.ts
    - apps/api/src/modules/flows/flows.routes.ts
    - apps/api/src/modules/segments/segments.routes.ts
    - apps/api/src/modules/campaigns/campaigns.routes.ts
    - apps/api/src/modules/analytics/flow-analytics.routes.ts
    - apps/api/src/modules/analytics/timeline.routes.ts
    - apps/api/src/modules/analytics/dashboard.routes.ts

key-decisions:
  - "resolveWorkspaceMember now returns { workspace, roles } instead of just workspace -- roles is the one behavioral addition over the nine former copies, letting a future change remove a route's second getCallerRoles call without altering this contract. No caller's role logic changed in this plan."
  - "flows.routes.ts and campaigns.routes.ts keep their separate, unrelated findActiveWorkspaceBySlug call sites (publish/pause/resume/eject/delete, launch/schedule/cancel/duplicate -- all gated by requirePermission preHandlers instead) untouched; only the resolveWorkspaceMember local-copy call sites were rewired."

patterns-established:
  - "Workspace-membership resolution: import resolveWorkspaceMember from tenancy/resolve-workspace-member.js, never redeclare a local copy."

requirements-completed: [SEC-14]

coverage:
  - id: D1
    description: "Single resolveWorkspaceMember implementation exists; its four failure paths (unknown slug, soft-deleted workspace, unauthenticated caller, non-member caller) are byte-identical, proven by an automated test driving the real HTTP stack"
    requirement: "SEC-14"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/tenancy/__tests__/resolve-workspace-member.test.ts (6 tests)"
        status: pass
    human_judgment: false
  - id: D2
    description: "All nine former local resolveWorkspaceMember copies replaced with the shared import; exactly one declaration remains in the tree; existing apps/api suite passes unchanged"
    requirement: "SEC-14"
    verification:
      - kind: other
        ref: "grep -rn \"async function resolveWorkspaceMember\" apps/api/src --include=*.ts (1 match, tenancy/resolve-workspace-member.ts)"
        status: pass
      - kind: unit
        ref: "npx vitest run --root apps/api (52 files, 287 tests)"
        status: pass
      - kind: other
        ref: "npm run build --workspace=apps/api && npm run lint"
        status: pass
    human_judgment: false

duration: 25min
completed: 2026-08-07
status: complete
---

# Phase 10 Plan 02: Unified Workspace-Membership Resolver Summary

**Collapsed nine near-identical `resolveWorkspaceMember` route-module copies into one shared `apps/api/src/modules/tenancy/resolve-workspace-member.ts`, exporting a single frozen `NOT_FOUND_BODY` constant every membership-failure path now sends.**

## Performance

- **Duration:** 25 min
- **Tasks:** 2
- **Files modified:** 11 (2 created, 9 modified)

## Accomplishments
- New `resolveWorkspaceMember` in `tenancy/resolve-workspace-member.ts`: resolves `:slug` → `findActiveWorkspaceBySlug`, then `getCallerRoles` in a try/catch; any failure (unknown slug, soft-deleted workspace, unauthenticated caller, non-member caller) sends the identical `NOT_FOUND_BODY` 404 and returns `null`. On success returns `{ workspace, roles }`.
- Six-behavior test suite (`resolve-workspace-member.test.ts`) drives the real HTTP stack via `buildServer()` + `.inject()` through a test-only route, exercising the actual `getCallerRoles`/better-auth membership path — not a mock. Test 6 asserts the four failure-path response bodies are byte-identical strings.
- All nine former local copies (contacts, csv-import, send-log, flows, segments, campaigns, flow-analytics, timeline, dashboard route modules) deleted; every call site now imports the shared function and destructures `resolved.workspace`.
- `flows.routes.ts` and `campaigns.routes.ts` retained their separate direct `findActiveWorkspaceBySlug` calls on `requirePermission`-gated routes (publish/pause/resume/eject/delete, launch/schedule/cancel/duplicate) — those were never part of the duplicated `resolveWorkspaceMember` copy and were explicitly out of scope per the plan.
- Full apps/api suite (52 files, 287 tests), `npm run build --workspace=apps/api`, and `npm run lint` all pass unchanged.

## Task Commits

Each task was committed atomically:

1. **Task 1: Extract the single `resolveWorkspaceMember` implementation** - `f72420f` (feat)
2. **Task 2: Replace all nine local copies with the shared import** - `f8fde0f` (refactor)

**Plan metadata:** worktree mode — `.planning/` is gitignored in this repo; no separate docs commit (see Deviations).

_Note: worktree-isolated execution — STATE.md/ROADMAP.md are NOT updated here; the orchestrator owns those writes after all wave agents complete._

## Files Created/Modified
- `apps/api/src/modules/tenancy/resolve-workspace-member.ts` - the single shared implementation, exports `resolveWorkspaceMember` + `NOT_FOUND_BODY` + `WorkspaceMemberResolution`
- `apps/api/src/modules/tenancy/__tests__/resolve-workspace-member.test.ts` - 6-test suite proving the four failure paths byte-identical
- `apps/api/src/modules/contacts/contacts.routes.ts` - imports shared resolver, 6 call sites updated to `resolved.workspace`
- `apps/api/src/modules/contacts/csv-import.routes.ts` - imports shared resolver, 6 call sites updated (kept `toFetchHeaders` for its own `auth.api.getSession` call)
- `apps/api/src/modules/send-log/send-log.routes.ts` - imports shared resolver, 2 call sites updated
- `apps/api/src/modules/flows/flows.routes.ts` - imports shared resolver, 7 call sites updated (kept `findActiveWorkspaceBySlug`/`toFetchHeaders` imports for unrelated call sites)
- `apps/api/src/modules/segments/segments.routes.ts` - imports shared resolver, 8 call sites updated (kept `toFetchHeaders` for its own session call)
- `apps/api/src/modules/campaigns/campaigns.routes.ts` - imports shared resolver, 11 call sites updated (kept `findActiveWorkspaceBySlug`/`toFetchHeaders` imports for unrelated call sites)
- `apps/api/src/modules/analytics/flow-analytics.routes.ts` - imports shared resolver, 1 call site updated
- `apps/api/src/modules/analytics/timeline.routes.ts` - imports shared resolver, 1 call site updated
- `apps/api/src/modules/analytics/dashboard.routes.ts` - imports shared resolver, 1 call site updated

## Decisions Made
- `resolveWorkspaceMember` returns `{ workspace, roles }` rather than bare `workspace` — the one deliberate behavioral addition over the nine former copies (which all discarded roles). No caller's role-check logic was changed in this plan; the extra `roles` value is unused by every current call site, positioned only as the attachment point for a future de-duplication of second `getCallerRoles` calls.
- Kept `flows.routes.ts`'s and `campaigns.routes.ts`'s direct `findActiveWorkspaceBySlug` calls (on their `requirePermission`-gated routes) untouched — these were never local copies of `resolveWorkspaceMember`, they're a separate pattern (role-gated routes resolve the workspace directly, then check permission via `requirePermission` preHandler instead of member-only `getCallerRoles`).

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- `resolve-workspace-member.ts`'s `NOT_FOUND_BODY` constant is the single attachment point plan 10-04's anti-enumeration sweep needs to assert against platform-wide.
- The `roles` field returned by `resolveWorkspaceMember` is available for future callers that currently issue a second `getCallerRoles` call for owner/admin checks (not touched in this plan).

---
*Phase: 10-tenant-isolation-trust-boundaries*
*Plan: 02*
*Completed: 2026-08-07*

## Self-Check: PASSED

- FOUND: apps/api/src/modules/tenancy/resolve-workspace-member.ts
- FOUND: apps/api/src/modules/tenancy/__tests__/resolve-workspace-member.test.ts
- FOUND: .planning/phases/10-tenant-isolation-trust-boundaries/10-02-SUMMARY.md
- FOUND commit: f72420f
- FOUND commit: f8fde0f
