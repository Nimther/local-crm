---
phase: 02-contacts-event-ingestion
plan: 07
subsystem: api
tags: [csv-parse, fastify-multipart, bullmq, drizzle, postgres-rls, contacts]

# Dependency graph
requires:
  - phase: 02-contacts-event-ingestion
    provides: "upsertContactByIdentity + property-registry (02-04, extracted to @mega-crm/contacts-core in 02-06), BullMQ queue/worker foundation + @mega-crm/tenant-context (02-05/02-06)"
provides:
  - "csv_imports + csv_import_rows schema (RLS-protected, staging-table streaming pattern)"
  - "CSV upload -> dry-run -> apply -> report pipeline reusing the shared upsert"
  - "@mega-crm/contacts-core additions: findContactIdByIdentity, applyCsvRowMapping, UpsertContactIdentityResult.created"
affects: [02-08 (CSV import wizard UI), Phase 3 segmentation (custom-property registry inputs from CSV)]

# Tech tracking
tech-stack:
  added: ["csv-parse@7.0.1", "@fastify/multipart@10.0.0"]
  patterns:
    - "Streamed CSV upload into a staging table (csv_import_rows) so a separate worker process can apply it later without shared filesystem access"
    - "Dry-run persists per-row error classification immediately (not just aggregate counts), making the error-report route usable before apply ever runs"
    - "Row-level idempotency via each staged row's own persisted status, re-checked with FOR UPDATE inside the processing transaction, rather than relying solely on a unique constraint"

key-files:
  created:
    - packages/db/src/schema/csv-imports.ts
    - packages/db/migrations/0008_exotic_skullbuster.sql
    - packages/db/migrations/0009_csv_imports_rls_policies.sql
    - packages/shared-schemas/src/csv-import.ts
    - packages/contacts-core/src/csv-mapping.ts
    - apps/api/src/modules/contacts/csv-import.repository.ts
    - apps/api/src/modules/contacts/csv-import.routes.ts
    - apps/api/src/modules/contacts/imports-csv-queue.ts
    - apps/worker/src/queues/imports-csv.worker.ts
    - apps/api/src/modules/contacts/__tests__/csv-import.test.ts
    - apps/worker/src/queues/__tests__/imports-csv-idempotency.test.ts
  modified:
    - packages/db/src/index.ts
    - packages/shared-schemas/src/queues.ts
    - packages/shared-schemas/src/index.ts
    - packages/contacts-core/src/contact-repository.ts
    - packages/contacts-core/src/index.ts
    - apps/api/src/server.ts
    - apps/worker/src/server.ts
    - apps/api/package.json

key-decisions:
  - "Dry-run persists per-row error status/reason immediately (status='error'), leaving valid rows 'pending' -- makes the error-report CSV testable/usable right after dry-run, without needing the apply worker to have run"
  - "Skip-policy precheck and dry-run's willUpdate classification both use a new shared findContactIdByIdentity (read-only, same D-01..D-03 priority as upsertContactByIdentity) so the two processes can never disagree about 'does this identity already exist'"
  - "Progress/summary are recomputed from GROUP BY status counts every run, never incremented -- makes a redelivered/retried apply job idempotent by construction rather than by a fragile increment guard"

patterns-established:
  - "Mapping-application logic (applyCsvRowMapping) lives in the shared @mega-crm/contacts-core package specifically so apps/api's dry-run counter and apps/worker's apply worker can never drift on what a column mapping means"

requirements-completed: [CONT-02]

