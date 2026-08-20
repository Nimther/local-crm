---
phase: 11-delivery-correctness
plan: 02
subsystem: database
tags: [drizzle, postgres, migrations, enum, rls, row-level-security, vitest]

# Dependency graph
requires:
  - phase: 11-delivery-correctness (plan 11-01)
    provides: "SEND_STATUSES / SEND_STATUS_TRANSITIONS executable state machine in @mega-crm/delivery-core, the source of truth this plan's Drizzle enum must match"
provides:
  - "Two standalone send_status enum-add migrations (0047/0048: reconciling, unknown) and the additive sends.reconciling_since/dispatched_at/dispatch_duration_ms columns + two indexes (0049)"
  - "send_reconciler_runs singleton health table (0050), seeded, mirroring partition_maintenance_runs"
  - "Drizzle schema parity (sends.ts sendStatusEnum, send-reconciler-runs.ts) with a live-database-checked test proving schema/delivery-core/Postgres agree"
  - "npm run db:audit-sends-history — read-only cross-tenant history report via a second SCAN_DATABASE_URL connection"
affects: [11-03, 11-04, 11-05, 11-06, 11-07, 11-08]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Standalone enum-add migration files (Phase 8 D-30 linter-enforced): a migration that adds an ALTER TYPE ... ADD VALUE must contain no other statement referencing that literal"
    - "Operator CLI scripts needing a cross-tenant read build their own second Pool from SCAN_DATABASE_URL directly (bypassing @mega-crm/tenant-context), mirroring how relocate-default-partition-rows.ts builds its own admin pool from PARTITION_RELOCATION_ADMIN_DATABASE_URL"
    - "Rollback-only per-workspace transaction (BEGIN + SET LOCAL app.current_workspace_id + always ROLLBACK) as a structural read-only guarantee for an operator script that must never write, without importing the app's tenant-context helper"

key-files:
  created:
    - packages/db/migrations/0047_send_status_reconciling.sql
    - packages/db/migrations/0048_send_status_unknown.sql
    - packages/db/migrations/0049_send_reconciliation_columns.sql
    - packages/db/migrations/0050_send_reconciler_runs.sql
    - packages/db/src/schema/send-reconciler-runs.ts
    - packages/db/scripts/audit-sends-history.ts
    - packages/db/src/__tests__/send-status-enum-parity.test.ts
    - apps/worker/src/queues/__tests__/rollup-enum-migration-invariant.test.ts
  modified:
    - packages/db/src/schema/sends.ts
    - packages/db/src/index.ts
    - packages/db/package.json
    - package.json
    - SPECIFICATION.md

key-decisions:
  - "Enum-parity test lives in packages/db and imports SEND_STATUSES from @mega-crm/delivery-core (added as a packages/db devDependency) rather than re-declaring the six-value list, per the prior wave's explicit instruction that there is exactly one source of truth for the vocabulary."
  - "audit-sends-history.ts deviates from the plan's literal single-DATABASE_URL design (Rule 3, documented below) -- uses a second SCAN_DATABASE_URL connection for the sends/organization aggregates and a manual rollback-only per-workspace loop for the send_events-dependent counts, introducing no new grant or migration."

requirements-completed: []  # See 'Deviations from Plan' -- DLV-02/DLV-03/DLV-09 are NOT complete after this plan alone; intentionally left unmarked in REQUIREMENTS.md.

