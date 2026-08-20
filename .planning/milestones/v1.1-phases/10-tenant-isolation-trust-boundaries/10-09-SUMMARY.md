---
phase: 10-tenant-isolation-trust-boundaries
plan: 09
subsystem: auth
tags: [postgres, rls-alternative, grants, better-auth, drizzle, zod, security-boundary]

# Dependency graph
requires:
  - phase: 10-tenant-isolation-trust-boundaries
    provides: "10-01's mega_crm_auth login role (created, ungranted) and getAuthTestDatabaseUrl() test fixture; 10-07's fail-closed RLS baseline"
provides:
  - "Migration 0045: mega_crm_auth exclusive access to session/account/verification; mega_crm_app narrowed to SELECT-only (+UPDATE on organization, +UPDATE on user/REFERENCES on organization for Postgres FK-enforcement mechanics) on the four workspace-shaped auth tables"
  - "packages/db/src/index.ts's authDb: lazy, Proxy-wrapped Drizzle client on AUTH_DATABASE_URL, the sole client Better Auth's drizzleAdapter now uses"
  - "apps/api/src/env.ts's BETTER_AUTH_SECRET production floor (>=32 chars, NODE_ENV=production-gated)"
  - "apps/api/src/modules/auth/__tests__/auth-boundary.test.ts: the auth-flow acceptance gate (signup/login/invite-accept + 4 catalog/permission assertions)"
  - "ARCHITECTURE.md SS8 (the SEC-05 ADR) and updated SPECIFICATION.md SS3/SS4.1/SS4.3/SS6"
affects: [11-delivery-state-machine, future-phases-touching-better-auth-schema]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Grant partitioning (GRANT/REVOKE between two login roles) as the boundary mechanism instead of RLS, for tables a framework (Better Auth) owns and that set no session GUC"
    - "Lazy Proxy-wrapped Drizzle client (mirrors packages/tenant-context/src/scan.ts's getScanPool laziness) so importing @mega-crm/db from a process without the credential constructs nothing"
    - "Test fixtures that write directly to framework-owned tables route through the framework's own role (mega_crm_auth), never widen the app role's grants for test convenience"

key-files:
  created:
    - packages/db/migrations/0045_auth_role_grants.sql
    - apps/api/src/modules/auth/__tests__/auth-boundary.test.ts
  modified:
    - packages/db/src/index.ts
    - apps/api/src/modules/auth/auth.ts
    - apps/api/src/env.ts
    - apps/api/src/__tests__/env-schema.test.ts
    - packages/test-support/src/global-setup.ts
    - scripts/check-env.mjs
    - ARCHITECTURE.md
    - SPECIFICATION.md
    - "~40 pre-existing test files across apps/api, apps/worker, packages/db, packages/tenant-context, packages/delivery-core (fixture-write role repointing; see Deviations)"

key-decisions:
  - "Checkpoint option-a: ship the audited grant matrix as proposed (mega_crm_auth full DML on all seven tables; mega_crm_app SELECT-only + UPDATE-on-organization on the four workspace-shaped tables). Rejected option-b (also leave mega_crm_app privileged on verification) as an unjustified weakening; rejected option-c (move table ownership) as making every future Better Auth migration require a privileged out-of-band step."
  - "Execution-discovered: mega_crm_app additionally needs UPDATE on user and REFERENCES on organization -- not for any application query site, but because Postgres's own FK-enforcement (RI check locking) and DDL-authoring mechanisms run under the REFERENCING table's owner (mega_crm_app), regardless of which role's connection performs the write. Verified empirically; documented in the migration, ARCHITECTURE.md SS8, and SPECIFICATION.md SS4.3."
  - "authDb is lazy (Proxy-wrapped), not eager like the existing db client -- so apps/worker (which also imports @mega-crm/db for its own non-auth queries) never constructs an auth pool or requires AUTH_DATABASE_URL."

patterns-established:
  - "A framework-owned table set with no session GUC gets a dedicated login role + grant partition, not RLS -- RLS on such tables silently returns zero rows with no SQL error (Pitfall 12), whereas grants fail loudly with a permission error."
  - "Test-only direct writes to a table whose live application grant no longer covers INSERT/UPDATE/DELETE route through the role that DOES have those grants (here, mega_crm_auth), never through a widened app-role grant added 'just for tests'."

requirements-completed: [SEC-05, SEC-12]

