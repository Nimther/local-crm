---
phase: 10-tenant-isolation-trust-boundaries
plan: 07
subsystem: database
tags: [postgres, rls, tenant-isolation, fail-closed, security]

requires:
  - phase: 10-tenant-isolation-trust-boundaries
    provides: "plan 10-06's completed marker-GUC retirement (migration 0043) and the operator-only elevated DSN for non-empty partition attach -- the precondition this plan explicitly depended on"
provides:
  - "Migration 0044: all 22 workspace_isolation policies rewritten to one bare-cast, no-missing_ok, TO mega_crm_app predicate -- fail-closed on both a never-scoped and a recycled-to-empty connection"
  - "packages/tenant-context/src/index.ts -- PRE_TENANT_LOOKUP_SENTINEL_WORKSPACE_ID and withPreTenantLookup(fn), the mechanism the two pre-tenant lookups now use to stay evaluable under the fail-closed predicate without gaining any privilege"
  - "lookupApiKeyById and findWebhookEndpointByToken rewired onto withPreTenantLookup, still returning null (never throwing) for an unknown id/token"
  - "Inverted pinned baseline test (tenant-context.test.ts): asserts the thrown error, never a row count, plus a pg_policies catalog proof (22 identical predicates, zero NULLIF, zero PUBLIC-scoped policies)"
affects: [phase-10-remaining-plans, any-future-tenant-scoped-table]

tech-stack:
  added: []
  patterns:
    - "A fail-closed RLS predicate requires dropping BOTH the NULLIF guard AND current_setting's missing_ok second argument -- dropping only the guard still fails open on a genuinely untouched connection"
    - "A pre-tenant lookup (auth by presented credential, before any workspace is known) stays evaluable under a fail-closed predicate via a sentinel tenant-context value that matches no real row -- grants nothing by itself; a second, narrowly-keyed permissive policy is what actually grants the row"
    - "ATTACH PARTITION's internal FK re-validation evaluates the referenced table's RLS predicate even for a genuinely empty child -- 'zero rows means the check trivially passes regardless of visibility' is not a safe assumption once that predicate can throw instead of silently excluding"

key-files:
  created:
    - packages/db/migrations/0044_workspace_isolation_fail_closed.sql
  modified:
    - packages/db/migrations/meta/_journal.json
    - packages/tenant-context/src/index.ts
    - packages/tenant-context/src/__tests__/tenant-context.test.ts
    - packages/tenant-context/src/__tests__/scan.test.ts
    - apps/api/src/modules/api-keys/api-keys.repository.ts
    - apps/api/src/modules/api-keys/__tests__/api-key-auth.test.ts
    - apps/api/src/modules/webhooks/webhook-endpoint.repository.ts
    - apps/api/src/modules/webhooks/__tests__/webhooks-signature.test.ts
    - apps/api/src/middleware/tenant-context.ts
    - apps/api/src/modules/events/__tests__/events-api.test.ts
    - packages/db/src/partitions/ensure-partitions.ts
    - SPECIFICATION.md

key-decisions:
  - "The fail-closed predicate is the bare cast with NO current_setting second argument and NO NULLIF -- verified live that dropping only the NULLIF guard still returns zero rows (not an error) for a genuinely untouched connection, which fails SEC-04 outright"
  - "withPreTenantLookup uses a fixed all-zeros sentinel UUID (matches no real organization.id, gen_random_uuid() cannot produce it) rather than any dynamic per-call value -- simplest possible mechanism, and its non-privilege is directly testable (seed a real contacts row, assert the sentinel sees zero)"
  - "ensure-partitions.ts's non-adminClient ATTACH path gets the SAME sentinel treatment, not a real BYPASSRLS adminClient -- the everyday path only ever attaches an empty child, so 'predicate evaluates to false' is exactly as safe as the old fail-open behavior it replaces"

patterns-established:
  - "A negative proof that used to assert 'X grants no ADDITIONAL rows' (row-count equality) is re-expressed as 'X changes nothing about whether the predicate throws' once the underlying predicate goes fail-closed -- a stronger, not weaker, claim (scan.test.ts's marker-retirement proof)"

requirements-completed: [SEC-03, SEC-04]

