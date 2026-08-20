---
phase: 08-quality-gates-failure-injection-foundation
plan: 09
subsystem: database
tags: [migrations, postgres, rls, partitioning, ephemeral-database, vitest]

requires:
  - phase: 08-06
    provides: the consolidated db-fixture whose migration loop this factors out, and the ephemeral-database provisioning both runs use
provides:
  - packages/test-support/src/migration-runner.ts — the one migration-application mechanism, shared by the fixture and the tests
  - packages/db test lane (vitest.config.ts + test script) with its own ephemeral database
  - Run A — the whole chain against an empty database, asserting schema and RLS posture
  - Run B — the incremental chain over seeded data, with both vacuous-green defenses
  - npm run test:migrations
affects: [08-18, phase-09-partition-automation, phase-11-delivery-state-machine]

tech-stack:
  added: [vitest@4.1.9 declared in packages/db, "@mega-crm/test-support@0.1.0 linked into packages/db"]
  patterns:
    - "A test that provisions its own ephemeral database when it needs a guaranteed-empty starting point, rather than reusing globalSetup's already-migrated one"
    - "Migration-application primitives return the applied filename list, so callers can assert the run was not vacuous"
    - "DDL and tenant-scoped work use separate pools — a connection recycled from a scoped transaction cannot run un-scoped queries against variant-A RLS tables"

key-files:
  created:
    - packages/test-support/src/migration-runner.ts
    - packages/test-support/src/__tests__/migration-runner.test.ts
    - packages/db/vitest.config.ts
    - packages/db/src/__tests__/migrate-from-empty.test.ts
    - packages/db/src/__tests__/migrate-incremental.test.ts
  modified:
    - packages/test-support/src/db-fixture.ts
    - packages/test-support/src/index.ts
    - packages/db/package.json
    - package.json
    - SPECIFICATION.md

key-decisions:
  - "The zero-padded filename convention is enforced in listMigrationFiles rather than documented in a comment — by the time the sorted list is returned, the information needed to detect a misordering is gone"
  - "Checkpoint is the NAMED file 0035_csv_imports_default_timezone.sql, not an index or a count: the directory keeps growing and 'everything after this release' stays correct as it does"
  - "Run A derives the RLS assertion from the schema (any table carrying workspace_id) rather than a hard-coded list, so future tables are covered without editing the test"
  - "Partitions are asserted separately, at the parent, because that is the access path the application actually uses"
  - "Deliberately not drizzle-kit snapshot diffing: only 11 of 38 migrations have a snapshot, so that baseline covers under a third of the chain while appearing to cover all of it"

patterns-established:
  - "packages/db has a test lane; migration-level assertions live there rather than leaking into app workspaces"
  - "Destructive-DDL proofs are written to a temp directory and applied at test time, never committed into packages/db/migrations"

requirements-completed: [QG-05]

coverage:
  - id: D1
    description: "The full migration chain applies to a guaranteed-empty database, and produces the schema rather than merely not throwing"
    requirement: QG-05
    verification:
      - kind: integration
        ref: "packages/db/src/__tests__/migrate-from-empty.test.ts — 4 tests, exit 0"
        status: pass
    human_judgment: false
  - id: D2
    description: "Every tenant-scoped table ends the chain with RLS both ENABLED and FORCED; partitions are protected at their parent"
    requirement: QG-05
    verification:
      - kind: integration
        ref: "migrate-from-empty.test.ts#leaves RLS enabled AND forced on every tenant-scoped table; #protects partitioned tables at the parent"
        status: pass
    human_judgment: false
  - id: D3
    description: "The incremental chain applies over a database already holding rows, preserving every seeded row"
    requirement: QG-05
    verification:
      - kind: integration
        ref: "packages/db/src/__tests__/migrate-incremental.test.ts — 5 tests, exit 0"
        status: pass
    human_judgment: false
  - id: D4
    description: "Neither run can pass vacuously — run B asserts ≥1 migration applied after the checkpoint and asserts the seeds actually landed before concluding anything from them"
    requirement: QG-05
    verification:
      - kind: integration
        ref: "migrate-incremental.test.ts#applies at least one migration after the checkpoint; #actually seeded rows — RLS did not silently swallow the inserts"
        status: pass
    human_judgment: false
  - id: D5
    description: "A NOT NULL column with no DEFAULT is proven to be rejected against a populated table"
    requirement: QG-05
    verification:
      - kind: integration
        ref: "migrate-incremental.test.ts#rejects a NOT NULL column with no DEFAULT against the populated sends table"
        status: pass
    human_judgment: false
  - id: D6
    description: "Filename ordering is defended at its source — listMigrationFiles throws on a non-zero-padded name"
    requirement: QG-05
    verification:
      - kind: unit
        ref: "packages/test-support/src/__tests__/migration-runner.test.ts — 6 tests including the 10_late-before-0009_early hazard"
        status: pass
    human_judgment: false
  - id: D7
    description: "One migration-application mechanism shared by the fixture and both tests, with no regression to the suites that used the old loop"
    verification:
      - kind: integration
        ref: "full workspace suite — 102 files / 608 tests, exit 0; npm run lint exits 0"
        status: pass
    human_judgment: false