coverage:
  - id: D1
    description: "mega_crm_auth login role gains exclusive grants on all seven Better Auth tables; mega_crm_app loses all privileges on session/account/verification and is narrowed to SELECT (+UPDATE on organization, +UPDATE on user/REFERENCES on organization for Postgres's own FK mechanics) on the four workspace-shaped tables"
    requirement: SEC-05
    verification:
      - kind: unit
        ref: "apps/api/src/modules/auth/__tests__/auth-boundary.test.ts#Test 4: mega_crm_app holds no privilege on session/account/verification across SELECT/INSERT/UPDATE/DELETE"
        status: pass
      - kind: unit
        ref: "apps/api/src/modules/auth/__tests__/auth-boundary.test.ts#Test 5: mega_crm_app keeps SELECT + UPDATE on organization, but not INSERT/DELETE"
        status: pass
      - kind: unit
        ref: "apps/api/src/modules/auth/__tests__/auth-boundary.test.ts#Test 6: mega_crm_auth holds SELECT on all seven Better Auth tables"
        status: pass
      - kind: unit
        ref: "apps/api/src/modules/auth/__tests__/auth-boundary.test.ts#Test 7: reading session through the app-role tenant pool rejects with a permission error, not zero rows"
        status: pass
    human_judgment: false
  - id: D2
    description: "Better Auth's drizzleAdapter runs on the mega_crm_auth-backed authDb client; signup, login and invite-accept all pass end to end against the real server and database"
    requirement: SEC-05
    verification:
      - kind: integration
        ref: "apps/api/src/modules/auth/__tests__/auth-boundary.test.ts#Test 1: signup creates a user and returns a session"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/auth/__tests__/auth-boundary.test.ts#Test 2: login with those credentials succeeds and issues a session cookie"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/auth/__tests__/auth-boundary.test.ts#Test 3: an invited user accepts an invitation and becomes a member of the inviting workspace"
        status: pass
    human_judgment: false
  - id: D3
    description: "A production boot with a BETTER_AUTH_SECRET shorter than 32 characters fails with a descriptive error naming the variable and the requirement; development/test are unaffected"
    requirement: SEC-12
    verification:
      - kind: unit
        ref: "apps/api/src/__tests__/env-schema.test.ts#envSchema BETTER_AUTH_SECRET production floor > Test 1: production + a 20-character secret fails, with an issue on path BETTER_AUTH_SECRET"
        status: pass
      - kind: unit
        ref: "apps/api/src/__tests__/env-schema.test.ts#envSchema BETTER_AUTH_SECRET production floor > Test 2: the same 20-character secret in development still passes -- the floor is production-only"
        status: pass
      - kind: unit
        ref: "apps/api/src/__tests__/env-schema.test.ts#envSchema BETTER_AUTH_SECRET production floor > Test 3: a 32-character secret in production passes"
        status: pass
      - kind: unit
        ref: "apps/api/src/__tests__/env-schema.test.ts#envSchema BETTER_AUTH_SECRET production floor > Test 4: the failure message names the variable and the 32-character requirement"
        status: pass
    human_judgment: false
  - id: D4
    description: "The SEC-05 ADR (ARCHITECTURE.md SS8) names both rejected alternatives (RLS on the auth tables; an auth.* schema move) with reasons, records reversibility and the acceptance gate, and documents the checkpoint-accepted owner-can-re-grant caveat"
    verification:
      - kind: other
        ref: "grep -q mega_crm_auth ARCHITECTURE.md && grep -q AUTH_DATABASE_URL SPECIFICATION.md"
        status: pass
    human_judgment: false

# Metrics
duration: ~45min (execution after checkpoint resume; excludes the human-decision pause)
completed: 2026-08-08
status: complete
---

# Phase 10 Plan 9: Better Auth Trust Boundary Summary

**A dedicated `mega_crm_auth` Postgres login role now owns exclusive access to Better Auth's secret-bearing tables (`session`, `account`, `verification`) via `GRANT`/`REVOKE` (not RLS, per Pitfall 12), with a production-only 32-character `BETTER_AUTH_SECRET` floor and a full auth-flow acceptance suite proving login/signup/invite-accept still work end to end.**

## Performance

- **Duration:** ~45 min of active execution after the checkpoint resumed (the plan opened with a `checkpoint:decision` blocking task; the human operator selected option-a via the orchestrator before any implementation began)
- **Tasks:** 3 (checkpoint + 3 execute tasks, all completed)
- **Files modified:** 54 (2 created, 52 modified — see Deviations for why the modified count is large)

## Accomplishments

