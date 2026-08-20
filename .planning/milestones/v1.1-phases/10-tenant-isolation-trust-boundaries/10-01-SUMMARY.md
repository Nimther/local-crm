---
phase: 10-tenant-isolation-trust-boundaries
plan: 01
subsystem: database
tags: [postgres, rls, tenant-isolation, bullmq, worker, drizzle]

requires:
  - phase: 09-partition-automation-boundary-safety
    provides: "SET LOCAL app.admin_scan precedent in attachPartitionCheckFirst (deviation 09-04) -- a sixth GUC touchpoint this phase's later plans must also migrate"
  - phase: 08-quality-gates-failure-injection-foundation
    provides: "packages/test-support ephemeral DB provisioning (createEphemeralDatabase, global-setup.ts) that this plan extends with real cluster-role separation"
provides:
  - "mega_crm_scan least-privilege Postgres login role (NOBYPASSRLS, owns no tables)"
  - "mega_crm_auth login role created (not yet granted -- later plan wires it)"
  - "withCrossWorkspaceScan shared helper in packages/tenant-context/src/scan.ts"
  - "Migration 0041: role-scoped campaigns_scan policy + workspace_isolation TO mega_crm_app scoping"
  - "campaign-scheduler.worker.ts migrated off the app.admin_scan session GUC"
  - "scripts/ensure-db-roles.mjs + npm run db:roles for existing-volume role bootstrap"
  - "P3 structural proof: apps/api/src/env.ts declares no scan DSN, no apps/api/src file imports withCrossWorkspaceScan"
  - "ARCHITECTURE.md §7 SEC-01 connection-shape ADR"
affects: [11-delivery-correctness, 12-worker-reliability, phase-10-remaining-plans]

tech-stack:
  added: []
  patterns:
    - "Dedicated least-privilege login role + separate lazily-constructed pool for cross-tenant reads, instead of a session GUC on the shared tenant pool"
    - "Every RLS policy touched by a second role must carry an explicit TO clause -- unscoped policies are evaluated (and can error) for every role's queries once a second role exists"
    - "Cluster-level role creation lives outside the migration chain (docker/init-app-role.sql + an idempotent bootstrap script), never in a numbered migration, because the migration-applying role is NOCREATEROLE"

key-files:
  created:
    - packages/tenant-context/src/scan.ts
    - packages/tenant-context/src/__tests__/scan.test.ts
    - packages/db/migrations/0041_scan_role_bootstrap.sql
    - scripts/ensure-db-roles.mjs
    - apps/worker/src/queues/__tests__/campaign-scheduler-scan.test.ts
  modified:
    - docker/init-app-role.sql
    - package.json
    - packages/test-support/src/provision-db.ts
    - packages/test-support/src/db-fixture.ts
    - packages/test-support/src/global-setup.ts
    - packages/test-support/src/index.ts
    - packages/tenant-context/src/index.ts
    - packages/db/migrations/meta/_journal.json
    - apps/worker/src/queues/campaign-scheduler.worker.ts
    - apps/worker/src/server.ts
    - apps/api/src/__tests__/env-schema.test.ts
    - scripts/check-env.mjs
    - ARCHITECTURE.md
    - SPECIFICATION.md

key-decisions:
  - "D-01 (locked in CONTEXT.md): separate pool + dedicated mega_crm_scan login credential, worker-env-only DSN -- SET LOCAL ROLE was rejected because it requires GRANT mega_crm_scan TO mega_crm_app, making P3 unsatisfiable"
  - "D-02 (locked): one shared withCrossWorkspaceScan entry point in packages/tenant-context, mirroring withTenantTransaction's BEGIN/COMMIT/ROLLBACK discipline"
  - "D-03 (locked): role-scoped policies replace GUC-gated ones, predicate narrowing preserved verbatim, not dropped"

patterns-established:
  - "withCrossWorkspaceScan: the one audited entry point for cross-workspace reads, lazily pooled from a worker-only env var, no session GUC"
  - "Role-scoped RLS policy with explicit TO clause on both the new scan policy and the existing app-role policy it coexists with"

requirements-completed: [SEC-01, SEC-02]

