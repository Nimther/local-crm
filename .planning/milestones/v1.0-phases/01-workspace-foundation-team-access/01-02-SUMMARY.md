---
phase: 01-workspace-foundation-team-access
plan: 02
subsystem: ui
tags: [react, vite, tanstack-query, better-auth, shadcn, playwright, react-hook-form, zod]

# Dependency graph
requires:
  - phase: 01-workspace-foundation-team-access (plan 01)
    provides: "Fastify API with better-auth org backbone, Drizzle schema + RLS, POST/GET /api/workspaces"
provides:
  - "Vite/React 19 SPA (apps/web) with shadcn new-york/neutral component set"
  - "better-auth React client (organization plugin) + TanStack Query wiring, credentials: include throughout"
  - "Register/login pages with shared zod schemas and UI-SPEC copy"
  - "Create-workspace onboarding, AppShell, WorkspaceSwitcher, WorkspaceHome, extensible OnboardingChecklist"
  - "Playwright happy-path e2e proving register -> create workspace -> Owner at /w/{slug}"
affects: [01-03, 01-04, 01-05, phase-02-frontend-consumers]

# Tech tracking
tech-stack:
  added: [vite@8, "@vitejs/plugin-react", react@19.2, react-router@8, "@tanstack/react-query@5.101", zustand@5, react-hook-form@7.80, "@hookform/resolvers", better-auth (React client + organization plugin), shadcn (new-york/neutral, hand-authored components), "@playwright/test@1.61", tailwindcss]
  patterns:
    - "Shared zod schemas in packages/shared-schemas consumed by both frontend forms and backend validation"
    - "Data-driven onboarding checklist (typed item array) instead of inline per-item JSX, so later phases append entries"
    - "Active workspace resolved from the URL slug (/w/:slug), not client-side session state"
    - "All API calls go through lib/api.ts fetch wrapper with credentials: 'include'; no token/session ever touches localStorage/sessionStorage"

key-files:
  created:
    - apps/web/src/main.tsx
    - apps/web/src/App.tsx
    - apps/web/src/lib/queryClient.ts
    - apps/web/src/lib/authClient.ts
    - apps/web/src/lib/api.ts
    - apps/web/src/routes/register.tsx
    - apps/web/src/routes/login.tsx
    - apps/web/src/routes/create-workspace.tsx
    - apps/web/src/features/app-shell/AppShell.tsx
    - apps/web/src/features/workspace-switcher/WorkspaceSwitcher.tsx
    - apps/web/src/features/workspace-home/WorkspaceHome.tsx
    - apps/web/src/features/onboarding/OnboardingChecklist.tsx
    - apps/web/e2e/register-create-workspace.spec.ts
    - packages/shared-schemas/src/auth.ts
  modified:
    - apps/api/src/modules/tenancy/workspaces.ts
    - apps/api/package.json
    - package.json (root dev script)
    - .planning/phases/01-workspace-foundation-team-access/01-UI-SPEC.md (shadcn_initialized: true)

key-decisions:
  - "GET/POST /api/workspaces extended to return `role` in the response (deviation from 01-01's shape) because WorkspaceHome's live-Owner-role requirement depends on it"
  - "authClient baseURL resolved from window.location.origin at runtime (better-auth's client rejects a bare relative path)"
  - "Root npm run dev fixed to run API + web concurrently, matching SKELETON.md's documented local-run contract"

requirements-completed: [TENANT-01, TENANT-05]

coverage:
  - id: D1
    description: "Visitor can register at /register and is signed in on success, routed to /create-workspace"
    requirement: "TENANT-01"
    verification:
      - kind: e2e
        ref: "apps/web/e2e/register-create-workspace.spec.ts"
        status: pass
      - kind: manual_procedural
        ref: "Task 4 checkpoint: human verified register -> create-workspace redirect in browser"
        status: pass
    human_judgment: false
  - id: D2
    description: "Creating a workspace navigates to /w/{slug}; workspace home renders live server data (name + Owner role) via TanStack Query"
    requirement: "TENANT-01"
    verification:
      - kind: e2e
        ref: "apps/web/e2e/register-create-workspace.spec.ts"
        status: pass
      - kind: manual_procedural
        ref: "Task 4 checkpoint: human verified /w/acme shows Acme + Owner (Владелец) badge"
        status: pass
    human_judgment: false
  - id: D3
    description: "App shell shows a workspace switcher listing the user's workspaces with the active one highlighted, plus a 'Создать воркспейс' item"
    requirement: "TENANT-05"
    verification:
      - kind: manual_procedural
        ref: "Task 4 checkpoint: human confirmed switcher shows Acme active (indigo accent) and 'Создать воркспейс' item"
        status: pass
    human_judgment: false
  - id: D4
    description: "Onboarding checklist renders extensible items (SendGrid, invite team) with per-item done/pending state, data-driven"
    requirement: "TENANT-05"
    verification:
      - kind: manual_procedural
        ref: "Task 4 checkpoint: human confirmed checklist shows both items pending under 'Настройте воркспейс'"
        status: pass
    human_judgment: false
  - id: D5
    description: "Every mutating button shows a disabled + loading state during its request (no double-submit)"
    verification:
      - kind: manual_procedural
        ref: "Task 4 checkpoint: human visual pass confirmed loading/disabled state on create button"
        status: pass
    human_judgment: false