- Migration `0045_auth_role_grants.sql`: `mega_crm_auth` gets full DML on all seven Better Auth tables; `mega_crm_app` is revoked entirely from `session`/`account`/`verification` and narrowed on the four workspace-shaped tables to exactly what live query sites use, per the checkpoint's audited matrix (option-a)
- `packages/db/src/index.ts` exports `authDb` — a lazily-constructed (Proxy-wrapped), `mega_crm_auth`-backed Drizzle client — and `apps/api/src/modules/auth/auth.ts`'s `drizzleAdapter` now uses it instead of the app-role `db`
- `apps/api/src/env.ts` requires `AUTH_DATABASE_URL` and enforces a `>=32`-character `BETTER_AUTH_SECRET` floor when `NODE_ENV=production` (development/test keep the existing `min(16)`)
- `apps/api/src/modules/auth/__tests__/auth-boundary.test.ts`: 7 tests — 3 real end-to-end flows (signup, login, invite-accept) plus 4 catalog/permission assertions pinning the grant matrix
- ARCHITECTURE.md §8 (the SEC-05 ADR) and SPECIFICATION.md §3/§4.1/§4.3/§6 updated with the grant matrix, the fifth persistent DB pool, and the production secret floor

## Task Commits

1. **Task 1: Migration 0045 — auth-role grants and app-role revocations** — `081a288` (feat)
2. **Task 2 (TDD RED): prove signup/login/invite-accept break post-0045** — `f23a84d` (test)
2. **Task 2 (TDD GREEN): point Better Auth at authDb** — `d24e875` (feat)
2. **Task 2 (ripple fix): repoint ~40 test fixtures off mega_crm_app** — `8c3a4f0` (fix)
3. **Task 3 (TDD RED): prove no production secret floor exists** — `afaadde` (test)
3. **Task 3 (TDD GREEN): production floor + ADR + SPECIFICATION.md** — `50b55e9` (feat)

No separate plan-metadata commit: `.planning/` is gitignored in this repository (see `commit_docs`/`skipped_gitignored` note below).

## Files Created/Modified

- `packages/db/migrations/0045_auth_role_grants.sql` — the grant matrix (created)
- `packages/db/migrations/meta/_journal.json` — journal entry idx 45
- `packages/db/src/index.ts` — `authDb` export
- `apps/api/src/modules/auth/auth.ts` — `drizzleAdapter(authDb, ...)`
- `apps/api/src/env.ts` — `AUTH_DATABASE_URL` + production secret floor
- `apps/api/src/__tests__/env-schema.test.ts` — `AUTH_DATABASE_URL` in `baseValidEnv()`; 4 new production-floor tests
- `packages/test-support/src/global-setup.ts` — publishes `AUTH_DATABASE_URL`
- `scripts/check-env.mjs` — presence-checks `AUTH_DATABASE_URL`
- `apps/api/src/modules/auth/__tests__/auth-boundary.test.ts` — the acceptance suite (created)
- `ARCHITECTURE.md` — §8, the SEC-05 ADR
- `SPECIFICATION.md` — §3.2/§3.3/§3.6, §4.1/§4.3, §6.6
- `.planning/phases/10-tenant-isolation-trust-boundaries/deferred-items.md` — two pre-existing, out-of-scope flakes reconfirmed (see Deviations)
- ~40 pre-existing test files across `apps/api`, `apps/worker`, `packages/db`, `packages/tenant-context`, `packages/delivery-core` — fixture writes to `organization`/`member`/`invitation` repointed from `mega_crm_app` to `mega_crm_auth` (or an already-open superuser pool where one existed)

## Decisions Made