duration: 41 min
completed: 2026-07-28
status: complete
---

# Phase 8 Plan 09: Migration Chain Verification Summary

**Thirty-eight migrations verified as a chain for the first time — from zero and incrementally over seeded data — with both runs unable to pass without doing real work, and the ordering convention enforced instead of assumed.**

## Performance

- **Duration:** 41 min
- **Started:** 2026-07-28T08:54:00Z
- **Completed:** 2026-07-28T09:35:00Z
- **Tasks:** 3
- **Files modified:** 11 (5 created, 6 modified)

## Accomplishments

- **One migration-application mechanism.** `listMigrationFiles` / `applyMigrationFile` / `applyMigrationsUpTo` / `applyRemainingMigrations` moved out of `db-fixture.ts` into `packages/test-support/src/migration-runner.ts`. The advisory lock, the tracking table and the per-process memoization stayed in the fixture — running the chain *once across concurrent processes* is a different concern from applying a file.
- **The ordering convention is now enforced.** `readdirSync().sort()` is lexicographic and agrees with numeric order only while every filename is padded. `listMigrationFiles` throws on an unpadded name, six unit tests cover it, including the concrete hazard that `10_late.sql` sorts before `0009_early.sql`.
- **Run A** applies all 38 files to a database it provisions itself — not globalSetup's, which the fixture has already migrated and where a second application would be a no-op dressed as a pass — then probes `information_schema` for the core domain tables and `pg_class` for the RLS flags.
- **Run B** migrates to a checkpoint, seeds under a tenant scope, applies the rest, and proves the destructive case by applying a temp-directory fixture migration and asserting it *rejects*.
- **`packages/db` has a test lane** with its own ephemeral database, so `npm run test --workspaces` picks both runs up.

### Checkpoint: `0035_csv_imports_default_timezone.sql`

The last migration of Phase 6 — the schema as it stood before the Phase 7 analytics work. Chosen because it is a **real release boundary in this repository's history** (git shows `0026`–`0035` landing under `feat(06-*)` and `0036` as the first `feat(07-*)`), and because what follows it is exactly the interesting shape: `0036` runs `ALTER TABLE sends ADD COLUMN ... integer NOT NULL DEFAULT 0` — the *safe* form of the very pattern whose unsafe form run B proves is rejected.

Named rather than computed by index, deliberately. The directory keeps growing, and "everything after this release" stays correct as it does; an index or a count would silently start meaning something else.

### Two things the runs surfaced

**1. Partitions do not carry their own RLS flags.** Run A's first version derived the RLS assertion from "any table with a `workspace_id`" and immediately failed on six relations — the partitions of `events` and `send_events`. This is how Postgres works: policies declared on a partitioned parent apply when the table is queried *through the parent*, and partitions have their own flags, off by default. No source file in this repository names a partition directly, so the access path in use is protected — but a query naming a partition **by name** would bypass tenant isolation. The posture is now pinned by a dedicated assertion (every partition's parent must be enabled and forced) instead of being an unexamined property.

**2. The variant-A RLS policies break a recycled pooled connection.** Run B failed with `invalid input syntax for type uuid: ""` and the cause turned out to be already documented in `SPECIFICATION.md` §4.3 — `set_config(..., true)` reverts at COMMIT to the *session* value, which for a custom GUC is the empty string rather than NULL, and the 12 variant-A policies then evaluate `''::uuid` and throw instead of matching nothing. **I did not discover this; I reproduced it.** What is new is the empirical demonstration: a connection recycled from a scoped transaction into un-scoped work fails, so run B holds two pools — one for DDL that is never scoped, one for the scoped inserts and counts. §4.3 gained a sentence recording that the "only read inside `withTenantTransaction`" invariant is an application-level one, and that any mixed usage on a single pool breaks it.

## Task Commits

1. **Task 1: shared migration primitives + packages/db test lane** — `54088ca` (refactor)
2. **Task 2: run A** — `f43b95a` (test)
3. **Task 3: run B** — `bc217a7` (test)

## Files Created/Modified