coverage:
  - id: D1
    description: "mega_crm_scan role created (NOBYPASSRLS, owns no tables, not a member relationship of mega_crm_app) and campaign-scheduler's due-campaign discovery reads across two workspaces in one query via withCrossWorkspaceScan"
    requirement: "SEC-01"
    verification:
      - kind: integration
        ref: "packages/tenant-context/src/__tests__/scan.test.ts#Test 1: reads due campaigns from two DIFFERENT workspaces in a single scan-pool query"
        status: pass
      - kind: integration
        ref: "packages/tenant-context/src/__tests__/scan.test.ts#Test 2: mega_crm_scan is a login role that cannot bypass RLS"
        status: pass
      - kind: integration
        ref: "packages/tenant-context/src/__tests__/scan.test.ts#Test 3: mega_crm_scan and mega_crm_auth own zero tables"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/campaign-scheduler-scan.test.ts#discovers due campaigns across two workspaces and transitions each via the unchanged per-tenant path"
        status: pass
    human_judgment: false
  - id: D2
    description: "API process structurally cannot reach the scan role -- no credential in its env schema, no membership in the role, no import of the helper"
    requirement: "SEC-02"
    verification:
      - kind: integration
        ref: "packages/tenant-context/src/__tests__/scan.test.ts#Test 4: mega_crm_app is not a member of mega_crm_scan or mega_crm_auth (P3)"
        status: pass
      - kind: unit
        ref: "apps/api/src/__tests__/env-schema.test.ts#P3 -- apps/api holds no scan-role credential or entry point > apps/api/src/env.ts does not reference SCAN_DATABASE_URL"
        status: pass
      - kind: unit
        ref: "apps/api/src/__tests__/env-schema.test.ts#P3 -- apps/api holds no scan-role credential or entry point > no file under apps/api/src (outside __tests__) imports withCrossWorkspaceScan"
        status: pass
      - kind: unit
        ref: "apps/worker/src/server.ts buildWorker() boot check -- verified manually: throws without SCAN_DATABASE_URL"
        status: pass
    human_judgment: false

duration: 65min
completed: 2026-08-07
status: complete
---

# Phase 10 Plan 01: mega_crm_scan role + withCrossWorkspaceScan tracer slice Summary

**A dedicated least-privilege Postgres login role (`mega_crm_scan`, NOBYPASSRLS, owns no tables) replaces the `app.admin_scan` session GUC for campaign-scheduler's cross-workspace discovery, reached through one shared `withCrossWorkspaceScan` helper, with a structural (source-level) proof that `apps/api` can never hold or use the credential.**

## Performance

- **Duration:** ~65 min
- **Tasks:** 3/3 completed
- **Files modified:** 19 (14 created/modified in Task 1, 3 in Task 2, 5 in Task 3, with overlap)

## Accomplishments

