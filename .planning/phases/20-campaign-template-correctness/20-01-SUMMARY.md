---
phase: 20-campaign-template-correctness
plan: 01
subsystem: database
tags: [drizzle, drizzle-kit, postgres, migrations, optimistic-locking]

# Dependency graph
requires:
  - phase: 14-deployment-database-durability
    provides: migration-tiers.ts classification framework, migrate-runner.mjs applier, db:check-empty-diff smoke test
provides:
  - "campaigns.version integer NOT NULL DEFAULT 1 column, declared in Drizzle schema and shipped in migration 0066"
  - "0066 classified auto-reversible in MIGRATION_TIERS with a hand-verified inverse in MIGRATION_INVERSES"
  - "campaigns.version applied to the dev database, confirmed by information_schema.columns read"
affects: [20-02, 20-03]

# Tech tracking
tech-stack:
  added: []
  patterns: [optimistic-lock version column pattern for TMPL-02, expand-only migration with COMMENT ON COLUMN contract]

key-files:
  created:
    - packages/db/migrations/0066_campaigns_version.sql
    - packages/db/migrations/meta/0066_snapshot.json
  modified:
    - packages/db/src/schema/campaigns.ts
    - packages/db/migrations/meta/_journal.json
    - packages/db/src/migration-tiers.ts
    - packages/db/src/__tests__/migration-tiers.test.ts
    - packages/db/src/__tests__/migration-rollback-rehearsal.test.ts
    - packages/db/src/__tests__/migration-empty-diff.test.ts
    - SPECIFICATION.md

key-decisions:
  - "version placed with the other integer counters (after failedCount) rather than adjacent to segmentId, matching the plan's placement instruction for 'other integer counters'"
  - "Rule 3 deviation: re-pinned migration-empty-diff.test.ts's hardcoded snapshot/journal/count assertions, which the plan's Task 2 file list omitted but which pin the exact same drift-fails-loudly invariant the plan told us to re-pin in migration-tiers.test.ts"

requirements-completed: [TMPL-02]

coverage:
  - id: D1
    description: "campaigns.version column shipped: Drizzle schema, migration 0066, snapshot, journal entry"
    requirement: "TMPL-02"
    verification:
      - kind: unit
        ref: "npm run lint:migrations"
        status: pass
      - kind: unit
        ref: "npm run db:check-empty-diff -w packages/db"
        status: pass
      - kind: unit
        ref: "npm run build -w packages/db"
        status: pass
    human_judgment: false
  - id: D2
    description: "0066 classified auto-reversible with hand-verified inverse; trailing-run pin and empty-diff pins updated to match"
    requirement: "TMPL-02"
    verification:
      - kind: unit
        ref: "npm run test:migrations (packages/db/src/__tests__/migration-tiers.test.ts, migration-rollback-rehearsal.test.ts, migration-empty-diff.test.ts)"
        status: pass
    human_judgment: false
  - id: D3
    description: "campaigns.version applied to the dev database via scripts/migrate-runner.mjs, confirmed by a read-only information_schema.columns query"
    requirement: "TMPL-02"
    verification:
      - kind: integration
        ref: "npm run migrate:prod against dev DATABASE_URL, followed by a manual information_schema.columns read"
        status: pass
    human_judgment: false

duration: 65min
completed: 2026-08-21
status: complete
---

# Phase 20 Plan 01: Campaigns Optimistic-Lock Column Summary

**Shipped `campaigns.version` (int NOT NULL DEFAULT 1) as migration 0066 — classified auto-reversible with a hand-verified inverse, applied to the dev database, and filed in SPECIFICATION.md §4.2/§4.6 in the same change.**

## Performance

- **Duration:** ~65 min
- **Started:** 2026-08-21T13:15:00Z (approx, from context load)
- **Completed:** 2026-08-21T14:20:00Z (approx)
- **Tasks:** 3 (2 committed; Task 3 is a database-state change with no file diff)
- **Files modified:** 8 (2 created, 6 modified, across both commits)

## Accomplishments