duration: 25min
completed: 2026-07-03
status: complete
---

# Phase 1 Plan 2: Walking-Skeleton UI Summary

**React 19/Vite SPA with shadcn new-york/neutral components, better-auth-wired register/login, and a create-workspace onboarding flow that puts a real signed-in user at /w/{slug} seeing themselves as Owner from live server data — proven by a Playwright happy-path and human-verified in browser.**

## Performance

- **Duration:** 25 min
- **Started:** 2026-07-03T09:37:00Z (approx, from first task commit timestamp)
- **Completed:** 2026-07-03T10:02:00Z (approx, checkpoint approval)
- **Tasks:** 4 (3 auto + 1 human-verify checkpoint)
- **Files modified:** 41+ (scaffold + shadcn component set + feature code)

## Accomplishments
- Vite/React 19 SPA scaffolded with shadcn new-york/neutral component set (hand-authored against the official registry source), TanStack Query, better-auth React client with the organization plugin, and a fetch wrapper that always sends `credentials: 'include'`
- Register and login pages built with react-hook-form + zod resolver, sharing `registerSchema`/`loginSchema` from `packages/shared-schemas`, with UI-SPEC-exact Russian error copy
- Create-workspace onboarding, AppShell, WorkspaceSwitcher (active-workspace highlighting + "Создать воркспейс"), WorkspaceHome (live name + Owner role via `useQuery`), and a data-driven, extensible OnboardingChecklist
- Playwright happy-path (`register -> create workspace -> Owner at /w/{slug}`) authored RED in Task 1, made GREEN in Task 3
- Human verification checkpoint (Task 4) approved: the full flow, switcher, and checklist all confirmed against the UI-SPEC in a real browser with no issues raised

## Task Commits

Each task was committed atomically:

1. **Task 1: Failing Playwright happy-path + Vite/React/shadcn scaffold** - `cec5281` (test)
2. **Task 2: Auth pages (register/login) wired to better-auth** - `d1113f1` (feat)
3. **Task 3: Create-workspace onboarding + app shell + switcher + home + checklist** - `5bfe731` (feat), plus follow-up fix `5f6aaf7` (fix: root dev script)
4. **Task 4: Human verification checkpoint** - approved by user, no code changes; no new commit (verification only)

**Plan metadata:** (this commit) `docs(01-02): complete walking-skeleton UI plan`

_Note: Tasks 2 and 3 are TDD-flagged in the plan; both landed as single feat commits after the shared Task 1 RED test turned GREEN in Task 3 — there was no separate per-task RED/GREEN split beyond the plan-level Task 1 -> Task 3 gate._

## Files Created/Modified
- `apps/web/src/main.tsx`, `apps/web/src/App.tsx` - app bootstrap and router (register/login/create-workspace/`/w/:slug` routes)
- `apps/web/src/lib/queryClient.ts` - TanStack Query client
- `apps/web/src/lib/authClient.ts` - better-auth `createAuthClient` + organization plugin, runtime-resolved baseURL
- `apps/web/src/lib/api.ts` - fetch wrapper, `credentials: 'include'` always set
- `apps/web/src/routes/register.tsx`, `apps/web/src/routes/login.tsx` - auth cards wired to better-auth, shared zod schemas, UI-SPEC error copy
- `apps/web/src/routes/create-workspace.tsx` - POSTs `/api/workspaces`, invalidates workspaces query, navigates to `/w/{slug}`
- `apps/web/src/features/app-shell/AppShell.tsx` - shell wrapping `/w/:slug` routes, active workspace from URL
- `apps/web/src/features/workspace-switcher/WorkspaceSwitcher.tsx` - dropdown-menu switcher, active highlight, create-workspace item
- `apps/web/src/features/workspace-home/WorkspaceHome.tsx` - live workspace name + role via `useQuery`
- `apps/web/src/features/onboarding/OnboardingChecklist.tsx` - data-driven checklist (SendGrid, invite team), both pending by design until 01-05
- `apps/web/e2e/register-create-workspace.spec.ts`, `apps/web/playwright.config.ts` - Playwright happy-path + full-stack webServer config
- `packages/shared-schemas/src/auth.ts` - `registerSchema`/`loginSchema`
- `apps/api/src/modules/tenancy/workspaces.ts` - extended to return `role` in POST/GET responses
- `apps/api/package.json` - dev script loads `.env` via tsx `--env-file` so Playwright's webServer can boot the API
- `package.json` (root) - `dev` script now runs API + web concurrently
- `.planning/phases/01-workspace-foundation-team-access/01-UI-SPEC.md` - `shadcn_initialized: true`