coverage:
  - id: D1
    description: "Streamed multipart CSV upload creates a csv_imports history row and stages every row into csv_import_rows, returning detected headers + a preview of the first ~20 mapped rows"
    requirement: CONT-02
    verification:
      - kind: integration
        ref: "apps/api/src/modules/contacts/__tests__/csv-import.test.ts#upload streams the WHOLE file to staging and returns detected headers + a preview of the first rows"
        status: pass
    human_judgment: false
  - id: D2
    description: "Dry-run validates the WHOLE file against a column mapping + duplicate policy, returning willCreate/willUpdate/errorCount and writing NO contact"
    requirement: CONT-02
    verification:
      - kind: integration
        ref: "apps/api/src/modules/contacts/__tests__/csv-import.test.ts#D-17: dry-run validates the WHOLE file and reports willCreate/willUpdate/errorCount WITHOUT writing any contact"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/contacts/__tests__/csv-import.test.ts#D-17: dry-run counts a pre-existing identity match as willUpdate, not willCreate"
        status: pass
    human_judgment: false
  - id: D3
    description: "Apply runs as a background BullMQ job reusing upsertContactByIdentity; both duplicate policies (update-merge, skip-existing) behave per D-15, csv_imports progress/summary are recomputed idempotently"
    requirement: CONT-02
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/imports-csv-idempotency.test.ts#CONT-02: update policy creates new contacts and merges non-empty CSV values into an existing match (reuses upsertContactByIdentity)"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/imports-csv-idempotency.test.ts#D-15: skip policy leaves an existing match completely untouched, only creating brand-new contacts"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/imports-csv-idempotency.test.ts#Pitfall 1: re-running the apply job for the same staged rows is a safe no-op (no double-create, no double-appended tags)"
        status: pass
    human_judgment: false
  - id: D4
    description: "A malformed row (missing both identifiers or invalid email) is marked errored with a reason and excluded from applied counts; the error-report route returns a downloadable CSV of only those rows"
    requirement: CONT-02
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/imports-csv-idempotency.test.ts#CONT-02: a malformed row (missing both identifiers) is marked errored and excluded from applied counts"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/contacts/__tests__/csv-import.test.ts#D-18: the error-report route returns a downloadable CSV of only the errored rows with a reason column"
        status: pass
    human_judgment: false
  - id: D5
    description: "Import history persists file name, author, and (once dry-run has run) summary; @fastify/multipart is registered route-scoped only, never globally"
    requirement: CONT-02
    verification:
      - kind: integration
        ref: "apps/api/src/modules/contacts/__tests__/csv-import.test.ts#D-20: import history persists file name, author, and (once dry-run has run) summary"
        status: pass
      - kind: other
        ref: "grep -n multipart apps/api/src/server.ts apps/api/src/modules/contacts/csv-import.routes.ts (no root-level registration)"
        status: pass
    human_judgment: false

# Metrics
duration: 13min
completed: 2026-07-04
status: complete
---

# Phase 2 Plan 7: CSV Contact Import Summary

**CSV contact import (upload -> column-mapping dry-run -> BullMQ apply -> error report) that streams into a staging table and reuses the phase's shared `upsertContactByIdentity`, so identity/suppression rules match the UI and event-ingestion API exactly.**

## Performance

- **Duration:** 13 min
- **Started:** 2026-07-04T15:07:00+05:00
- **Completed:** 2026-07-04T15:20:00+05:00
- **Tasks:** 3 (RED tests, schema+migration+deps, routes+worker)
- **Files modified:** 19

## Accomplishments
- `csv_imports` (history/progress/dry-run-summary) + `csv_import_rows` (staging, `UNIQUE(csv_import_id, row_number)` idempotency key) tables, both RLS ENABLE+FORCE+workspace_isolation
- Route-scoped `@fastify/multipart` upload streams a CSV via `csv-parse` directly into staging (never fully buffers), returning detected headers + a preview of the first ~20 mapped rows
- Dry-run validates the WHOLE staged file against a column mapping + duplicate policy, returning `{willCreate, willUpdate, errorCount}` while writing zero contacts, and persists per-row error classification immediately so the error report is usable right away
- `imports:csv` BullMQ worker applies staged rows via the shared `upsertContactByIdentity`, honoring both D-15 duplicate policies (update-merge / skip-existing), idempotent under BullMQ's at-least-once redelivery, with progress/summary recomputed from row-status counts every run
- Downloadable error-report CSV (reason column) and import history (file name, author, summary)