coverage:
  - id: D1
    description: "Two standalone send_status enum-add migrations (reconciling, unknown) apply cleanly, add zero historical-row changes, and pass the migration linter's enum-add-value-used-same-file rule"
    requirement: "DLV-02"
    verification:
      - kind: unit
        ref: "npm run lint:migrations (exit 0, 51 files checked)"
        status: pass
      - kind: integration
        ref: "npm run db:migrate against the dev database; enum_range(NULL::send_status) verified live to equal the six-value set"
        status: pass
    human_judgment: false
  - id: D2
    description: "sends gains reconciling_since/dispatched_at/dispatch_duration_ms (all nullable, no backfill) plus sends_status_queued_at_idx and the partial sends_reconciling_since_idx"
    requirement: "DLV-09"
    verification:
      - kind: integration
        ref: "information_schema.columns / pg_indexes verified live against the dev database after migration 0049"
        status: pass
    human_judgment: false
  - id: D3
    description: "send_reconciler_runs singleton health table exists, seeded with an epoch dead-man's-switch row, mirroring partition_maintenance_runs's no-RLS-by-design shape"
    requirement: "DLV-03"
    verification:
      - kind: integration
        ref: "to_regclass('send_reconciler_runs') and SELECT count(*) FROM send_reconciler_runs WHERE id = 1 verified live"
        status: pass
    human_judgment: false
  - id: D4
    description: "Drizzle's sendStatusEnum, delivery-core's SEND_STATUSES, and the live database's enum_range are all set-equal -- schema/code/DB cannot silently drift apart"
    verification:
      - kind: unit
        ref: "packages/db/src/__tests__/send-status-enum-parity.test.ts (4 tests, ephemeral migrated database)"
        status: pass
    human_judgment: false
  - id: D5
    description: "reconcileWorkspaceDay is fact-column-driven, not status-driven -- a bare reconciling/unknown row moves no rollup count, while an unknown row with a populated fact column still contributes (deliberately, pinned by test)"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/rollup-enum-migration-invariant.test.ts (2 tests)"
        status: pass
    human_judgment: false
  - id: D6
    description: "npm run db:audit-sends-history reports per-status/per-kind sends counts, failed-with-vs-without-send_events evidence, and orphaned send_events counts, provably making zero writes"
    verification:
      - kind: unit
        ref: "npm run db:audit-sends-history (exit 0); write-keyword source scan (exit 0); two consecutive runs produce identical output"
        status: pass
    human_judgment: false

# Metrics
duration: 28min
completed: 2026-08-09
status: complete
---

# Phase 11 Plan 02: Send Status Schema Expansion (Enum, Columns, Reconciler Health Table) Summary

**Two standalone `send_status` enum migrations (`reconciling`/`unknown`), additive `sends` duration/reconciliation columns with a reconciler-discovery index, a `send_reconciler_runs` health table, and a live-database enum-parity test tying Drizzle, `@mega-crm/delivery-core`, and Postgres to one source of truth.**

## Performance

