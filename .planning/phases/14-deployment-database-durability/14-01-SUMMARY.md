---
phase: 14-deployment-database-durability
plan: 01
subsystem: database
tags: [drizzle-orm, postgres, pg, fastify, bullmq, advisory-lock, healthcheck, readiness]

requires: []
provides:
  - "packages/db/src/migration-journal.ts: assertMigrationsCurrent/findPendingMigrations/readShippedMigrations/readAppliedMigrations, resolved against drizzle-orm@0.45.2's own migrator source (timestamp-cutoff pending detection, not hash-set membership)"
  - "scripts/migrate-runner.mjs + npm run migrate:prod: the one-shot production migrate step (dedicated pg.Client, bounded pg_try_advisory_lock retry, drizzle-orm's own migrate())"
  - "apps/api GET /healthz (pure liveness) and GET /readyz (Postgres + Redis + migration-currency, exact body shape below)"
  - "apps/api onRequest guard: refuses every non-health route with 503 until migration currency is confirmed once (DB-06)"
  - "packages/test-support/src/db-fixture.ts now writes drizzle's own __drizzle_migrations journal, not just its private _test_migrations_applied table -- every test database in the monorepo now answers assertMigrationsCurrent correctly"
affects: ["14-02", "14-05", "14-08", "14-09", "any future plan touching apps/api/src/server.ts, apps/worker health surface, or the migrate/deploy path"]

tech-stack:
  added: []
  patterns:
    - "One definition of 'applied migration', shared by every writer (migrate-runner.mjs, packages/test-support's db-fixture.ts) and every reader (/readyz, the onRequest guard) -- packages/db/src/migration-journal.ts"
    - "Dedicated-connection advisory lock (never a pooled connection) for one-shot mutual exclusion"
    - "Bounded readiness checks (withTimeout wrapper) so a hung backing-service connection cannot hang /readyz itself"

key-files:
  created:
    - packages/db/src/migration-journal.ts
    - scripts/migrate-runner.mjs
    - apps/api/src/modules/ops/health.ts
    - packages/db/src/__tests__/migration-journal.test.ts
    - packages/db/src/__tests__/migrate-runner-advisory-lock.test.ts
    - apps/api/src/modules/ops/__tests__/healthz.test.ts
  modified:
    - packages/db/src/index.ts
    - apps/api/src/server.ts
    - apps/api/src/modules/ops/__tests__/readyz.test.ts
    - apps/api/src/modules/campaigns/campaign-queues.ts
    - packages/test-support/src/db-fixture.ts
    - apps/api/src/__tests__/negative-cross-tenant.test.ts
    - package.json / package-lock.json

key-decisions:
  - "drizzle-orm@0.45.2's migrator uses a TIMESTAMP-CUTOFF comparison (max applied created_at vs each shipped entry's when), not hash-set membership -- resolved RESEARCH.md assumption A4 by reading node_modules/drizzle-orm/pg-core/dialect.js directly, not from docs prose"
  - "MIGRATION_ADVISORY_LOCK_KEY = 1_405_001 (versioned, must never change without a migration-window plan); default retry budget 10 attempts * 3s = 30s, comfortably longer than the real ~1-2s full-chain apply time, short enough to fail inside a deploy window"
  - "checkRedis/checkPostgres wrapped in a 2s withTimeout -- discovered mid-task that campaignKickoffQueue.client never resolves or rejects while the underlying connection retries forever, which would have hung /readyz rather than reporting 503"
  - "packages/test-support/src/db-fixture.ts now mirrors drizzle's own __drizzle_migrations journal (same schema/table/hash/created_at shape) alongside its pre-existing _test_migrations_applied bookkeeping -- without this, every test database in the monorepo looked permanently un-migrated to assertMigrationsCurrent"

