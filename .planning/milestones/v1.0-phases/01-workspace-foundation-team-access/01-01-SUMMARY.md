---
phase: 01-workspace-foundation-team-access
plan: 01
subsystem: auth
tags: [fastify, better-auth, drizzle, postgres, rls, tenant-isolation, vitest, npm-workspaces]

# Dependency graph
requires: []
provides:
  - npm-workspaces monorepo scaffold (apps/*, packages/*) with root scripts, tsconfig.base.json, docker-compose Postgres service + non-superuser role init SQL
  - Drizzle schema for better-auth core + organization plugin tables, plus workspace_sendgrid_keys domain table
  - Row-Level Security enforced (ENABLE + FORCE) on workspace_sendgrid_keys via a workspace_isolation policy
  - AsyncLocalStorage + SET LOCAL tenant-context pattern (withTenant/withTenantTransaction/getWorkspaceId), chaos-tested under a killed pooled connection
  - better-auth organization plugin wired as auth + workspace + Owner/Admin/Member backbone, with a full createAccessControl statement (sendgridKey/campaign/flow)
  - POST /api/workspaces + GET /api/workspaces/:slug, with unique-slug collision retry
  - Pino structured logging with sendgridKey/apiKey/password/token redaction
affects: [01-02, 01-03, 01-04, 01-05, phase-2, phase-3, phase-4, phase-5, phase-6, phase-7]

# Tech tracking
tech-stack:
  added: [fastify@5.9.0, "@fastify/type-provider-zod@1.0.0", zod@4.4.3, better-auth@1.6.23, drizzle-orm@0.45.2, drizzle-kit@0.31.10, pg@8.22.0, nanoid@5.1.16, pino@10.3.1, pino-http@11.0.0, "@fastify/cors@11.2.0", "@fastify/helmet@13.0.2", "@fastify/rate-limit@11.1.0", vitest@4.1.9, tsx, typescript@5.9.3]
  patterns:
    - "AsyncLocalStorage + SET LOCAL tenant context (never module-level state, never plain SET)"
    - "Postgres RLS with FORCE ROW LEVEL SECURITY (required when the app role owns its own tables)"
    - "better-auth organization plugin as workspace/role/invite backbone instead of hand-rolled tables"
    - "Two separate DB clients: @mega-crm/db's Drizzle client for better-auth's own tables (no RLS), apps/api's raw pg Pool for tenant-scoped RLS queries"
    - "better-auth's Fastify handler mounted in its own encapsulated content-type-parser scope so the raw body reaches it unparsed"

key-files:
  created:
    - package.json (root npm workspaces)
    - docker-compose.yml + docker/init-app-role.sql
    - packages/db/src/schema/auth.ts (better-auth core + organization tables, uuid PKs)
    - packages/db/src/schema/sendgrid-keys.ts (workspaceSendgridKeys)
    - packages/db/migrations/0000_init_auth.sql (drizzle-kit generate)
    - packages/db/migrations/0001_rls_policies.sql (hand-authored RLS)
    - apps/api/src/middleware/tenant-context.ts
    - apps/api/src/middleware/role-guard.ts
    - apps/api/src/modules/auth/{auth,access-control,plugin}.ts
    - apps/api/src/modules/tenancy/{workspaces,sendgrid-key.repository}.ts
    - apps/api/src/{env,logger,db,server}.ts
    - apps/api/src/test/db-fixture.ts
    - apps/api/src/modules/tenancy/__tests__/workspace-creation.test.ts
    - apps/api/src/db/__tests__/rls-pooling-chaos.test.ts
  modified: []

key-decisions:
  - "IDs across better-auth's schema are native Postgres uuid (gen_random_uuid() default) with advanced.database.generateId:false, so workspace_id always matches the ::uuid cast every RLS policy uses"
  - "FORCE ROW LEVEL SECURITY added on workspace_sendgrid_keys — the app DB role both owns and queries its tables, and Postgres RLS silently exempts the table owner without FORCE"
  - "better-auth's own tables (user/session/account/verification/organization/member/invitation) are deliberately outside RLS — scoped by session/active-organization membership instead, per SKELETON.md"

patterns-established:
  - "Every future tenant-scoped table must get ENABLE + FORCE ROW LEVEL SECURITY + a workspace_isolation policy in the same migration that creates it"
  - "requirePermission(resource, action) as the server-side role-guard, backed by better-auth's createAccessControl — never client-side-only gating"

requirements-completed: [TENANT-01, TENANT-05]

coverage:
  - id: D1
    description: "A new user can register (email/password) and create a workspace over HTTP, becoming its Owner with a unique slug"
    requirement: "TENANT-01"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/tenancy/__tests__/workspace-creation.test.ts#creates a workspace with a unique slug and an owner membership for the creator"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/tenancy/__tests__/workspace-creation.test.ts#generates distinct slugs for two workspaces created with the same name"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/tenancy/__tests__/workspace-creation.test.ts#rejects a non-member from reading the workspace (403 or 404)"
        status: pass
      - kind: manual_procedural
        ref: "curl smoke test: POST /api/auth/sign-up/email -> POST /api/workspaces -> GET /api/workspaces/:slug, cross-checked against the member table's role=owner row"
        status: pass
    human_judgment: false
  - id: D2
    description: "Cross-tenant data isolation on workspace_sendgrid_keys holds even after a pooled connection is killed mid-transaction and reused by another workspace's request"
    requirement: "TENANT-05"
    verification:
      - kind: integration
        ref: "apps/api/src/db/__tests__/rls-pooling-chaos.test.ts#never leaks workspace A's row into workspace B's context, including after a killed pooled connection"
        status: pass
      - kind: integration
        ref: "apps/api/src/db/__tests__/rls-pooling-chaos.test.ts#throws when no tenant context is set for a tenant-scoped transaction"
        status: pass
    human_judgment: false
  - id: D3
    description: "Schema + RLS migrations are applied to the live database with zero pending migrations"
    verification:
      - kind: other
        ref: "npx drizzle-kit migrate (packages/db) against local Postgres 17 — 'migrations applied successfully', re-run shows nothing pending"
        status: pass
      - kind: other
        ref: "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname='workspace_sendgrid_keys' -> t, t"
        status: pass
    human_judgment: false

# Metrics
duration: 45min
completed: 2026-07-03
status: complete
---

# Phase 1 Plan 1: Walking-Skeleton Backend Summary

**npm-workspaces monorepo with Fastify + better-auth (organization plugin) + Drizzle/Postgres under Row-Level Security, proven end-to-end by an HTTP integration test and an RLS pooled-connection chaos test.**

## Performance

- **Duration:** ~45 min
- **Started:** 2026-07-03T13:57:00+05:00 (approx, first scaffold file)
- **Completed:** 2026-07-03T14:21:00+05:00
- **Tasks:** 3 (all `type="auto"`, no checkpoints)
- **Files modified:** 37

## Accomplishments
- Register → create workspace → Owner works over real HTTP (better-auth email/password sign-up + POST /api/workspaces), verified both by `vitest`'s `app.inject()` integration test and a manual `curl` smoke test against a running `tsx` dev server, cross-checked against the `member` table's `role='owner'` row.
- Postgres Row-Level Security genuinely enforced on `workspace_sendgrid_keys`, proven by a chaos test that kills a pooled connection mid-transaction (`pg_terminate_backend`) and confirms the next tenant's transaction on a recycled pool connection sees zero cross-tenant rows.
- `AsyncLocalStorage` + `SET LOCAL app.current_workspace_id` tenant-context pattern (`withTenant`/`withTenantTransaction`/`getWorkspaceId`) is the seed pattern every later domain table (contacts, events, segments, campaigns, flows) will reuse.
- better-auth's `organization` plugin is the workspace/role/invite backbone (no hand-rolled memberships table), with the full `createAccessControl` statement (`sendgridKey`/`campaign`/`flow`) already defined for 01-05/Phase 4/Phase 6 to reference.
- Schema + RLS migrations generated (`drizzle-kit generate`) and applied (`drizzle-kit migrate`) to the live local Postgres 17 database, zero pending afterward.

## Task Commits

Each task was committed atomically:

1. **Task 1: Failing integration + RLS-pooling chaos tests and Wave-0 test infrastructure** - `0445177` (test)
2. **Task 2: Monorepo scaffold + Drizzle schema/RLS + better-auth backbone + tenant context + workspace-creation API** - `ac8d52d` (feat)
3. **Task 3: Apply schema + RLS to the live database and prove the skeleton green** - `f150c41` (feat)

_No TDD RED/GREEN/REFACTOR split beyond Task 1 (RED, plan-level) → Task 2 (GREEN implementation) → Task 3 (migration gate); Task 2 was itself `tdd="true"` at the plan-task level, satisfied by Task 1's pre-existing failing tests turning green after Task 3's migration apply._

## Files Created/Modified

- `package.json`, `tsconfig.base.json`, `.gitignore`, `.env.example`, `docker-compose.yml`, `docker/init-app-role.sql` — monorepo scaffold, root scripts, non-superuser Postgres role documentation
- `packages/db/src/schema/auth.ts` — better-auth core + organization plugin schema (uuid PKs, `deletedAt` additionalField for 01-04's soft-delete)
- `packages/db/src/schema/sendgrid-keys.ts` — `workspaceSendgridKeys` domain table
- `packages/db/migrations/0000_init_auth.sql` — drizzle-kit generated table migration
- `packages/db/migrations/0001_rls_policies.sql` — hand-authored `ENABLE`/`FORCE ROW LEVEL SECURITY` + `workspace_isolation` policy
- `packages/db/src/index.ts` — Drizzle client for better-auth's own tables
- `packages/shared-schemas/src/workspace.ts` — Zod schemas shared between API and (01-02's) UI
- `apps/api/src/middleware/tenant-context.ts` — `withTenant`/`withTenantTransaction`/`getWorkspaceId`
- `apps/api/src/middleware/role-guard.ts` — `requirePermission(resource, action)`
- `apps/api/src/modules/auth/{auth,access-control,plugin}.ts` — better-auth config, access-control statement, Fastify mounting
- `apps/api/src/modules/tenancy/{workspaces,sendgrid-key.repository}.ts` — workspace routes, tenant-scoped SendGrid-key CRUD
- `apps/api/src/{env,logger,db,server}.ts` — Zod env validation, Pino redaction, tenant-scoped pg Pool, Fastify assembly
- `apps/api/src/test/db-fixture.ts`, `apps/api/vitest.config.ts` — test DB migration runner, non-watch vitest config
- `apps/api/src/modules/tenancy/__tests__/workspace-creation.test.ts`, `apps/api/src/db/__tests__/rls-pooling-chaos.test.ts` — TENANT-01/TENANT-05 tests

## Decisions Made

- IDs across better-auth's schema are native Postgres `uuid` (`gen_random_uuid()` default) with `advanced.database.generateId: false`, so `workspace_id` always matches the `::uuid` cast every RLS policy uses — avoids a text-vs-uuid type mismatch that better-auth's default nanoid IDs would have caused.
- `FORCE ROW LEVEL SECURITY` added on `workspace_sendgrid_keys` (see Deviations) — required because the single non-superuser app role both owns and queries its own tables.
- better-auth's own tables are deliberately left outside RLS (SKELETON.md "Out of Scope") — scoped by session/active-organization membership instead; only domain tables (starting with `workspace_sendgrid_keys`) get RLS policies.
- Hand-authored the better-auth Drizzle schema (core + organization plugin tables) rather than using the `@better-auth/cli generate` command — that CLI package's published versions (up to 1.5.0-beta.13) trail the installed `better-auth@1.6.23`, and better-auth's core/organization schema shape is stable and well-documented enough to hand-author reliably without risking a version-mismatched codegen tool.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `FORCE ROW LEVEL SECURITY` required for the RLS policy to actually apply**
- **Found during:** Task 3 (running the chaos test against the live-migrated database)
- **Issue:** Postgres does not apply RLS policies to a table's own OWNER by default — only to other roles. This project's single non-superuser app role (`mega_crm_app`) both owns `workspace_sendgrid_keys` (it ran the migrations) and queries it (the app connects as the same role), so the `workspace_isolation` policy was silently bypassed: the chaos test's `rows.every(r => r.workspace_id === workspaceBId)` assertion failed because workspace A's row was still visible under workspace B's tenant context.
- **Fix:** Added `ALTER TABLE workspace_sendgrid_keys FORCE ROW LEVEL SECURITY;` to `0001_rls_policies.sql`, applied directly to both the dev and test databases, and updated the dev database's `drizzle.__drizzle_migrations` tracking hash to match the corrected file content (so a future clean `drizzle-kit migrate` applies the exact same, already-corrected SQL).
- **Files modified:** `packages/db/migrations/0001_rls_policies.sql`
- **Verification:** `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname='workspace_sendgrid_keys'` → `t, t`; chaos test now passes.
- **Committed in:** `f150c41`

**2. [Rule 1 - Bug] `vitest run` (no path filter) silently double-ran every test via `tsc`'s `dist/**` output**
- **Found during:** Task 3 (running the plan's overall verification, `npx vitest run` with no arguments)
- **Issue:** `npm run build` emits `apps/api/dist/**/*.test.js` (compiled mirrors of `src/**/*.test.ts`). Vitest's default file glob picked up both the source `.test.ts` and the compiled `.test.js`, running every test twice (2 files/5 tests became 4 files/10 tests) and exposing timing races that didn't surface under the path-filtered command.
- **Fix:** Added `exclude: [...configDefaults.exclude, "dist/**"]` to `apps/api/vitest.config.ts`.
- **Files modified:** `apps/api/vitest.config.ts`
- **Verification:** `npx vitest run` (no filter) now reports 2 files / 5 tests, exit 0.
- **Committed in:** `f150c41`

**3. [Rule 1 - Bug] Chaos test's intentional connection-kill surfaced as an unhandled process exception**
- **Found during:** Task 3 (running the RLS chaos test)
- **Issue:** `pg_terminate_backend` on the deliberately-killed pooled connection caused an asynchronous `error` event that, despite a per-client listener, still occasionally surfaced as an uncaught exception (Vitest's process-level exit code went to 1 even though all assertions passed) — a timing race between the server-initiated termination and the listener/test-teardown sequencing.
- **Fix:** Added a pool-level `pool.on("error", ...)` safety net (in addition to the existing per-client listener) and a short `setTimeout` after `pg_terminate_backend` before releasing the doomed client, giving the async termination event time to fire and be swallowed deterministically.
- **Files modified:** `apps/api/src/db/__tests__/rls-pooling-chaos.test.ts`
- **Verification:** Repeated `npx vitest run` invocations (filtered and unfiltered) now consistently exit 0.
- **Committed in:** `f150c41`

**4. [Rule 3 - Blocking] `hasPermission` body key is `permissions`, not `permission`, for a generic `Record<string, string[]>`**
- **Found during:** Task 2 (`npm run build -w apps/api`)
- **Issue:** `tsc` reported the `permission` field of `auth.api.hasPermission`'s body as not matching our generic `Record<string, string[]>` value — TypeScript resolved only the `permissions` branch of the underlying `ZodXor` union against our looser type.
- **Fix:** Changed `role-guard.ts` to pass `{ permissions: { [resource]: [action] } }`.
- **Files modified:** `apps/api/src/middleware/role-guard.ts`
- **Committed in:** `ac8d52d`

**5. [Rule 3 - Blocking] Test file's `FastifyInstance` type import incompatible with `buildServer()`'s concrete return type**
- **Found during:** Task 2 (`npm run build -w apps/api`)
- **Issue:** Passing a pre-configured Pino instance via Fastify's `loggerInstance` option causes the app's inferred logger generic to diverge from the generic `FastifyBaseLogger` default, making the generic `FastifyInstance` import in the test incompatible with the actual `buildServer()` return type.
- **Fix:** Changed the test's `app` variable type to `Awaited<ReturnType<typeof buildServer>>` instead of importing `FastifyInstance` from `fastify`.
- **Files modified:** `apps/api/src/modules/tenancy/__tests__/workspace-creation.test.ts`
- **Committed in:** `ac8d52d`

---

**Total deviations:** 5 auto-fixed (3 × Rule 1 bug fixes, 2 × Rule 3 blocking-issue fixes).
**Impact on plan:** All fixes were necessary for correctness (RLS enforcement — the single highest-leverage guarantee in this phase) or to unblock the build/test pipeline. No scope creep; no architectural changes (Rule 4 not triggered).

## Issues Encountered

- Docker was not available on this machine (per 01-RESEARCH.md Environment Availability), so `docker-compose.yml` + `docker/init-app-role.sql` were authored per the plan but not exercised directly — instead, the local Postgres 17.10 (Homebrew) install was used, with a `mega_crm_app` role and `mega_crm`/`mega_crm_test` databases created manually via `psql` to match exactly what the docker-compose init script does. Both paths converge on the same non-superuser-role invariant.
- `@better-auth/cli`'s published versions (up to 1.5.0-beta.13) trail the installed `better-auth@1.6.23` — rather than risk a version-mismatched codegen tool, the better-auth Drizzle schema (core + organization plugin tables) was hand-authored directly against the well-documented, stable better-auth schema shape (see Decisions).

## User Setup Required

None for this plan specifically — the two `user_setup` items in the plan frontmatter (`DATABASE_URL`, `BETTER_AUTH_SECRET`) were provisioned directly by the executor for local dev/test (Postgres role/databases created; `.env` populated with a generated dev secret) since this is a local-only environment with no external service dependency. Before any other developer or CI environment runs this phase, they must:
1. Run `docker compose up db` (applies `docker/init-app-role.sql` automatically), OR create the `mega_crm_app` non-superuser role + `mega_crm`/`mega_crm_test` databases manually per `.env.example`'s comment.
2. Copy `.env.example` to `.env` and generate a real `BETTER_AUTH_SECRET` via `openssl rand -base64 32`.

## Next Phase Readiness

- The tenant-context pattern, access-control statement, and schema are stable and ready for 01-02 (walking-skeleton UI) to consume immediately: `POST /api/workspaces`, `GET /api/workspaces/:slug`, and better-auth's `/api/auth/*` routes are live and tested.
- 01-05 (SendGrid key connect) can build directly on `sendgrid-key.repository.ts`'s `upsertKey`/`getKey` — already tenant-scoped and RLS-proven.
- No blockers. One forward note for 01-04: `organization.deletedAt` additionalField is present in the schema now but not yet wired into any query filter (soft-delete read-exclusion is 01-04's responsibility, not this plan's).

## Self-Check: PASSED

All 23 created files verified present on disk; all 3 task commits (`0445177`, `ac8d52d`, `f150c41`) verified present in git history.

---
*Phase: 01-workspace-foundation-team-access*
*Completed: 2026-07-03*