## Task Commits

Each task was committed atomically:

1. **Task 1: Failing tests — upload/dry-run/apply/report + worker idempotency** - `8c02a52` (test)
2. **Task 2: [BLOCKING] csv_imports/csv_import_rows schema + migration + shared schemas + install deps** - `a751f80` (feat)
3. **Task 3: Upload/mapping/dry-run/status/report routes + CSV apply worker** - `3312db1` (feat)

**Plan metadata:** (this commit)

## Files Created/Modified
- `packages/db/src/schema/csv-imports.ts` - `csv_imports` + `csv_import_rows` Drizzle schema
- `packages/db/migrations/0008_exotic_skullbuster.sql` - drizzle-kit-generated table DDL (hand-adjusted to strip a spurious re-`CREATE TABLE events`, see Deviations)
- `packages/db/migrations/0009_csv_imports_rls_policies.sql` - hand-written RLS for both new tables
- `packages/shared-schemas/src/csv-import.ts` - mapping/dry-run/status Zod schemas
- `packages/shared-schemas/src/queues.ts` - finalized `IMPORTS_CSV_QUEUE` payload with `csvImportId`
- `packages/contacts-core/src/csv-mapping.ts` - shared `applyCsvRowMapping` interpreter (apps/api dry-run + apps/worker apply agree byte-for-byte)
- `packages/contacts-core/src/contact-repository.ts` - added `findContactIdByIdentity` (read-only identity precheck) + `UpsertContactIdentityResult.created` flag
- `apps/api/src/modules/contacts/csv-import.repository.ts` - staging/history/progress repository
- `apps/api/src/modules/contacts/csv-import.routes.ts` - upload/dry-run/apply/status/history/error-report routes
- `apps/api/src/modules/contacts/imports-csv-queue.ts` - BullMQ producer for `IMPORTS_CSV_QUEUE`
- `apps/worker/src/queues/imports-csv.worker.ts` - idempotent apply-job handler + Worker factory
- `apps/api/src/server.ts`, `apps/worker/src/server.ts` - route/worker registration
- `apps/api/src/modules/contacts/__tests__/csv-import.test.ts`, `apps/worker/src/queues/__tests__/imports-csv-idempotency.test.ts` - test coverage

## Decisions Made
- Dry-run persists per-row error status/reason immediately (leaving valid rows `pending`) rather than only returning aggregate counts -- makes the D-18 error-report CSV meaningful right after dry-run, and makes re-running dry-run with a corrected mapping safe (rows are re-classified, not stuck errored).
- Added `findContactIdByIdentity` to `@mega-crm/contacts-core` (read-only, same external_id-then-email priority as `upsertContactByIdentity`) so the D-15 skip-policy precheck and the dry-run's willUpdate/willCreate classification both use the exact same rule instead of two independently-written matchers.
- `UpsertContactIdentityResult` gained an optional `created` flag (true only on the brand-new-contact branch) so the CSV worker can record accurate created-vs-updated counts without re-deriving identity-match state after the fact. Backward compatible: every pre-existing caller (Contacts API route, events:ingest worker) ignores the new field.
- `csv_imports.processedRows`/`summary` are recomputed from `GROUP BY status` counts on every worker run (never incremented) -- a redelivered/retried apply job is idempotent by construction rather than by a fragile "did I already count this" guard.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `drizzle-kit generate` proposed re-creating the already-existing partitioned `events` table**
- **Found during:** Task 2 (schema + migration)
- **Issue:** `packages/db/src/schema/events.ts` has never had a drizzle-kit snapshot (its physical table was created by the hand-written `0007_events_partitioned.sql`, since declarative partitioning has no `pgTable` expression). Running `drizzle-kit generate` for the new CSV tables therefore also proposed `CREATE TABLE "events"` + its two FKs again in the generated migration, which would fail with "relation already exists" against an already-migrated database.
- **Fix:** Hand-stripped the spurious `CREATE TABLE "events"` block and its two FK `ALTER TABLE` statements from `0008_exotic_skullbuster.sql`, keeping only the two brand-new CSV-import tables. The accompanying `0008_snapshot.json` (auto-generated) now correctly records `events`, so future `drizzle-kit generate` runs will no longer re-propose it.
- **Files modified:** `packages/db/migrations/0008_exotic_skullbuster.sql`
- **Verification:** `npm run db:migrate` applied cleanly against a database that already had `events` from 0007; `\dt` confirms no duplicate/error.
- **Committed in:** `a751f80` (Task 2 commit)