patterns-established:
  - "Any future writer of migration state (a new test fixture, a new bootstrap script) MUST also write drizzle's own journal, not just its own tracking table -- packages/db/src/migration-journal.ts is the single source of truth readers trust"
  - "Readiness/liveness checks against backing services must always be wall-clock-bounded (withTimeout), never a bare await on a client that might retry forever"

requirements-completed: [DB-05, DB-06, OPS-04, OPS-05]

coverage:
  - id: D1
    description: "One-shot migrate runner (scripts/migrate-runner.mjs, npm run migrate:prod): dedicated pg.Client, bounded pg_try_advisory_lock retry, drizzle-orm's own migrate(), never falls through to migrating on lock failure"
    requirement: "DB-05"
    verification:
      - kind: integration
        ref: "packages/db/src/__tests__/migrate-runner-advisory-lock.test.ts#migrate-runner.mjs: exactly-once under real concurrency"
        status: pass
      - kind: integration
        ref: "packages/db/src/__tests__/migrate-runner-advisory-lock.test.ts#migrate-runner.mjs: loud failure when the lock is held by a foreign session"
        status: pass
      - kind: manual_procedural
        ref: "node scripts/migrate-runner.mjs run twice against a fresh manually-provisioned database via psql -- exit 0 both times, journal has exactly 62 rows after either run"
        status: pass
    human_judgment: false
  - id: D2
    description: "One shared definition of 'applied' (packages/db/src/migration-journal.ts) resolved against drizzle-orm@0.45.2's actual migrator source, consumed identically by the runner and /readyz"
    requirement: "DB-05"
    verification:
      - kind: unit
        ref: "packages/db/src/__tests__/migration-journal.test.ts#findPendingMigrations (pure)"
        status: pass
      - kind: integration
        ref: "packages/db/src/__tests__/migration-journal.test.ts#assertMigrationsCurrent against a genuinely never-migrated database"
        status: pass
    human_judgment: false
  - id: D3
    description: "GET /healthz: pure process liveness, zero I/O, 200 regardless of Postgres/Redis reachability"
    requirement: "OPS-04"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/ops/__tests__/healthz.test.ts#GET /healthz: independent of Postgres"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/ops/__tests__/healthz.test.ts#GET /healthz: independent of Redis"
        status: pass
    human_judgment: false
  - id: D4
    description: "GET /readyz: Postgres + Redis + migration-currency, 503 naming the failing check(s), 200 only when all three pass"
    requirement: "OPS-05"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/ops/__tests__/readyz.test.ts#GET /readyz: an un-migrated database refuses readiness, the runner makes it ready"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/ops/__tests__/readyz.test.ts#GET /readyz: per-check 503 responses name the failing check"
        status: pass
    human_judgment: false
  - id: D5
    description: "onRequest fail-closed guard: refuses every non-health route with 503 until migrations are confirmed current exactly once per process lifetime; never blocks /healthz or /readyz; invisible once confirmed"
    requirement: "DB-06"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/ops/__tests__/readyz.test.ts#onRequest guard (DB-06): refuses non-health traffic until migrations are current"
        status: pass
      - kind: integration
        ref: "apps/api/src/__tests__ full suite (472 tests) -- confirms the guard does not break any pre-existing route"
        status: pass
    human_judgment: false

duration: ~3h
completed: 2026-08-13
status: complete
---

# Phase 14 Plan 01: Migration Runner + Health/Readiness Summary