- Two new cluster-level login roles (`mega_crm_scan`, `mega_crm_auth`) bootstrapped both for fresh Postgres volumes (`docker/init-app-role.sql`) and existing ones (`scripts/ensure-db-roles.mjs`, wired into `predev` and into `packages/test-support`'s ephemeral-DB provisioning).
- `withCrossWorkspaceScan` (`packages/tenant-context/src/scan.ts`) — the single audited cross-tenant read entry point, mirroring `withTenantTransaction`'s transaction discipline, with a lazily-constructed pool so importing the package from `apps/api` constructs nothing.
- Migration `0041_scan_role_bootstrap.sql`: grants + a role-scoped `campaigns_scan` policy (predicate preserved verbatim from the GUC-gated `0018` policy it functionally replaces) + `TO mega_crm_app` scoping on campaigns' `workspace_isolation` policy (required now, per RESEARCH.md Pitfall 2, not deferrable).
- `campaign-scheduler.worker.ts`'s `findDueCampaignCandidates` migrated off the manual `pool.connect()`/`SET admin_scan` scaffolding onto `withCrossWorkspaceScan`; `transitionToSending`'s per-tenant re-entry is byte-unchanged.
- Live-applied migration 0041 to the actual local dev database (`npm run db:roles && npm run db:migrate`), confirmed via a live catalog query.
- P3 ("API process holds neither scan-role credentials nor membership") is now proven structurally: `apps/worker/src/server.ts` refuses to boot without `SCAN_DATABASE_URL`; `apps/api/src/env.ts` never references it; no file under `apps/api/src` (outside `__tests__`) imports `withCrossWorkspaceScan`; `pg_has_role('mega_crm_app', 'mega_crm_scan'/'mega_crm_auth', 'MEMBER')` is false.
- ARCHITECTURE.md §7 records the SEC-01 ADR with both rejected alternatives named (`SET LOCAL ROLE`, keeping the GUC with narrower policies) and the reasons each was rejected; SPECIFICATION.md §3/§4/§5/§8 updated to as-built.

## Task Commits

1. **Task 1: End-to-end cross-workspace campaign scan under a dedicated role** - `6917fc3` (feat)
2. **Task 2: Apply migration 0041 live + prove the API process cannot reach the scan role (P3)** - `3d742f9` (feat)
3. **Task 3: SEC-01 connection-shape ADR + SPECIFICATION.md as-built update** - `b8c3807` (docs)

**Plan metadata:** commit_docs is enabled but `.planning/` is gitignored in this repo (worktree mode) -- the final metadata commit step reported `skipped_gitignored` for all three task commits, which is expected: `.planning/` artifacts never enter git history here. STATE.md/ROADMAP.md are the orchestrator's responsibility after this worktree merges.

_Note: Task 1 carries `tdd="true"` on a `tracer` task. See "Deviations" below for how the TDD gate was interpreted for this wide, indivisible architectural slice._

## Files Created/Modified

- `docker/init-app-role.sql` - two new `CREATE ROLE ... IF NOT EXISTS` blocks for `mega_crm_scan`/`mega_crm_auth`, mirroring the existing `mega_crm_app` block
- `scripts/ensure-db-roles.mjs` - idempotent role bootstrap for existing Postgres volumes (`npm run db:roles`), wired into root `predev` before `migrate-dev.mjs`
- `packages/test-support/src/provision-db.ts` - `SCAN_ROLE`/`AUTH_ROLE` constants, `buildRoleDsn` (generalized from `buildAppDsn`), `ensureClusterRoles`, called from `createEphemeralDatabase`
- `packages/test-support/src/db-fixture.ts` - `getScanTestDatabaseUrl`/`getAuthTestDatabaseUrl`
- `packages/test-support/src/global-setup.ts` - publishes `process.env.SCAN_DATABASE_URL` after `TEST_DATABASE_URL`/`DATABASE_URL`
- `packages/test-support/src/index.ts` - exports the new symbols
- `packages/tenant-context/src/scan.ts` - `withCrossWorkspaceScan`, `closeScanPool`
- `packages/tenant-context/src/index.ts` - re-exports the scan helper
- `packages/tenant-context/src/__tests__/scan.test.ts` - the tracer slice's negative/catalog test suite (Tests 1-5, 7, plus the Task-2 P3 membership assertion)
- `packages/db/migrations/0041_scan_role_bootstrap.sql` - grants + role-scoped `campaigns_scan` policy + `TO mega_crm_app` scoping
- `packages/db/migrations/meta/_journal.json` - journal entry idx 41
- `apps/worker/src/queues/campaign-scheduler.worker.ts` - `findDueCampaignCandidates` migrated to `withCrossWorkspaceScan`; both functions exported for direct testing
- `apps/worker/src/queues/__tests__/campaign-scheduler-scan.test.ts` - Test 6 (discovery + per-tenant transition across two workspaces)
- `apps/worker/src/server.ts` - `buildWorker` boot check for `SCAN_DATABASE_URL`
- `apps/api/src/__tests__/env-schema.test.ts` - P3 source-level negative assertions
- `scripts/check-env.mjs` - `SCAN_DATABASE_URL` added to `baseRequired`
- `ARCHITECTURE.md` - §7 SEC-01 ADR
- `SPECIFICATION.md` - §3.2 (SCAN_DATABASE_URL), §3.6 (fourth pool), §4.3 (new roles + migration 0041), §5.4 (campaign-scheduler on the scan pool), §8.2b (first migration depending on a non-self-created role)
- `package.json` / `package-lock.json` - `db:roles` npm script, `pg` declared as a root devDependency (lint fix)

## Decisions Made

- D-01/D-02/D-03 from CONTEXT.md were implementation targets, not open decisions in this plan -- executed as locked.
- Chose `withCrossWorkspaceScan`'s error-check ordering (DSN presence checked on every call, not just first) so a test can delete `SCAN_DATABASE_URL` after the pool already exists and still observe the fail-fast error deterministically.
- Exported `findDueCampaignCandidates`/`transitionToSending` from `campaign-scheduler.worker.ts` (previously private) to test the discovery+transition path directly, mirroring `analytics-reconciliation.worker.ts`'s existing `reconcileWorkspaceDay` export precedent.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug/spec correction] Plan's Test 5 wording didn't match actual Postgres semantics**
- **Found during:** Task 1 (writing `scan.test.ts`)
- **Issue:** The plan's behavior spec said a scan-pool query against `contacts` (a table with no `campaigns`-style grant in migration 0041) "returns zero rows." Verified live against Postgres 17 with a throwaway probe database that this is incorrect: a table with no `GRANT SELECT` for `mega_crm_scan` denies access outright at the privilege-check layer ("permission denied for table contacts") before RLS is even evaluated -- it does not fall through to an empty result set.
- **Fix:** Wrote the test to assert the actual (and strictly stronger) claim: `withCrossWorkspaceScan` querying `contacts` rejects with `/permission denied for table contacts/`. This proves "the role's visibility is grant/policy-driven, not blanket" more conclusively than the plan's literal wording would have.
- **Files modified:** `packages/tenant-context/src/__tests__/scan.test.ts`
- **Verification:** Test passes; empirically reproduced with a scratch database before writing the assertion.
- **Committed in:** `6917fc3` (Task 1 commit)

**2. [Rule 3 - Blocking] Lint failures surfaced by the plan's own `npm run lint` verify step**
- **Found during:** Task 3's `<verify>` step
- **Issue:** (a) `scan.test.ts` imported `getTestDatabaseUrl` without using it. (b) `scripts/ensure-db-roles.mjs` imports the `pg` package, but root `package.json` never declared it as a dependency, tripping `import-x/no-extraneous-dependencies`.
- **Fix:** Removed the unused import. Declared `pg@8.22.0` as a root-level `devDependency` in `package.json` and the matching lockfile entry in `package-lock.json` (the package was already present via npm workspace hoisting from other packages' dependencies -- no `npm install` network call was needed).
- **Files modified:** `packages/tenant-context/src/__tests__/scan.test.ts`, `package.json`, `package-lock.json`
- **Verification:** `npm run lint` exits 0.
- **Committed in:** `b8c3807` (Task 3 commit)

**3. [Rule 3 - Blocking, worktree-local, uncommitted] Cross-package module resolution required local `node_modules/@mega-crm/*` symlinks**
- **Found during:** Task 1 verification
- **Issue:** This worktree has no `node_modules` of its own; Node's resolution algorithm walked up to the MAIN checkout's `node_modules/@mega-crm/*` symlinks, which point at the main checkout's (stale, pre-this-plan) `packages/*` sources -- so running tests inside the worktree silently exercised the wrong code.
- **Fix:** Created `node_modules/@mega-crm/*` symlinks inside the worktree pointing at the worktree's OWN `apps/*`/`packages/*` directories, so Node resolves cross-package imports (e.g. `@mega-crm/test-support` from `packages/tenant-context`) to the code actually being changed. `node_modules/` is gitignored -- nothing here touches tracked files.
- **Files modified:** none (uncommitted, gitignored local convenience)
- **Verification:** all test runs below reflect the worktree's own code, confirmed by re-running after each edit.

---

**Total deviations:** 3 (1 spec correction, 2 blocking auto-fixes)
**Impact on plan:** All three were necessary for correctness/passing verification. No scope creep -- no file outside the plan's stated concerns was touched except the two lint-fix files, which were required to make the plan's own `<verify>` step pass.

## Issues Encountered

- **Tracer feedback gate interpretation:** Task 1 is `type="tracer" tdd="true"`. The plan defines no `checkpoint:*` task after it, `workflow.auto_advance`/`workflow._auto_chain_active` are both `false` in `.planning/config.json`, but the top-level `mode` is `"yolo"` and this execution runs as a non-interactive worktree-parallel executor with no live channel to pause and resume on. Given the planner's own choice not to insert a checkpoint task, and the practical inability to implement a genuine mid-plan human pause in this spawn model, I treated the passing automated `<verify>` (both vitest commands exit 0) as satisfying the tracer feedback gate and proceeded directly to Tasks 2 and 3 rather than returning a `checkpoint:human-verify`. Flagging this interpretation explicitly for the orchestrator/user to review.
- **`apps/web` build failure is pre-existing and unrelated:** `npm run build --workspaces --if-present` fails on `@mega-crm/web` with `TS2688: Cannot find type definition file for 'vite/client'`. Confirmed this is an environment artifact, not a regression from this plan: `apps/web/node_modules/vite` exists in the MAIN checkout but this worktree has no `apps/web/node_modules` at all (no `vite` package is hoisted anywhere in the workspace's root `node_modules` either). This plan touches zero files under `apps/web`. All other 11 workspaces (`api`, `worker`, `db`, `contacts-core`, `delivery-core`, `flows-core`, `kms`, `segments-core`, `shared-schemas`, `tenant-context`, `test-support`) built cleanly with `tsc`.
- **Live dev-database apply:** the plan's Task 2 offered a fallback ("record in the SUMMARY that the live dev apply is outstanding") for environments where the dev database is unreachable. It was reachable here (local native Postgres, `mega_crm` database) -- `npm run db:roles` then `npm run db:migrate` were run against it directly, and the resulting catalog state (`campaigns_scan TO mega_crm_scan`, `workspace_isolation TO mega_crm_app`, `campaign_scheduler_due_scan` unscoped/inert) was confirmed with a live `pg_policy` query. No fallback needed.

## User Setup Required

**External services require manual configuration for any environment with an existing Postgres data volume.** Per this plan's `user_setup` block:

- **`SCAN_DATABASE_URL`** must be added to the worker process's env file (resolved via `MEGA_CRM_ENV_FILE`) as `postgres://mega_crm_scan:<password>@<host>:5432/mega_crm`. It must NOT be present in the API process's env (this is enforced by `apps/api/src/env.ts`'s schema never declaring it, and now proven by a source-level test).
- **For any Postgres cluster with a pre-existing data volume** (local dev machines that predate this plan, staging, prod): run `npm run db:roles` (superuser DSN via `GSD_ADMIN_DATABASE_URL` or `TEST_ADMIN_DATABASE_URL`) BEFORE running migrations, or run the equivalent `CREATE ROLE` block from `docker/init-app-role.sql` manually as a superuser. Fresh docker-compose volumes get both new roles automatically from the extended `docker/init-app-role.sql`.
- This machine's local dev environment (`~/.config/mega-crm/.env`) does not have `SCAN_DATABASE_URL` set yet -- `npm run dev`'s worker process will refuse to boot until it is added. The role bootstrap and migration were already applied live to this machine's `mega_crm` database (see Issues Encountered), so only the env var addition remains.

## Next Phase Readiness

- The scan-role architecture (D-01/D-02/D-03) is proven end to end on one real consumer and is ready for the remaining four consumers (flow-segment-sweep, flow-reconciliation, partition maintenance/relocation, analytics-reconciliation) to adopt the identical `withCrossWorkspaceScan` shape in later plans of this phase.
- The sixth GUC touchpoint (`attachPartitionCheckFirst`'s `SET LOCAL app.admin_scan`, RESEARCH.md Pitfall 8) is untouched by this plan and still needs migrating in a later plan's GUC-deletion sweep.
- `mega_crm_auth` exists as a role but has zero grants -- the Better Auth trust-boundary plan (SEC-05, D-04/D-05) still needs to wire its grant matrix.
- No blockers for continuing the phase's wave of remaining plans.

## Self-Check: PASSED

- FOUND: packages/tenant-context/src/scan.ts
- FOUND: packages/tenant-context/src/__tests__/scan.test.ts
- FOUND: packages/db/migrations/0041_scan_role_bootstrap.sql
- FOUND: scripts/ensure-db-roles.mjs
- FOUND: apps/worker/src/queues/__tests__/campaign-scheduler-scan.test.ts
- FOUND commit: 6917fc3
- FOUND commit: 3d742f9
- FOUND commit: b8c3807

---
*Phase: 10-tenant-isolation-trust-boundaries*
*Completed: 2026-08-07*