- Added `version: integer("version").notNull().default(1)` to the `campaigns` Drizzle schema (placed with the other integer counters), documented in the table's doc comment naming TMPL-02/D-05.
- Generated migration `0066_campaigns_version.sql` via `drizzle-kit generate` (CLI, no config file, no `DATABASE_URL` needed) — the only statement produced was the expected `ALTER TABLE campaigns ADD COLUMN version integer DEFAULT 1 NOT NULL`. Enriched it with a header comment (WHY the column exists, who writes it, no-backfill rationale) and a `COMMENT ON COLUMN` statement carrying the same contract into the database catalog, following the `0056_workspace_daily_rollup_dirtied_at.sql` convention.
- Normalized the generated journal entry's `when` to `1786598400003`, continuing the fixed 0063/0064/0065 sequence rather than a wall-clock timestamp.
- Classified `0066_campaigns_version` as `auto-reversible` in `MIGRATION_TIERS` and registered its hand-verified inverse (`ALTER TABLE campaigns DROP COLUMN version;`) in `MIGRATION_INVERSES`.
- Re-pinned `migration-tiers.test.ts`'s trailing-run test from the empty array to `["0066_campaigns_version"]`, with an updated comment explaining why (0066 is auto-reversible and sits after the still-forward-only 0065).
- Filed SPECIFICATION.md §4.2 (`campaigns` row gains `version`) and §4.6 (journal now 67 entries 0-66, snapshot count 15, tier classification 27/40, trailing run now one-element, `MIGRATION_INVERSES` gained its entry).
- Applied migration 0066 to the dev database via `npm run migrate:prod` (the production applier, `scripts/migrate-runner.mjs`) — never via `db:migrate`/`drizzle-kit migrate`, which is documented to hang under Node v26 in this sandbox. Confirmed by a read-only `information_schema.columns` query (see below) and by a second idempotent run (exit 0, nothing applied).

## Task Commits

Each task was committed atomically:

1. **Task 1: Add the version column to the Drizzle schema and generate migration 0066 with its snapshot** - `fbd4b4e` (feat)
2. **Task 2: Register 0066's reversibility tier and its hand-verified inverse, and re-pin the trailing-run test** - `6fc82f0` (docs)
3. **Task 3: [BLOCKING] Apply 0066 to the dev database** - no commit (database-state change only; `packages/db/migrations/0066_campaigns_version.sql` was already committed in Task 1, and `<files>` for this task lists no other file). Verified via `npm run migrate:prod` + a read-only catalog check, both recorded below.

**Plan metadata:** (this commit, made by the executor after this SUMMARY)

_Note: Task 3 intentionally produces zero file diff — it is a live database mutation, not a code change._

## Files Created/Modified

- `packages/db/src/schema/campaigns.ts` - added `version` field with doc-comment contract
- `packages/db/migrations/0066_campaigns_version.sql` - new migration, `ALTER TABLE ... ADD COLUMN` + `COMMENT ON COLUMN`
- `packages/db/migrations/meta/0066_snapshot.json` - drizzle-kit-generated snapshot, `prevId` chains from `0064_snapshot.json`
- `packages/db/migrations/meta/_journal.json` - appended entry for `0066_campaigns_version` (`when: 1786598400003`)
- `packages/db/src/migration-tiers.ts` - `MIGRATION_TIERS["0066_campaigns_version"] = "auto-reversible"`
- `packages/db/src/__tests__/migration-tiers.test.ts` - re-pinned trailing-run expectation
- `packages/db/src/__tests__/migration-rollback-rehearsal.test.ts` - added `MIGRATION_INVERSES` entry for `0066_campaigns_version`
- `packages/db/src/__tests__/migration-empty-diff.test.ts` - re-pinned three hardcoded assertions (snapshot filename, shipped/snapshot counts, newest journal tag) that the plan's Task 2 file list omitted (Rule 3)
- `SPECIFICATION.md` - §4.2 `campaigns` row, §4.6 journal/snapshot/tier-count narrative

## Decisions Made