## Decisions Made
- Extended `/api/workspaces` POST/GET to return `role` in the response body — 01-01's original shape omitted it, but WorkspaceHome's must-have (live Owner role, not hardcoded) depends on the server actually returning it (Rule 3, blocking).
- `authClient`'s `baseURL` is resolved from `window.location.origin` at runtime, since better-auth's client rejects a bare relative path.
- Root `npm run dev` fixed to run API + web concurrently, matching what SKELETON.md and the Task 4 checkpoint's how-to-verify steps assume.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] API dev script needed `.env` loading for Playwright's webServer**
- **Found during:** Task 1 (Playwright config + scaffold)
- **Issue:** `apps/api/package.json`'s dev script didn't load `../../.env`, so `env.ts` threw a `ZodError` on missing `DATABASE_URL` when Playwright's `webServer` tried to boot the API headlessly
- **Fix:** API dev script now loads `.env` via tsx's `--env-file`
- **Files modified:** `apps/api/package.json`
- **Verification:** Playwright's webServer boots the API successfully
- **Committed in:** `cec5281` (Task 1 commit)

**2. [Rule 3 - Blocking] `/api/workspaces` didn't return `role`**
- **Found during:** Task 3 (WorkspaceHome + AppShell)
- **Issue:** 01-01's POST/GET `/api/workspaces` response shape omitted `role`, but the must-have "workspace home renders live server data... role = Owner" requires the server to supply it
- **Fix:** Extended both endpoints to return `role` via better-auth's `getActiveMemberRole` / the known `creatorRole=owner` default
- **Files modified:** `apps/api/src/modules/tenancy/workspaces.ts`, `apps/api/src/modules/tenancy/__tests__/workspace-creation.test.ts`
- **Verification:** Playwright happy-path asserts and confirms the Owner label from live data
- **Committed in:** `5bfe731` (Task 3 commit)

**3. [Rule 3 - Blocking] Root `npm run dev` only started the API, not the web app**
- **Found during:** Pre-Task-4 (preparing the manual verification checkpoint)
- **Issue:** SKELETON.md's documented local run ("`npm run dev` at root runs API + web concurrently") didn't match the actual root script; the Task 4 checkpoint's how-to-verify steps assume this exact command
- **Fix:** Updated root `package.json` dev script to run API + web concurrently
- **Files modified:** `package.json`, `package-lock.json`
- **Verification:** `npm run dev` at root starts both processes; checkpoint verification proceeded successfully
- **Committed in:** `5f6aaf7`

---

**Total deviations:** 3 auto-fixed (all Rule 3 - blocking)
**Impact on plan:** All three were necessary to make the plan's own verification (Playwright e2e, and the Task 4 manual checkpoint) actually runnable. No scope creep beyond what the plan's must-haves required.

## Issues Encountered
None beyond the deviations documented above.

## User Setup Required
None - no external service configuration required for this plan (SendGrid connection setup is deferred to a later phase per the onboarding checklist's pending state).

## Checkpoint Resolution

Task 4 (`checkpoint:human-verify`, gate: blocking) was reached after Tasks 1-3 landed green. The user ran the full stack (`docker compose up -d db` + `npm run dev` at root), walked through register -> create workspace "Acme" -> `/w/acme` showing the Owner (Владелец) badge, confirmed the workspace switcher highlights Acme as active with a "Создать воркспейс" item, confirmed the onboarding checklist shows both items pending under "Настройте воркспейс", and did a visual pass against the UI-SPEC (single indigo primary CTA, Russian sentence-case copy, no arbitrary spacing, loading/disabled state on the create button). The user responded "approved" with no issues raised.

## Next Phase Readiness
- The Walking Skeleton (01-01 backend + 01-02 frontend) is complete and clickable end-to-end: a real user can register, create a workspace, and see themselves as Owner at `/w/{slug}`.
- App shell, workspace switcher, and the extensible onboarding checklist are established conventions for 01-03 (invites/team), 01-04, and 01-05 (SendGrid connection, which will flip the first checklist item to done).
- No blockers carried forward from this plan.

---
*Phase: 01-workspace-foundation-team-access*
*Completed: 2026-07-03*