coverage:
  - id: D1
    description: "All 22 workspace_isolation policies share one fail-closed, TO mega_crm_app predicate; a never-scoped and a recycled-to-empty connection both raise a Postgres error (never zero rows), proven for two representative tables (contacts, flows) and asserted from the pg_policies catalog for all 22"
    requirement: "SEC-03"
    verification:
      - kind: integration
        ref: "packages/tenant-context/src/__tests__/tenant-context.test.ts -- 'the fail-closed RLS contract (SEC-03/SEC-04)' describe block, 8/8 passing"
        status: pass
      - kind: integration
        ref: "npm run lint:migrations -- 45 files checked, no violations"
        status: pass
    human_judgment: false
  - id: D2
    description: "A query against a tenant table with no tenant context throws, never returns zero rows -- the specific SEC-04 acceptance criterion, asserted via rejects.toThrow on the exact Postgres error class, never a row-count assertion"
    requirement: "SEC-04"
    verification:
      - kind: integration
        ref: "packages/tenant-context/src/__tests__/tenant-context.test.ts -- 4 rejects.toThrow assertions (contacts x2, flows x2), all passing"
        status: pass
    human_judgment: false
  - id: D3
    description: "The two pre-tenant lookup paths (API-key auth, webhook receipt) still resolve their rows under the fail-closed predicate via withPreTenantLookup, and still return null (not throw) for an unknown id/token -- proven both at the repository-function level and end-to-end through the real HTTP stack"
    requirement: "SEC-03"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/api-keys/__tests__/api-key-auth.test.ts -- lookupApiKeyById direct tests + full apiKeyAuth suite, 15/15 passing"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/webhooks/__tests__/webhooks-signature.test.ts -- findWebhookEndpointByToken direct tests + full signature-verification suite, 8/8 passing"
        status: pass
      - kind: integration
        ref: "npx vitest run --root apps/api -- 309/309 passing; npx vitest run --root apps/worker -- 125/125 passing; npx vitest run --root packages/db -- 45/45 passing"
        status: pass
    human_judgment: false

duration: 23min
completed: 2026-08-07
status: complete
---

# Phase 10 Plan 07: RLS unification into a single fail-closed, role-scoped predicate Summary

**Migration 0044 rewrites all 22 `workspace_isolation` policies to one bare-cast, no-`missing_ok`, `TO mega_crm_app` predicate that throws (rather than silently returning zero rows) on a connection with no tenant context, paired with a new `withPreTenantLookup` sentinel mechanism that keeps API-key auth and webhook receipt working under that stricter predicate.**

## Performance

- **Duration:** ~23 min
- **Tasks:** 3/3 auto tasks completed
- **Files modified:** 12 (1 created, 11 modified)

## Accomplishments

- **Task 1 — Inverted the pinned pre-Phase-10 baseline (RED):** `tenant-context.test.ts`'s "no tenant in scope" describe block, which used to document and pin the fail-OPEN behavior (zero rows on a never-scoped connection), was rewritten to pin the opposite, fail-closed contract: `rejects.toThrow` for both the never-scoped and the recycled-to-empty cases, proven on two representative tables (`contacts`, previously bare-cast; `flows`, previously NULLIF-guarded) to show the fix is uniform, not table-specific. Added three catalog assertions over `pg_policies`: exactly 22 `workspace_isolation` policies share one distinct `qual`/`with_check` string, none contain `NULLIF`, and none apply to `PUBLIC`. All six assertions failed cleanly against the pre-migration schema before task 2 landed.
- **Task 2 — Migration `0044_workspace_isolation_fail_closed.sql` (GREEN):** One `ALTER POLICY workspace_isolation ON <table> TO mega_crm_app USING (...) WITH CHECK (...)` per table, identical predicate `workspace_id = current_setting('app.current_workspace_id')::uuid` (no second argument, no NULLIF) on all 22 tables -- the 12 previously bare-cast-with-`missing_ok` and the 10 previously NULLIF-guarded converge on the exact same form. Verified live against Postgres 17.10 (via RESEARCH.md) that dropping only the NULLIF guard is insufficient: the `missing_ok` argument must also go, or a genuinely untouched connection still returns zero rows rather than erroring. Also role-scoped the two pre-tenant lookup policies (`api_key_runtime_lookup`, `webhook_endpoint_runtime_lookup`) `TO mega_crm_app` without touching their own predicates. No `CREATE`/`DROP POLICY` -- every statement is an `ALTER POLICY`, so the migration linter's destructive-DDL rule doesn't apply.
- **Task 3 — `withPreTenantLookup` sentinel + fallout fixes:** Added `PRE_TENANT_LOOKUP_SENTINEL_WORKSPACE_ID` (all-zeros UUID) and `withPreTenantLookup(fn)` to `packages/tenant-context/src/index.ts`, mirroring `withTenantTransaction`'s transaction/release discipline but setting the tenant GUC to a value that matches no real workspace -- makes the fail-closed predicate evaluate to `false` (harmless exclusion) instead of raising, and grants nothing by itself (proven by a test that seeds a real `contacts` row and asserts the sentinel sees zero). `lookupApiKeyById` and `findWebhookEndpointByToken` now run inside this helper instead of a bare `pool.connect()`; both still return `null` (never throw) for an unknown id/token. Updated `SPECIFICATION.md` §4.3 (unified predicate + sentinel mechanism), §6.7/§6.8 (both pre-tenant lookups now read through `withPreTenantLookup`), §4.6 (journal count), and §9 (closed the open review item about the two-variant predicate).