**One shared "applied migration" definition (resolved against drizzle-orm@0.45.2's actual source, not docs) drives a dedicated-connection advisory-lock migrate runner, `/healthz`+`/readyz` on the API, and a fail-closed onRequest guard — closing a cross-workspace test-fixture gap along the way that would have 503'd the entire existing suite.**

## Performance

- **Duration:** ~3h
- **Tasks:** 3 (Task 1 tracer, Task 2 concurrency/failure tests, Task 3 guard + liveness independence)
- **Files created:** 6
- **Files modified:** 8

## Accomplishments

- **A4 resolved from source, not docs:** read `node_modules/drizzle-orm/pg-core/dialect.js` directly and confirmed drizzle-orm@0.45.2's migrator decides "pending" by a **timestamp-cutoff comparison** (max applied `created_at` vs. each shipped journal entry's `when`), never by hash-set membership. The `hash` column it writes is forensic-only and is never read back for the pending decision. `packages/db/src/migration-journal.ts` reuses this exact mechanism so `/readyz` and the runner can never disagree with drizzle's own definition of "applied".
- **One-shot migrate runner** (`scripts/migrate-runner.mjs`, `npm run migrate:prod`): opens exactly one dedicated `pg.Client` (never a `Pool`), takes `pg_try_advisory_lock` in a bounded retry loop (`MIGRATION_ADVISORY_LOCK_KEY = 1_405_001`, 10 attempts × 3s = 30s default budget — chosen because the full 62-migration chain applies in well under a second, so 30s comfortably absorbs a slow deploy without hanging one indefinitely), calls drizzle-orm's own `migrate()`, releases and closes. Never falls through to migrating after a failed lock acquisition; never uses the blocking `pg_advisory_lock` form (grep-asserted in tests).
- **`GET /healthz`** (`apps/api/src/modules/ops/health.ts`): zero I/O, 200 always — proven independent of both Postgres and Redis via closed-port tests.
- **`GET /readyz`**: runs three named checks (postgres/redis/migrations) via `Promise.all`, returns `{ ready: boolean, checks: [{ name, ok, detail? }] }`, 200 only when all three pass, 503 with the failing check(s) named otherwise. Each check is wall-clock-bounded (`withTimeout`, 2s) — discovered during Task 3 that the naive `await campaignKickoffQueue.client` hangs forever while the underlying Redis connection keeps retrying, which would have hung the whole endpoint rather than reporting 503.
- **onRequest fail-closed guard** (DB-06): every non-health route refuses with 503 (`{ready:false, error:"migrations_pending", detail}`) until migration currency has been confirmed exactly once for the process's lifetime; the confirmation is memoized and latched permanently on success, cleared on failure so the next request retries. Deliberately migration-only (never Postgres-in-general, never Redis) — widening it would make every existing integration suite depend on a live Redis for routes that never touch it.
- **Cross-workspace test-fixture gap found and fixed:** `packages/test-support/src/db-fixture.ts`'s `ensureTestDbMigrated()` (used by ~150+ test files across `apps/api`, `apps/worker`, `packages/db`, `packages/delivery-core`, `packages/tenant-context`) applied raw migration SQL and tracked "applied" only in its own private `_test_migrations_applied` table — it never wrote to drizzle's own `"drizzle"."__drizzle_migrations"` journal. The instant the guard/readiness check started reading that journal, every fixture-migrated test database looked permanently un-migrated, and `npx vitest run --root apps/api` went from 472 passing to 268 failing. Fixed by making the fixture also write the real journal (same schema/table/columns, using each migration's actual `meta/_journal.json` `when` value) — re-verified clean across all five affected workspaces (apps/api 472, apps/worker 553, packages/db 144, packages/test-support 116, packages/delivery-core 161, packages/tenant-context 25).

## Task Commits

1. **Task 1: End-to-end tracer — migration runner + /healthz + /readyz** — `d5c893d` (feat)
   - **Lockfile sync follow-up** — `06d8a43` (chore) — `npm install` after adding `drizzle-orm`/`@mega-crm/db` to root `devDependencies`
2. **Task 2: Exactly-once under concurrency, loud failure on lock exhaustion** — `991edb3` (test) — no changes to `migrate-runner.mjs` were needed; Task 1's implementation already satisfied every DB-05 behavior this task pins
3. **Task 3: Fail-closed guard (DB-06) + liveness independence (OPS-04)** — `3e4b96e` (feat)

_No separate plan-metadata commit — SUMMARY.md is committed directly per this worktree's repo-specific rules (`.planning/` is gitignored here)._

## Files Created/Modified

- `packages/db/src/migration-journal.ts` — the one shared "applied" definition
- `packages/db/src/index.ts` — re-exports the migration-journal module
- `scripts/migrate-runner.mjs` — the one-shot migrate step
- `apps/api/src/modules/ops/health.ts` — `/healthz`, `/readyz`, `checkReadiness`, `ensureMigrationsCurrentOnce`
- `apps/api/src/server.ts` — registers the health routes + the onRequest guard
- `apps/api/src/modules/campaigns/campaign-queues.ts` — added missing `.on("error", ...)` listeners (Rule 2)
- `packages/test-support/src/db-fixture.ts` — now also writes drizzle's own journal (Rule 1, cross-workspace)
- `apps/api/src/__tests__/negative-cross-tenant.test.ts` — documented exclusion for the new unauthenticated ops module
- `packages/db/src/__tests__/migration-journal.test.ts`, `migrate-runner-advisory-lock.test.ts` — Tests 2-5, DB-05 concurrency/failure pins
- `apps/api/src/modules/ops/__tests__/readyz.test.ts`, `healthz.test.ts` — the full readiness/liveness/guard test matrix
- `package.json` / `package-lock.json` — `migrate:prod` script; `drizzle-orm`/`@mega-crm/db` added to root `devDependencies` (needed by the plain-`node`-executed `migrate-runner.mjs`)

## Decisions Made

- **A4 (pending-detection mechanism):** timestamp-cutoff, not hash-set membership — resolved by reading `node_modules/drizzle-orm/pg-core/dialect.js` at the pinned 0.45.2 version directly, per the plan's explicit instruction to verify against installed source rather than documentation prose.
- **Redis reachability probe uses `info()`, not `ping()`:** BullMQ's adapter-agnostic `IRedisClient` interface declares `info()` but not `ping()`; `info()` still requires a real round-trip, so the semantic is identical.
- **`checkRedis`/`checkPostgres` wrapped in a 2s timeout:** not in the original plan text, but load-bearing — without it `/readyz` hangs rather than reporting 503 when Redis is down (Rule 1 fix, found by this task's own test).
- **Test fixture now writes the real drizzle journal:** the only way to keep `assertMigrationsCurrent` as the single source of truth for "applied" across BOTH production (migrate-runner.mjs) and test infrastructure (db-fixture.ts) without inventing a second comparison mechanism (Rule 1 fix, cross-workspace).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `checkRedis`/`checkPostgres` could hang `/readyz` indefinitely**
- **Found during:** Task 3 (Redis-down `/readyz` test)
- **Issue:** `await campaignKickoffQueue.client` never resolves nor rejects while ioredis is still retrying an unreachable connection (retries forever by BullMQ's own required `maxRetriesPerRequest: null`) — the test timed out at 20s instead of getting a 503.
- **Fix:** Added a `withTimeout` wrapper (2s, versioned constant with rationale) around both `checkPostgres` and `checkRedis`.
- **Files modified:** `apps/api/src/modules/ops/health.ts`
- **Verification:** `readyz.test.ts`'s Redis-down and Postgres-down cases now resolve well under the timeout, both pass.
- **Committed in:** `3e4b96e` (Task 3 commit)

**2. [Rule 2 - Missing Critical] `campaignKickoffQueue`/`emailBroadcastQueue` had no error listener**
- **Found during:** Task 3 (Redis-down `/healthz` test)
- **Issue:** BullMQ's `QueueBase` forwards the underlying ioredis connection's `error` events via `this.emit('error', ...)`; Node's `EventEmitter` throws when an `error` event has zero listeners. Neither queue had one — an unreachable Redis would have crashed the whole `apps/api` process on the very first connection failure. Every other Redis client in this codebase already carries this listener (CR-03 precedent).
- **Fix:** Added `.on("error", scrubbedConsole.error)` to both queues.
- **Files modified:** `apps/api/src/modules/campaigns/campaign-queues.ts`
- **Verification:** `healthz.test.ts`'s Redis-down scenario no longer crashes the test process.
- **Committed in:** `3e4b96e` (Task 3 commit)

**3. [Rule 1 - Bug, cross-workspace] Test fixture never wrote drizzle's own migration journal**
- **Found during:** Task 3 (first full `npx vitest run --root apps/api` after adding the guard — 268/472 tests failed)
- **Issue:** `packages/test-support/src/db-fixture.ts`'s `ensureTestDbMigrated()` tracks "applied" only in its own `_test_migrations_applied` table; `assertMigrationsCurrent` (now consumed by both `/readyz` and the new guard) reads `"drizzle"."__drizzle_migrations"` and saw every fixture-migrated database as never-migrated.
- **Fix:** The fixture now also creates `"drizzle"."__drizzle_migrations"` and inserts a matching `(hash, created_at)` row per newly-applied migration, using each migration's real `meta/_journal.json` `when` value (cross-referenced from `packages/db/src/migration-journal.ts`'s `readShippedMigrations`) — mirroring exactly what drizzle-orm's own `migrate()` would have written.
- **Files modified:** `packages/test-support/src/db-fixture.ts`
- **Verification:** Re-ran the full suite for every workspace this shared fixture touches: `apps/api` (472/472), `apps/worker` (553/553), `packages/db` (144/144), `packages/test-support` (116/116), `packages/delivery-core` (161/161), `packages/tenant-context` (25/25) — all green.
- **Committed in:** `3e4b96e` (Task 3 commit)

**4. [Rule 1 - Test coverage gate] `negative-cross-tenant.test.ts`'s route-coverage assertion needed a new exclusion entry**
- **Found during:** Task 1 (first full `apps/api` run)
- **Issue:** A pre-existing test asserts every `app.register(register*Routes)` call in `server.ts` is either covered by a cross-tenant attempt case or has a documented exclusion reason. The new `registerOpsHealthRoutes` had neither.
- **Fix:** Added a documented exclusion entry explaining the routes are deliberately unauthenticated infrastructure probes (T-14-04).
- **Files modified:** `apps/api/src/__tests__/negative-cross-tenant.test.ts`
- **Committed in:** `d5c893d` (Task 1 commit)

---

**Total deviations:** 4 auto-fixed (2 Rule 1 bugs, 1 Rule 2 missing critical, 1 Rule 1 test-gate fix). One of the four (the test-fixture journal gap) had wide blast radius across the monorepo and was the most significant unplanned work in this plan — re-verified clean across six workspaces rather than assumed safe.
**Impact on plan:** All four fixes were necessary for correctness (a hanging readiness check and a crash-on-Redis-down are both worse than the bugs OPS-04/OPS-05 exist to prevent) or for the plan's own test suite to pass at all. No scope creep beyond what DB-05/DB-06/OPS-04/OPS-05 required.

## Issues Encountered

- **Cross-extension import friction (`.mjs` importing/imported-by `.ts`):** `scripts/migrate-runner.mjs` importing `@mega-crm/db/src/migration-journal.js` (mapped to `.ts` via the package's `exports` map) works fine under both plain `node` and vitest — verified empirically. The REVERSE (a `.ts` test file statically or dynamically importing a plain `.mjs` script) fails `tsc` with `TS7016` (no declaration file). Resolved by always spawning `migrate-runner.mjs` as a real child process from test files rather than importing it — which is also more faithful to what's actually under test (the exit code and the dedicated-connection lifetime).
- **Module-registry caching across scenarios in one test file:** `@mega-crm/tenant-context`'s `pool` (and other DATABASE_URL-derived singletons) are constructed once at first import in a given vitest worker/module-registry. Testing multiple distinct `DATABASE_URL`/`REDIS_URL` scenarios within one test file required `vi.resetModules()` before each scenario's `beforeAll` (precedent: `packages/test-support/src/__tests__/db-fixture-advisory-unlock.test.ts`), not just re-importing `server.js`.
- **Ordering sensitivity in the "exactly one migration query" test:** the guard's confirmed-once latch is a module-level flag — a test asserting "exactly one query across two requests" had to run as the very FIRST request-issuing test against its `app` instance, or an earlier test in the same `describe` block would have already latched it. Documented inline at the test site.

## User Setup Required

None - no external service configuration required. `migrate:prod` is a new npm script; no new env vars.

## Next Phase Readiness

- `npm run migrate:prod` exists and is proven exactly-once/loud-failure — ready for plan 14-08 (compose) and 14-09 (deploy script) to invoke as the one-shot migrate container step, per this plan's own `<output>` instruction.
- `/readyz`'s exact response shape (`{ ready: boolean, checks: [{ name: "postgres"|"redis"|"migrations", ok: boolean, detail?: string }] }`) is the contract plans 14-05, 14-08, and 14-09 consume for readiness-gated deploy waiting.
- `MIGRATION_ADVISORY_LOCK_KEY = 1_405_001` and `MIGRATION_LOCK_MAX_ATTEMPTS`/`MIGRATION_LOCK_RETRY_DELAY_MS` (overridable via env, defaults 10×3s=30s) are the constants any later plan referencing the migrate step's lock behavior should cite rather than re-derive.
- The worker (`apps/worker`) has NOT been given an equivalent health server or migration guard in this plan — that is explicitly D-14, assigned elsewhere in this phase (per ROADMAP § Phase 14 and 14-CONTEXT.md).
- **Known pre-existing gap, unrelated to this plan (confirmed via `git stash` against this plan's own baseline before Task 3):** `packages/test-support/src/__tests__/migration-lint.test.ts` imports `checkStatementBreakpointPlacement` from `scripts/lint-migrations.mjs`, which does not export it. This fails `tsc -p packages/test-support/tsconfig.json` (and therefore `npm run build --workspaces --if-present` on that one workspace) but does NOT fail any `vitest run` — confirmed pre-dating this plan's changes. Flagging for the broken-windows ledger; not fixed here (out of this plan's scope, per the deviation rules' scope boundary).

## SPECIFICATION.md items for 14-13

Per this worktree's repo-specific rules, SPECIFICATION.md filing is deferred to plan 14-13. Items to file there:

- **§2 (Зависимости и версии):** root `package.json` `devDependencies` gained `drizzle-orm` (0.45.2) and `@mega-crm/db` (0.1.0) — needed because `scripts/migrate-runner.mjs` runs via plain `node` at the repo root and imports `@mega-crm/db/src/migration-journal.js` directly (Node's native TypeScript type-stripping resolves the `.ts` file via the package's `exports` map; no new npm package, no build step).
- **§5 (Планировщик и пайплайн отправки):** new npm script `migrate:prod` → `node scripts/migrate-runner.mjs` — the one-shot production migrate step (dedicated `pg.Client`, `pg_try_advisory_lock` bounded retry key `1_405_001`, drizzle-orm's own `migrate()`).
- **§6 (Публичные точки входа):** `GET /healthz` (unauthenticated, zero I/O, pure liveness) and `GET /readyz` (unauthenticated, Postgres+Redis+migration-currency, 503/200) on `apps/api`. Both excluded from the cross-tenant negative-test coverage gate by design (T-14-04).
- **§4 (Схема данных):** no new production schema — `"drizzle"."__drizzle_migrations"` already exists as drizzle-orm's own bookkeeping table (created by `migrate()` itself); this plan did not add a migration file.
- **Not yet filed / not applicable this plan:** the worker's own health server (D-14) — a later plan in this phase.

---
*Phase: 14-deployment-database-durability*
*Completed: 2026-08-13*