- **Duration:** 28 min
- **Started:** 2026-08-09T09:53:00Z (approx, immediately after 11-01's closeout)
- **Completed:** 2026-08-09T10:19:17Z (Task 3 commit)
- **Tasks:** 3
- **Files modified:** 13 (8 created, 5 modified)

## Accomplishments

- `packages/db/migrations/0047`/`0048`: `send_status` gains `reconciling` and `unknown`, each in its own standalone file with no same-deploy usage — satisfies Phase 8's `enum-add-value-used-same-file` linter rule and DB-08's expand/contract discipline. Verified live: `enum_range(NULL::send_status)` returns exactly the six-value set after `npm run db:migrate`.
- `packages/db/migrations/0049`: additive `sends.reconciling_since`/`dispatched_at`/`dispatch_duration_ms` (all nullable, zero backfill) plus `sends_status_queued_at_idx` and the partial `sends_reconciling_since_idx` the future reconciler (11-03+) and Phase 15's webhook-lag alert depend on.
- `packages/db/migrations/0050`: `send_reconciler_runs`, a platform-level singleton health table mirroring `partition_maintenance_runs` (no `workspace_id`, no RLS, deliberately, `mega_crm_scan` granted nothing on it), seeded with an epoch dead-man's-switch row.
- Drizzle schema parity: `sends.ts`'s `sendStatusEnum` grows to six values and gains the three new columns; `send-reconciler-runs.ts` is a new type-inference-only schema file wired into `packages/db/src/index.ts`'s import/spread/export triple.
- `send-status-enum-parity.test.ts` (4 tests, ephemeral migrated database) proves Drizzle's enum, `@mega-crm/delivery-core`'s `SEND_STATUSES`, and the live `enum_range` are all set-equal.
- `rollup-enum-migration-invariant.test.ts` (2 tests) proves `reconcileWorkspaceDay` is fact-column-driven: a bare `reconciling`/`unknown` row moves zero `workspace_daily_rollup` counts, while an `unknown` row with a populated `delivered_at` still contributes — pinning that this is deliberate, not accidental.
- `npm run db:audit-sends-history` (new operator CLI): read-only pre-migration history report — per-status/per-kind `sends` counts, `failed`-rows-with-vs-without-`send_events`-evidence, and orphaned-`send_events` counts — provably makes zero writes.
- `SPECIFICATION.md` §2/§3/§4 updated per the binding CLAUDE.md rule: new enum values, columns, indexes, table, the `packages/db` → `@mega-crm/delivery-core` devDependency, and the new `SCAN_DATABASE_URL` consumer.

## Task Commits

Each task was committed atomically:

1. **Task 1: Read-only history audit before the enum ships** - `56df671` (feat)
2. **Task 2: Four migrations — two standalone enum adds, additive columns, reconciler health table [BLOCKING]** - `9b9d330` (feat)
3. **Task 3: Drizzle schema, enum parity test, and rollup-unchanged invariant** - `3834a06` (feat)

**Plan metadata:** (this commit) — docs: complete plan

## Files Created/Modified

- `packages/db/migrations/0047_send_status_reconciling.sql` - Standalone `ALTER TYPE send_status ADD VALUE 'reconciling'`
- `packages/db/migrations/0048_send_status_unknown.sql` - Standalone `ALTER TYPE send_status ADD VALUE 'unknown'`
- `packages/db/migrations/0049_send_reconciliation_columns.sql` - Additive `sends` columns + `sends_status_queued_at_idx`/`sends_reconciling_since_idx`
- `packages/db/migrations/0050_send_reconciler_runs.sql` - `send_reconciler_runs` table + epoch seed row
- `packages/db/migrations/meta/_journal.json` - Four new entries (idx 47-50)
- `packages/db/src/schema/sends.ts` - `sendStatusEnum` grows to six values; three new columns
- `packages/db/src/schema/send-reconciler-runs.ts` - New type-inference-only Drizzle declaration for 0050
- `packages/db/src/index.ts` - `send-reconciler-runs.js` wired into the import/spread/export triple
- `packages/db/scripts/audit-sends-history.ts` - New read-only operator CLI
- `packages/db/package.json` - `db:audit-sends-history` script; `@mega-crm/delivery-core` devDependency
- `package.json` - Root passthrough `db:audit-sends-history` script
- `packages/db/src/__tests__/send-status-enum-parity.test.ts` - New enum-parity test
- `apps/worker/src/queues/__tests__/rollup-enum-migration-invariant.test.ts` - New rollup-invariant test
- `SPECIFICATION.md` - §2.5 (delivery-core devDependency), §3.2 (`SCAN_DATABASE_URL` new consumer), §4.2/§4.5/§4.6 (enum, columns, indexes, table, journal count)

## Decisions Made

- Enum-parity test imports `SEND_STATUSES` from `@mega-crm/delivery-core` (added as a `packages/db` devDependency) rather than re-declaring the vocabulary, per the prior wave's key_link.
- `send-status-enum-parity.test.ts` provisions its own ephemeral database via `createEphemeralDatabase`/`applyMigrationFile` (this package's own existing test-suite convention — `fixture-partition-parity.test.ts`, `migrate-incremental.test.ts`), rather than reusing `@mega-crm/test-support`'s shared fixture, which no existing `packages/db` test uses.
- `rollup-enum-migration-invariant.test.ts` inserts `sends` rows via raw SQL (not through `send-ledger.ts`, which this plan does not touch) so the test isolates `reconcileWorkspaceDay`'s behavior from any dispatch-path code that lands in later plans.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `audit-sends-history.ts` cannot use a single `DATABASE_URL` connection as the plan's `<action>` literally describes**
- **Found during:** Task 1
- **Issue:** The plan's action text says to connect with `new Pool({ connectionString: process.env.DATABASE_URL })` and not import `@mega-crm/tenant-context`. Empirically confirmed this cannot work: `sends` and `send_events` both carry `ENABLE + FORCE ROW LEVEL SECURITY` with the fail-closed `workspace_isolation` predicate (migration 0044) — a `mega_crm_app` connection that has never called `set_config('app.current_workspace_id', ...)` throws `unrecognized configuration parameter "app.current_workspace_id"` on the FIRST query against either table. A cross-tenant history report is structurally impossible under a single unscoped `mega_crm_app` connection.
- **Fix:** Added a second connection built from `SCAN_DATABASE_URL` (the `mega_crm_scan` role, already granted unrestricted `SELECT` on `sends`/`organization` since migration 0042 — read_first item 5 of this task had already flagged this grant) for the per-status/per-kind `sends` aggregates and workspace-id enumeration. For the two counts that need `send_events` (which `mega_crm_scan` is NOT granted on), the script loops over every workspace id and opens a manually-scoped transaction on the `DATABASE_URL` connection (`BEGIN` + `SELECT set_config('app.current_workspace_id', ...)`, the same mechanism `@mega-crm/tenant-context`'s `withTenantTransaction` uses internally) that ALWAYS finishes with `ROLLBACK`, never `COMMIT` — preserving the plan's "always rolled back, provably read-only" requirement without introducing any new cross-tenant grant/migration and without importing `@mega-crm/tenant-context` itself.
- **Files modified:** `packages/db/scripts/audit-sends-history.ts`
- **Verification:** `npm run db:audit-sends-history` exits 0 against the dev database and prints the full report (verified per-status/per-kind counts, queued_at range, failed-evidence split, and the orphaned-`send_events` count against real seeded data); the write-keyword source scan from the plan's own `<verify>` passes; two consecutive runs produce byte-identical output.
- **Committed in:** `56df671` (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking-issue fix)
**Impact on plan:** Necessary for the script to function at all against this codebase's actual RLS configuration. No new grant, migration, or privileged role was introduced — both connections use existing, already-audited grants (`mega_crm_scan`'s `sends`/`organization` SELECT from 0042, `mega_crm_app`'s ordinary per-workspace RLS access). No scope creep.

## Issues Encountered

- The dev-environment `TEST_DATABASE_URL` database was several migrations behind (only tracked through `0037` in `_test_migrations_applied`) — not a regression from this plan; `ensureTestDbMigrated()`'s own pending-migration application (used by every vitest suite that needs a live DB) picked up `0038`-`0050` correctly when the actual test suites ran. Running `drizzle-kit migrate` directly against that DSN is the WRONG tool for it (it uses a separate `drizzle`-schema tracking table this repo's test fixtures never populate) — noted here so a future executor does not repeat that dead end.

## User Setup Required

None - no external service configuration required. Migrations were applied to the dev database (`DATABASE_URL`) during execution as part of this plan's own `<verify>` steps; the test database is migrated lazily by each test suite's own `ensureTestDbMigrated()` call, as designed.

## Next Phase Readiness

- The six-value `send_status` vocabulary, the three new `sends` columns, and `send_reconciler_runs` all exist in the live database, in Drizzle, and in `@mega-crm/delivery-core`'s design artifact, with a live-database test proving all three agree. Plan 11-03 (and onward) can now write `sends.status = 'reconciling'`/`'unknown'` and the two new columns without a schema-push gate blocking it.
- `DLV-02`/`DLV-03`/`DLV-09` in `REQUIREMENTS.md` were deliberately left **unchecked** — this plan lands only the schema prerequisite; the actual behavior (interrupted-send classification, the reconciler worker itself, and the worker-side duration write) lands in 11-03 onward. Marking them complete now would be inaccurate project-tracking state, not merely an omission.
- `packages/db/scripts/audit-sends-history.ts` is available for a human reviewer to run before any later plan in this phase starts writing `reconciling`/`unknown` in production.

---
*Phase: 11-delivery-correctness*
*Completed: 2026-08-09*

## Self-Check: PASSED

- FOUND: packages/db/migrations/0047_send_status_reconciling.sql
- FOUND: packages/db/migrations/0048_send_status_unknown.sql
- FOUND: packages/db/migrations/0049_send_reconciliation_columns.sql
- FOUND: packages/db/migrations/0050_send_reconciler_runs.sql
- FOUND: packages/db/src/schema/send-reconciler-runs.ts
- FOUND: packages/db/scripts/audit-sends-history.ts
- FOUND: packages/db/src/__tests__/send-status-enum-parity.test.ts
- FOUND: apps/worker/src/queues/__tests__/rollup-enum-migration-invariant.test.ts
- FOUND: commit 56df671 in git log
- FOUND: commit 9b9d330 in git log
- FOUND: commit 3834a06 in git log
- FOUND: this SUMMARY.md on disk