## Task Commits

1. **Task 1: Invert the pinned pre-change baseline into fail-closed assertions (RED)** - `762c161` (test)
2. **Task 2: Migration 0044 -- one predicate, all 22 tenant policies, explicitly role-scoped (GREEN)** - `355a6e4` (feat)
3. **Task 3: withPreTenantLookup sentinel for the two pre-tenant lookups (+ fallout fixes)** - `ebf6b24` (feat)

## Files Created/Modified

- `packages/db/migrations/0044_workspace_isolation_fail_closed.sql` -- 22 `ALTER POLICY workspace_isolation` statements + 2 role-scope-only statements for the pre-tenant lookup policies
- `packages/db/migrations/meta/_journal.json` -- journal entry idx 44
- `packages/tenant-context/src/index.ts` -- `PRE_TENANT_LOOKUP_SENTINEL_WORKSPACE_ID`, `withPreTenantLookup`
- `packages/tenant-context/src/__tests__/tenant-context.test.ts` -- inverted baseline (6 new/changed assertions), sentinel non-privilege test
- `packages/tenant-context/src/__tests__/scan.test.ts` -- marker-retirement negative proof re-expressed for the fail-closed predicate
- `apps/api/src/modules/api-keys/api-keys.repository.ts` -- `lookupApiKeyById` via `withPreTenantLookup`
- `apps/api/src/modules/api-keys/__tests__/api-key-auth.test.ts` -- direct `lookupApiKeyById` tests
- `apps/api/src/modules/webhooks/webhook-endpoint.repository.ts` -- `findWebhookEndpointByToken` via `withPreTenantLookup`
- `apps/api/src/modules/webhooks/__tests__/webhooks-signature.test.ts` -- direct `findWebhookEndpointByToken` tests
- `apps/api/src/middleware/tenant-context.ts` -- re-exports `withPreTenantLookup`
- `apps/api/src/modules/events/__tests__/events-api.test.ts` -- fast-path proof read through `withTenant`/`withTenantTransaction` instead of a bare pool query
- `packages/db/src/partitions/ensure-partitions.ts` -- `attachPartitionCheckFirst`'s non-`adminClient` path sets the same sentinel before `ATTACH PARTITION`
- `SPECIFICATION.md` -- §4.3, §6.7, §6.8, §4.6, §9

## Decisions Made

- The fail-closed predicate drops BOTH the NULLIF guard and `current_setting`'s `missing_ok` argument -- confirmed by direct live testing (via RESEARCH.md) that dropping only the guard is insufficient for SEC-04's acceptance criterion.
- `withPreTenantLookup`'s sentinel is a single fixed all-zeros UUID, not a per-call dynamic value -- simplest mechanism that is directly provable as "grants nothing" (matches no `gen_random_uuid()` output).
- `ensure-partitions.ts`'s everyday (non-`adminClient`) ATTACH path gets the sentinel treatment rather than a real BYPASSRLS `adminClient` -- correct because that path only ever attaches an empty child, so "predicate evaluates false" is exactly as safe as the old fail-open behavior it replaces; a real `adminClient` remains required for the non-empty-child relocation path (plan 10-06), which needs genuine cross-tenant visibility.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Task 1's own new tests shared a single max:1 connection pool across sequential assertions**
- **Found during:** Task 1, first run against the (still pre-migration) schema
- **Issue:** The "never scoped" and "recycled connection" tests for both `contacts` and `flows` all drew from one shared `fresh` pool (`max: 1`). A "recycled" test's `fresh.connect()` released an already-touched physical connection back to the pool, which a LATER "never scoped" test then reused -- producing the wrong error class purely from execution order, not from anything the fail-closed contract itself asserts.
- **Fix:** Each never-scoped/recycled assertion now opens its own dedicated single-connection pool and ends it afterward.
- **Files modified:** `packages/tenant-context/src/__tests__/tenant-context.test.ts`
- **Verification:** All 12 tests in the file pass, deterministically, regardless of order
- **Committed in:** `355a6e4` (Task 2 commit)