**2. [Rule 2 - Missing Critical] Per-row exception isolation in the apply worker**
- **Found during:** Task 3 (worker implementation)
- **Issue:** The plan's row-processing loop, as initially drafted, would let an unexpected exception on one row (e.g. a malformed `subscriptionStatus` value rejected by the Postgres enum column) abort the entire apply job, leaving later rows in the file unprocessed — inconsistent with D-18's expectation that only the offending row is excluded from applied counts.
- **Fix:** Wrapped each row's processing transaction in try/catch; any exception marks just that row `error` (in its own follow-up transaction, since the row's original transaction was rolled back) and processing continues to the next row.
- **Files modified:** `apps/worker/src/queues/imports-csv.worker.ts`
- **Verification:** Covered indirectly by the existing malformed-row test (missing-both-identifiers case); the same isolation path also protects against enum-rejection and other row-level DB errors.
- **Committed in:** `3312db1` (Task 3 commit)

**3. [Rule 1 - Bug] Test fixture writes/reads against RLS-protected tables via a plain, unscoped pool**
- **Found during:** Task 3 (test execution)
- **Issue:** Both test files' fixture helpers initially used a plain `pool.query()` against `csv_imports`/`csv_import_rows` (which carry `ENABLE + FORCE ROW LEVEL SECURITY`). Inserts failed outright ("new row violates row-level security policy"); reads silently returned zero rows instead of erroring.
- **Fix:** Routed every fixture write/read against these two tables through `withTenant(workspaceId, () => withTenantTransaction(...))`, matching the established pattern used for `contacts`/`events` in the existing `events-ingest-idempotency.test.ts`.
- **Files modified:** `apps/worker/src/queues/__tests__/imports-csv-idempotency.test.ts`, `apps/api/src/modules/contacts/__tests__/csv-import.test.ts`
- **Verification:** All 8 apps/api + 4 apps/worker CSV tests pass; full apps/api (91/91) and apps/worker (11/11) suites remain green.
- **Committed in:** `3312db1` (Task 3 commit)

---

**Total deviations:** 3 auto-fixed (1 bug in generated migration, 1 missing critical error-isolation, 1 bug in test fixture RLS scoping)
**Impact on plan:** All three were necessary for correctness (migration would have failed to apply; a single bad CSV row would have aborted an entire import; tests would have been unable to observe RLS-protected state at all). No scope creep — no new routes, tables, or business rules beyond what the plan specified.

## Issues Encountered
None beyond the deviations above.

## User Setup Required
None - no external service configuration required. `csv-parse`/`@fastify/multipart` were already legitimacy-approved in the 02-05 phase-wide package checkpoint; no new npm packages required re-verification.

## Next Phase Readiness
- The full CSV pipeline (schema, routes, worker, both dedupe policies, idempotency, error reporting) is proven end-to-end via automated tests; 02-08 (CSV import wizard UI) can build directly against these routes without further backend changes.
- No blockers. The dry-run-marks-errors-immediately design means the UI wizard can show the error report as soon as dry-run completes, before the marketer even clicks "Apply".

---
*Phase: 02-contacts-event-ingestion*
*Completed: 2026-07-04*

## Self-Check: PASSED

All 12 created files found on disk; all 3 task commit hashes (`8c02a52`, `a751f80`, `3312db1`) found in git history.