- **Column placement:** `version` was placed with the other integer counters (`sentCount`, `failedCount`, ...) rather than immediately after `segmentId`, per the plan's instruction to place it "with the other integer counters."
- **Rule 3 (auto-fix blocking issue):** `packages/db/src/__tests__/migration-empty-diff.test.ts` was not in the plan's Task 2 `<files>` list, but it hardcodes exactly the same class of drift-detecting pin the plan explicitly told us to re-pin in `migration-tiers.test.ts` (comparedAgainstSnapshot, shippedMigrationCount, snapshotFileCount, newest journal tag, newest snapshot file). Leaving it unpinned would have left `npm run test:migrations` red without any ambiguity about whether the code or the test was wrong — the counts are objectively stale once 0066 ships. Re-pinned to `0066_snapshot.json` / 67 / 15 / `"0066_campaigns_version"`, all values independently confirmed by `npm run db:check-empty-diff -w packages/db`'s own live output before editing.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Re-pinned `migration-empty-diff.test.ts`'s hardcoded assertions**
- **Found during:** Task 2 (`npm run test:migrations` full run)
- **Issue:** The plan's Task 2 `<files>` list named `migration-tiers.ts`, `migration-tiers.test.ts`, `migration-rollback-rehearsal.test.ts`, and `SPECIFICATION.md`, but omitted `migration-empty-diff.test.ts`, which independently hardcodes the newest-snapshot filename, shipped-migration count, snapshot-file count, and newest-journal-tag — all of which shift by exactly the same amount that migration 0066 shifts the counts the plan DID tell us to re-pin.
- **Fix:** Updated the three assertions (and their explanatory comments, in the file's own voice) to `0066_snapshot.json` / `67` / `15` / `"0066_campaigns_version"`.
- **Files modified:** `packages/db/src/__tests__/migration-empty-diff.test.ts`
- **Verification:** `npm run test:migrations` — 30 files, 246 passed, 1 skipped (the expected rehearsal-empty-run skip case does not apply since the trailing run is now non-empty).
- **Committed in:** `6fc82f0` (Task 2 commit)

**2. [Environment finding, not a code deviation] Worktree lacks its own `node_modules`; bare-specifier imports resolve to the main checkout**
- **Found during:** Task 2 (`npm run test:migrations` first run showed `migrate-runner-advisory-lock.test.ts` and `migration-rollback-rehearsal.test.ts` failing with counts/columns from a 66-migration chain, despite the worktree's own journal correctly showing 67 entries)
- **Root cause:** This worktree has no local `node_modules`. Any test or script that imports a workspace package via a bare specifier (`@mega-crm/db/src/migration-journal.js`, `@mega-crm/test-support`) resolves through Node's upward `node_modules` search, which finds `/Users/primeropanther/Projects/mega-crm/node_modules` (the MAIN checkout, not this worktree) and follows its `@mega-crm/db -> ../../packages/db` symlink there — landing on the main checkout's `packages/db/migrations` (66 entries, no 0066), not this worktree's copy (67 entries). Relative imports (e.g. `../migration-tiers.js` inside a test file) are unaffected, which is why `migration-tiers.test.ts`'s own re-pin passed on the first try while the runner-spawning tests did not.
- **Fix (verification-only, not committed):** Created a worktree-local shim — `node_modules/@mega-crm/db -> ../../packages/db` (relative symlink, from the worktree root) — so `DRIZZLE_MIGRATIONS_FOLDER` (derived from the resolved file's own path inside `migrate-runner.mjs`) points at this worktree's migrations. This shadows only `@mega-crm/db`; all other packages (`pg`, `drizzle-orm`, `vitest`, etc.) still resolve via the main checkout's `node_modules`, since Node's resolution tries each ancestor `node_modules` per-package, not first-found-wins-for-everything. Re-ran `migration-rollback-rehearsal.test.ts` and `migrate-runner-advisory-lock.test.ts` — both passed with the shim in place. Kept the shim through Task 3 (`npm run migrate:prod` has the identical resolution dependency) and **removed it before finishing** (`rm node_modules/@mega-crm/db`; `node_modules` no longer exists in the worktree, confirmed by `ls node_modules` erroring and a clean `git status --short`).
- **Files modified:** none (shim lived entirely under `node_modules/`, never staged or committed)
- **Verification:** `npm run test:migrations` green (30 files, 246 passed, 1 skipped) with the shim in place; `git status --short` clean after its removal.

---

**Total deviations:** 1 auto-fixed (Rule 3, test file omitted from plan) + 1 environment finding (documented, not a code change).
**Impact on plan:** Both were necessary to get an honest green `test:migrations` result rather than a false pass/fail driven by worktree package-resolution quirks. No scope creep beyond the plan's own stated goal.

## Issues Encountered

- See the environment finding above (worktree `node_modules` resolution). This is specific to how this executor's worktree was provisioned (no local `node_modules`) and is not expected to recur once this branch is merged into a checkout with its own install — `npm run migrate:prod` and `npm run test:migrations` will resolve `@mega-crm/db` to the same tree as everything else at that point.

## Read-only catalog verification (Task 3)

```
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_name = 'campaigns' AND column_name = 'version';

column_name | data_type | is_nullable | column_default
version     | integer   | NO          | 1
```

`npm run migrate:prod` output: `migrate-runner: all pending migrations applied (or none were pending)` — run twice, both times exit 0, confirming idempotency. No `UPDATE`, `INSERT`, or ad-hoc DDL was run against the dev database beyond the shipped migration itself. `db:migrate` / `drizzle-kit migrate` was NOT used, per the documented sandbox hang under Node v26 (`.planning/STATE.md` operational prerequisites) — `scripts/migrate-runner.mjs` (the same applier production uses) was used instead.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `campaigns.version` exists in the Drizzle schema, the shipped migration chain, the reversibility registries, and the dev database — plan 20-02 (which adds `expectedVersion` to the launch/schedule/test-send zod schemas and the `version_conflict` repository error) can proceed without any schema prerequisite gaps.
- No blockers. The worktree `node_modules` resolution quirk documented above is environment-specific to this executor's setup and does not affect the shipped code.

## Self-Check: PASSED

All created/modified files confirmed present on disk (`packages/db/migrations/0066_campaigns_version.sql`, `packages/db/migrations/meta/0066_snapshot.json`, `packages/db/src/schema/campaigns.ts`, `packages/db/src/migration-tiers.ts`, `SPECIFICATION.md`, this SUMMARY). All task commits confirmed present in `git log` (`fbd4b4e`, `6fc82f0`).

---
*Phase: 20-campaign-template-correctness*
*Completed: 2026-08-21*