**2. [Rule 1 - Bug] scan.test.ts's 10-06 marker-retirement negative proof relied on the old fail-open contract**
- **Found during:** Task 2, verifying `npx vitest run --root packages/tenant-context` after migration 0044 landed
- **Issue:** `countMarkerGatedTables` queried five tables (`campaigns`, `flow_runs`, `flows`, `contacts`, `sends`) on a genuinely fresh `mega_crm_app` connection and asserted zero rows -- under migration 0044 that connection now throws `unrecognized configuration parameter` instead of returning zero rows.
- **Fix:** Rewrote the helper (`countMarkerGatedTables` -> `probeMarkerGatedTables`) to assert the marker changes nothing about whether the fail-closed predicate throws (a stronger claim than the original row-count equality), running each table's query in its own transaction since Postgres aborts the whole transaction after the first error.
- **Files modified:** `packages/tenant-context/src/__tests__/scan.test.ts`
- **Verification:** `npx vitest run --root packages/tenant-context` -- 25/25 passing
- **Committed in:** `ebf6b24` (Task 3 commit)

**3. [Rule 1 - Bug] `attachPartitionCheckFirst`'s everyday (empty-child) ATTACH path throws under the fail-closed predicate**
- **Found during:** Task 3's full-suite verification (`npx vitest run --root apps/api`), specifically `partition-maintenance-tracer.test.ts`, which genuinely creates new monthly partitions (most other test databases already had all lookahead-window partitions from before migration 0044 was first applied, so they never exercised this path)
- **Issue:** The `ATTACH PARTITION` DDL statement itself, even for a freshly-created EMPTY child, causes Postgres to build a query plan for FK re-validation against `contacts`/`sends` that evaluates the `workspace_isolation` predicate regardless of the child's actual row count -- contradicting this function's own prior documented assumption ("zero rows means the FK validation trivially passes regardless of visibility"), which was true only because the OLD fail-open predicate never threw. On a connection that never set tenant context, the ATTACH statement now throws `unrecognized configuration parameter`.
- **Fix:** When no `adminClient` is supplied (every `ensurePartitions` call -- always an empty new month), the connection now sets `app.current_workspace_id` to the same all-zeros sentinel `withPreTenantLookup` uses, transaction-locally, before the five-statement sequence -- makes the predicate evaluate to `false` (harmless) instead of raising, exactly as safe as the old fail-open behavior for a child with nothing to validate. Skipped when `adminClient` IS supplied (the non-empty-child relocation path, plan 10-06) -- that path needs genuine cross-tenant visibility, which the sentinel would undermine, not restore.
- **Files modified:** `packages/db/src/partitions/ensure-partitions.ts`
- **Verification:** `apps/api`'s `partition-maintenance-tracer.test.ts` (6/6), full `apps/api` (309/309), full `packages/db` (45/45)
- **Committed in:** `ebf6b24` (Task 3 commit)

**4. [Rule 1 - Bug] events-api.test.ts's fast-path proof read `contacts` via a bare, tenant-scope-free pool query**
- **Found during:** Task 3's full-suite verification (`npx vitest run --root apps/api`)
- **Issue:** The test proving "the write did NOT happen synchronously" queried `contacts` via a raw `pool.query(...)` with no tenant context at all -- correct under the old fail-open predicate (silently zero rows, whether from the write genuinely not having happened yet OR from RLS incidentally hiding everything), but now throws under migration 0044.
- **Fix:** Rewrote the read to go through `withTenant`/`withTenantTransaction` scoped to the test's own workspace -- makes "no contact exists in this workspace" a genuine, meaningful tenant-scoped assertion instead of one that happened to also pass by accident.
- **Files modified:** `apps/api/src/modules/events/__tests__/events-api.test.ts`
- **Verification:** `npx vitest run --root apps/api` -- 309/309 passing
- **Committed in:** `ebf6b24` (Task 3 commit)

---