- `packages/test-support/src/migration-runner.ts` — the four primitives and the padded-filename guard
- `packages/test-support/src/__tests__/migration-runner.test.ts` — 6 filesystem-only tests
- `packages/test-support/src/db-fixture.ts` — `applyPendingMigrations` now calls the primitives; lock and tracking unchanged
- `packages/db/vitest.config.ts`, `packages/db/package.json` — the test lane
- `packages/db/src/__tests__/migrate-from-empty.test.ts` — run A, 4 tests
- `packages/db/src/__tests__/migrate-incremental.test.ts` — run B, 5 tests
- `package.json` — `test:migrations`
- `SPECIFICATION.md` — §2.5 (packages/db's new devDependencies), §4.3 (the pooled-connection consequence)

## Decisions Made

- **Enforce the filename convention rather than document it.** By the time a sorted list is returned, the information needed to detect a misordering is gone.
- **Provision a dedicated database for each run.** globalSetup's database has already had the chain applied.
- **Derive the RLS assertion from the schema.** Any table carrying `workspace_id` is tenant-scoped by construction, so tables added by future migrations are covered without editing the test.
- **Two pools in run B.** Not a workaround for a test bug — a direct consequence of a documented schema property.
- **No drizzle-kit diffing.** Only 11 of 38 migrations have a snapshot; a check built on that baseline would report on under a third of the chain while appearing to cover all of it.

## Deviations from Plan

### 1. [Rule 1 — Bug, in own work] The RLS probe over-reached and had to be split

- **Found during:** Task 2.
- **Issue:** The plan asks for RLS assertions on "every domain table that the RLS migrations cover". I derived the set from `workspace_id` instead, which is stronger — and it caught the six partitions, which the RLS migrations do *not* cover.
- **Fix:** Two assertions instead of one — non-partition tables must be enabled and forced; partitions must have a protected parent. The partition query also needed `relkind = 'r'`, since `pg_inherits` covers partitioned *indexes* too and their parents have `relrowsecurity` false by definition (that mistake produced 18 spurious rows before it was fixed).
- **Verification:** run A green at 4/4.
- **Committed in:** `f43b95a`

### 2. [Rule 1 — Environment] Run B's single pool tripped a documented schema defect

- **Found during:** Task 3.
- **Issue:** `invalid input syntax for type uuid: ""` while applying the post-checkpoint migrations. Root cause isolated by direct experiment: after a transaction-local `set_config` commits, the custom GUC holds `''` rather than being unset, and the variant-A policies cast it.
- **Fix:** separate pools for DDL and tenant-scoped work, with the reason written at the declaration rather than left as folklore.
- **Verification:** run B green at 5/5; the finding cross-checked against `SPECIFICATION.md` §4.3, which already described the mechanism.
- **Committed in:** `bc217a7`

### 3. [Rule 1 — Environment] `docker compose up -d --wait` in every `<verify>` block

Same as 08-08: Docker is not installed here, the native services on the same ports and DSNs were used instead, and nothing in these runs depends on the startup mechanism.

---

**Total deviations:** 2 auto-fixed, 1 environmental.
**Impact on plan:** None on scope. Both runs exist as specified, and the RLS assertion is stronger than the plan asked for.

## Issues Encountered

- **A leftover `mega_crm_test` database (147 MB) exists on this machine.** It is *not* from these runs — both clean up, and no `mega_crm_test_migrate*` database survives. It is the legacy shared test database from before 08-02 introduced per-run ephemeral databases, still named in the repo-root `.env`'s `TEST_DATABASE_URL` (which globalSetup overwrites at run time). Harmless but stale; worth dropping by hand.
- **The `globalSetup` acceptance criterion asked for `grep -c "globalSetup" packages/db/vitest.config.ts` to return 1; it returns 3** because the config comment explains why the hook is registered even though both tests provision their own databases. The config *key* appears exactly once.

## User Setup Required

None. Both runs need only the local Postgres the rest of the suite already uses, plus the `TEST_ADMIN_DATABASE_URL` added to `.env` during 08-07.

## Next Phase Readiness

- **Phase 9 (partition automation, hard deadline 2026-09-01)** now has run A as a regression net: whatever mechanism creates future partitions, the chain still has to apply from zero and leave the RLS posture intact, and the partition assertion is where a decision about partition-level RLS would have to be made explicitly.
- **08-18** should include `npm run test:migrations` (or the whole `packages/db` workspace, which `npm run test --workspaces` already covers) in the blocking job.
- **Open, unowned:** the 12 variant-A RLS policies. `0019` fixed `campaigns` this way and the rest were left, on the stated grounds that they are only read inside a tenant scope. That invariant is not enforced by anything, and run B is now a standing demonstration of what happens when it does not hold. Converting the remaining policies to the `NULLIF` form is a migration and therefore out of this plan's scope — but it is a small, mechanical, and genuinely defensive change.

---
*Phase: 08-quality-gates-failure-injection-foundation*
*Completed: 2026-07-28*