- **Checkpoint option-a** (see plan's checkpoint task): ship the audited grant matrix as proposed rather than option-b (leave `mega_crm_app` privileged on `verification` "just in case") or option-c (move table ownership to `mega_crm_auth`, which would make migrations — which apply as `mega_crm_app` — unable to alter these tables without a privileged out-of-band step).
- **`authDb` is lazy**, mirroring `packages/tenant-context/src/scan.ts`'s `getScanPool` pattern — a Proxy defers pool construction to first property access, so importing `@mega-crm/db` from `apps/worker` (which also uses the package for its own non-auth queries) never constructs an auth pool or requires `AUTH_DATABASE_URL`.
- **Test fixtures that write directly to a now-narrowed table route through `mega_crm_auth`, never through a widened `mega_crm_app` grant** — the security boundary this plan builds would be pointless if "tests need it" became grounds to hand the app role back the privilege it was just revoked.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1/3] `mega_crm_app` needs `UPDATE` on `user` and `REFERENCES` on `organization` beyond the checkpoint's audited matrix**
- **Found during:** Task 2, running the auth-boundary suite for the first time after wiring `authDb`
- **Issue:** Signup/session-creation failed with `permission denied for table user` from deep inside Better Auth's adapter, even though `mega_crm_auth` (the connecting role) held full DML on `user`. Root-caused empirically: Postgres enforces every foreign key referencing `user` (from `account`, `session`, `member`, `invitation`) with an internal row-locking check (`SELECT ... FOR KEY SHARE`) that runs under the *referencing* table's OWNER (`mega_crm_app`, which owns all seven tables), regardless of which role's connection performs the INSERT — and that check requires `SELECT` **and** `UPDATE` on `user`, not `SELECT` alone (confirmed by direct experimentation: a `REFERENCES`-only grant does not substitute). A second, DDL-time sibling of the same issue surfaced in `packages/db`'s partition test suites: re-creating a FK constraint referencing `organization` requires the issuing role (`mega_crm_app`, which applies migrations) to hold `REFERENCES` on `organization`.
- **Fix:** Added `GRANT UPDATE ON "user" TO mega_crm_app;` and `GRANT REFERENCES ON organization TO mega_crm_app;` to migration 0045, each with an extensive comment distinguishing this from the application-level audit (no first-party source performs `UPDATE "user"` outside Better Auth's own adapter; `REFERENCES` grants no read/write access to data).
- **Files modified:** `packages/db/migrations/0045_auth_role_grants.sql`
- **Verification:** `auth-boundary.test.ts`'s Tests 1-3 (signup/login/invite-accept) pass; Test 5's assertion that `mega_crm_app` lacks `INSERT`/`DELETE` on `organization` is unaffected (the new grant is `UPDATE`/`REFERENCES` only)
- **Committed in:** `081a288` (folded into Task 1's migration, since Task 2's testing discovered it before Task 1's commit would otherwise have needed amending)

**2. [Rule 1/3] ~40 pre-existing test files broke because they wrote directly to `organization`/`member`/`invitation` through `mega_crm_app`**
- **Found during:** Task 2, running the broader `apps/api`/`apps/worker`/`packages/*` suites after wiring `authDb`
- **Issue:** Many pre-existing tests (none of them live application query sites) seeded fixture workspace/member rows by writing directly through the app-role pool — a pattern that worked only because `mega_crm_app` previously had full, unrestricted access to these tables. Migration 0045 revoked that access as designed, breaking every one of these fixtures.
- **Fix:** Each fixture write now goes through the `mega_crm_auth`-backed connection instead (via a new `authDb`/`getAuthTestDatabaseUrl()`-backed helper, or an already-open superuser `adminDsn` pool in the two partition-relocation suites that already had one). `apps/worker` additionally consolidates 22 near-identical duplicated `freshWorkspaceId` helpers to delegate into `failure-fixtures.ts`'s new `insertFixtureOrganization`, closing the exact "third copy is how the first two started drifting" risk that file's own header comment already warned about.
- **Files modified:** ~40 test files across `apps/api/src/{db,modules/{api-keys,flows,ops,segments,tenancy,webhooks}}/__tests__`, `apps/worker/src/{queues/__tests__,test/failure-fixtures.ts}`, `packages/db/src/{__tests__,partitions/__tests__}`, `packages/tenant-context/src/__tests__`, `packages/delivery-core/src/__tests__`
- **Verification:** `npx vitest run --root apps/api` (55 files, 320 tests) and the full `apps/worker` suite (32 files, 131 tests) both pass 100%; `packages/db`, `packages/tenant-context`, `packages/delivery-core` all pass 100%
- **Committed in:** `8c3a4f0`

**3. [Rule 3] `SCAN_DATABASE_URL` literal in a new `env.ts` comment broke the P3 negative-source test**
- **Found during:** Task 2's broader test run
- **Issue:** A doc comment I added to `env.ts` explaining `AUTH_DATABASE_URL`'s absence-of-scan-variable property literally contained the string `SCAN_DATABASE_URL`, which `env-schema.test.ts`'s source-scanning P3 assertion (`expect(envSource).not.toMatch(/SCAN_DATABASE_URL/)`) correctly flagged.
- **Fix:** Reworded the comment to describe the property without naming the literal variable.
- **Files modified:** `apps/api/src/env.ts`
- **Verification:** `env-schema.test.ts` passes
- **Committed in:** `d24e875`

**4. [Rule 3] `invite-response-identity.test.ts`'s org-orphaning helper needed both a role change and an additional dropped constraint**
- **Found during:** Task 2's broader test run
- **Issue:** `deleteOrganizationLeavingInvitationOrphaned` (a test-only helper that force-orphans an invitation for a 404-identity test) does a raw `DELETE FROM organization`, which now needs `mega_crm_auth` (not `mega_crm_app`, which lost `DELETE` on `organization`). Once switched, the `DELETE` triggered a cascade into `member` (the workspace owner's own membership row) — and that cascade's internal check also runs under `member`'s owner (`mega_crm_app`), which only holds `SELECT` on `member`, so the cascade itself failed with a permission error.
- **Fix:** Added a raw `Pool` connected via `AUTH_DATABASE_URL` for the `DELETE` statement (the `ALTER TABLE` statements stay on the existing `mega_crm_app` pool, since DDL needs table ownership, not a grant); additionally drop-and-restore `member`'s FK to `organization` alongside `invitation`'s (already done for the latter), sidestepping the cascade entirely rather than widening `mega_crm_app`'s grants for a test-only edge case.
- **Files modified:** `apps/api/src/modules/tenancy/__tests__/invite-response-identity.test.ts`
- **Verification:** all 4 tests in the file pass
- **Committed in:** `8c3a4f0`

---

**Total deviations:** 4 auto-fixed (2 blocking/execution-discovered grant gaps, 2 blocking test-fixture breakages), all Rule 1/3.
**Impact on plan:** All auto-fixes were necessary for the plan's own acceptance gate (the auth-flow suite) and for the broader test suite to stay green after implementing the checkpoint-approved grant matrix. No scope creep: the additional grants (`UPDATE` on `user`, `REFERENCES` on `organization`) are narrowly justified by Postgres's own constraint-enforcement mechanics, not by any application query site, and are documented as such everywhere the grant matrix is described (migration comment, ADR, SPECIFICATION.md).

## Issues Encountered

- **Pre-existing, out-of-scope test-isolation flake reconfirmed under `npm run coverage`:** `apps/worker/src/queues/__tests__/flow-segment-trigger.test.ts` fails 4/8 tests with a `TypeError` inside `compileSegmentDefinition`, only when run as part of the full monorepo `npm run coverage` aggregate (8/8 pass reliably in isolation and as part of the full `apps/worker` suite, verified 32/32 standalone during this plan's own work). This exact failure was already documented as pre-existing and out-of-scope by plan 10-07's executor in `deferred-items.md`; migration 0045 touches none of the tables or scan-role policies this failure path reads. Reconfirmed and appended to `deferred-items.md` and `.planning/WINDOWS.md` rather than re-investigated or fixed.
- **`npm run test:e2e` fails to load Playwright's own config in this sandbox** (`ERR_MODULE_NOT_FOUND` on a `.ts` deep-specifier import, under Node v26). Confirmed pre-existing and unrelated to this plan by reproducing the identical failure with every one of this plan's changes fully `git stash`ed back to the last committed state. Documented in `deferred-items.md`; not fixed (environment/Node-version concern, not a code change this plan owns).
- Both issues are logged in `.planning/WINDOWS.md` (kinds `deviation` and `unrun-verify`) per the broken-windows ledger convention.

## User Setup Required

**One external configuration step, per the plan's `user_setup` block:** the API process needs `AUTH_DATABASE_URL` set to a `postgres://mega_crm_auth:<password>@<host>:5432/mega_crm` connection string (the worker does not need it — no worker source imports the Better Auth schema). This is a deployment/ops action outside this plan's code scope; `scripts/check-env.mjs` will refuse `npm run dev` without it, and `apps/api/src/env.ts` will refuse to boot without it.

## Next Phase Readiness

- The Better Auth trust boundary (SEC-05) and the production secret floor (SEC-12) are both closed — `ARCHITECTURE.md` §8 and `SPECIFICATION.md` §3/§4.1/§4.3/§6.6 are the durable record.
- `mega_crm_app`'s privilege surface on all seven Better Auth tables is now exactly: `SELECT` on `organization`/`member`/`invitation`/`user`, `UPDATE`/`REFERENCES` on `organization`, `UPDATE` on `user` (Postgres-mechanics-only), and nothing on `session`/`account`/`verification`. Any future migration adding a new write path to these tables from application code must go through `mega_crm_auth`, not widen this grant.
- Two pre-existing, out-of-scope test-infrastructure gaps remain open for a future phase: the cross-project `npm run coverage` test-isolation flake (`flow-segment-trigger.test.ts`) and the `npm run test:e2e` Node-module-resolution gap in this sandbox — both tracked in `deferred-items.md` and `.planning/WINDOWS.md`.
- `commit_docs: true` and `.planning/` is gitignored in this repository — `gsd-tools query commit` for `.planning/` paths reports `skipped_gitignored`, which is expected and not a failure; source-code commits above landed normally.

---
*Phase: 10-tenant-isolation-trust-boundaries*
*Completed: 2026-08-08*

## Self-Check: PASSED

All created files verified present on disk; all 6 task commit hashes verified in `git log`.