**Total deviations:** 4 auto-fixed (all Rule 1 -- direct, necessary consequences of migration 0044's fail-closed predicate change, required for the plan's own `<verification>` block to pass). No scope creep: every file touched beyond the plan's literal `<files>` lists is a test or a code path that provably broke as a direct result of task 2's migration.
**Impact on plan:** None beyond the deviations above. SEC-03/SEC-04's own acceptance criteria are met exactly as specified.

## Issues Encountered

- **Worktree/main-checkout package resolution:** this worktree has no local `node_modules`; Node's upward directory walk for bare `@mega-crm/*` imports (e.g. `@mega-crm/test-support`, whose `ensureTestDbMigrated()` resolves the migrations directory via `__dirname`-relative path) resolved to the MAIN CHECKOUT's `node_modules/@mega-crm/*` symlinks, not this worktree's own `packages/*` -- meaning test runs were silently exercising the main checkout's migration files (missing migration 0044) rather than this worktree's. Fixed locally (not committed -- `node_modules/` is gitignored) by creating `node_modules/@mega-crm/*` symlinks inside the worktree pointing at the worktree's own `packages/*`/`apps/*`, shadowing the main checkout per Node's resolution order. This is environment scaffolding only; no source files were affected.
- **Pre-existing, out-of-scope test-isolation flake under the full-repo `npm run coverage` aggregate run:** `apps/worker/src/queues/__tests__/flow-segment-trigger.test.ts` fails 4/8 tests (a plain `TypeError`, unrelated to any RLS error class) when run as part of the monorepo-wide `npm run coverage`, but passes 8/8 reliably in isolation and as part of the full `apps/worker` suite (125/125). Root-caused as unrelated to this plan (migration 0044 never touches the `flows_scan`/`segments` scan-role policies this worker's discovery path reads, and the failure signature has zero RLS-error fingerprint) and documented in `deferred-items.md` rather than fixed, per the Scope Boundary rule. Every suite this plan's own `<verification>` block enumerates individually passes 100% cleanly.

## User Setup Required

None -- migration 0044 applies through the normal migration chain (`npm run db:migrate` in dev, `ensureTestDbMigrated()` in tests); no new environment variables, no operator action required.

## Next Phase Readiness

- SEC-03/SEC-04 are fully closed: all 22 tenant tables share one fail-closed, role-scoped predicate; the pinned baseline test proves the thrown-error contract directly; the two pre-tenant lookup paths (API-key auth, webhook receipt) continue to work through a documented, provably-non-privileged sentinel mechanism.
- The prohibition ("MUST NOT convert any currently fail-closed policy to the null-tolerating fail-open variant") holds by construction: the migration only ever removes NULLIF/missing_ok, never adds it, and the catalog test would fail immediately if a future migration reintroduced either.
- Any FUTURE tenant-scoped table should follow the same predicate from its first migration (bare cast, no `missing_ok`, explicit `TO mega_crm_app`) -- the catalog test's "exactly 22" assertion will need updating (and will visibly fail, by design) the day a 23rd table is added, forcing a deliberate choice rather than a silent gap.
- No blockers for continuing the phase's remaining plans.

## Self-Check: PASSED

- FOUND: packages/db/migrations/0044_workspace_isolation_fail_closed.sql
- FOUND: packages/db/migrations/meta/_journal.json (modified, idx 44)
- FOUND: packages/tenant-context/src/index.ts (modified, withPreTenantLookup)
- FOUND: packages/tenant-context/src/__tests__/tenant-context.test.ts (modified)
- FOUND: packages/tenant-context/src/__tests__/scan.test.ts (modified)
- FOUND: apps/api/src/modules/api-keys/api-keys.repository.ts (modified)
- FOUND: apps/api/src/modules/api-keys/__tests__/api-key-auth.test.ts (modified)
- FOUND: apps/api/src/modules/webhooks/webhook-endpoint.repository.ts (modified)
- FOUND: apps/api/src/modules/webhooks/__tests__/webhooks-signature.test.ts (modified)
- FOUND: apps/api/src/middleware/tenant-context.ts (modified)
- FOUND: apps/api/src/modules/events/__tests__/events-api.test.ts (modified)
- FOUND: packages/db/src/partitions/ensure-partitions.ts (modified)
- FOUND: SPECIFICATION.md (modified)
- FOUND commit: 762c161
- FOUND commit: 355a6e4
- FOUND commit: ebf6b24

---
*Phase: 10-tenant-isolation-trust-boundaries*
*Completed: 2026-08-07*
