---
phase: 06-flows-triggered-chains
plan: 22
subsystem: contacts-import
tags: [csv-import, timezone, drizzle, zod, fastify, bullmq]

requires:
  - phase: 06-flows-triggered-chains
    provides: "06-07's contacts.timezone standard field + isValidIanaTimezone allowlist check in @mega-crm/delivery-core; 06-13's D-08 dispatch-time timezone resolution"
provides:
  - "csv_imports.default_timezone persisted column (migration 0035)"
  - "csvDryRunRequestSchema.defaultTimezone (optional, nullish, format-only string)"
  - "applyCsvRowMapping(raw, mapping, options?: { defaultTimezone }) -- the single shared application+validation point both dry-run and apply worker call"
  - "dry-run -> csv_imports.default_timezone -> apply worker threading, so preview and apply agree on which rows get the default"
affects: ["06-23 (frontend default-timezone combobox on the CSV mapping step, consumes csvDryRunRequestSchema.defaultTimezone)"]

tech-stack:
  added: []
  patterns:
    - "Default-value-for-missing-field pattern inside a shared row mapper: apply the default BEFORE the existing per-field validation check so both a mapped value and a default-applied value share one validation+error path."

key-files:
  created:
    - packages/db/migrations/0035_csv_imports_default_timezone.sql
  modified:
    - packages/db/migrations/meta/_journal.json
    - packages/db/src/schema/csv-imports.ts
    - packages/shared-schemas/src/csv-import.ts
    - packages/contacts-core/src/csv-mapping.ts
    - apps/api/src/modules/contacts/csv-import.routes.ts
    - apps/api/src/modules/contacts/csv-import.repository.ts
    - apps/worker/src/queues/imports-csv.worker.ts
    - apps/api/src/modules/contacts/__tests__/csv-import.test.ts

key-decisions:
  - "The default is applied inside applyCsvRowMapping itself (not by either caller) so dry-run (apps/api) and apply (apps/worker) structurally cannot drift on what a default does -- mirrors the existing subscriptionStatus/timezone validation pattern in the same function."
  - "Default fills input.timezone only when it is still undefined after the header->field loop (unmapped column OR blank cell) -- a mapped per-row value, valid or invalid, is never overridden or masked by the default."

requirements-completed: [FLOW-05]

coverage:
  - id: D1
    description: "csv_imports.default_timezone column persists the per-import default IANA timezone (migration 0035 + drizzle schema)"
    requirement: "FLOW-05"
    verification:
      - kind: other
        ref: "psql information_schema.columns check: default_timezone|text"
        status: pass
    human_judgment: false
  - id: D2
    description: "applyCsvRowMapping applies+validates options.defaultTimezone through the same isValidIanaTimezone check a mapped column value uses; a mapped value always wins"
    requirement: "FLOW-05"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/contacts/__tests__/csv-import.test.ts#applyCsvRowMapping default timezone (06-22/FLOW-05)"
        status: pass
    human_judgment: false
  - id: D3
    description: "defaultTimezone threads from dry-run request -> csv_imports.default_timezone -> apply worker's per-row applyCsvRowMapping call, so preview and apply agree"
    requirement: "FLOW-05"
    verification:
      - kind: integration
        ref: "npm run build -w apps/api && npm run build -w apps/worker (tsc, no type errors on the threaded signature)"
        status: pass
    human_judgment: false

duration: 10min
completed: 2026-07-13
status: complete
---

# Phase 06 Plan 22: CSV import default timezone (server-side foundation) Summary

**Persisted `csv_imports.default_timezone` + a default-aware, validated `applyCsvRowMapping` shared by dry-run and the apply worker, closing the server-side half of UAT Test 10's CSV-mapping timezone gap.**

## Performance

- **Duration:** 10 min
- **Started:** 2026-07-13T16:20:00Z
- **Completed:** 2026-07-13T16:30:33Z
- **Tasks:** 3
- **Files modified:** 8 (1 created, 7 modified)

## Accomplishments
- `csv_imports.default_timezone` (nullable text) added via hand-written migration 0035, registered in `meta/_journal.json`, applied to the local dev DB, and confirmed present via `information_schema`.
- `applyCsvRowMapping` now accepts an optional `options.defaultTimezone`: it fills `input.timezone` only for rows with no timezone resolved from the mapping (unmapped column or blank cell), and the default is validated through the exact same `isValidIanaTimezone` check a mapped value goes through -- an invalid default is rejected with the same `"Invalid timezone"` row error, never stored.
- `csvDryRunRequestSchema` gained an optional, nullish, format-only `defaultTimezone` field (real IANA validation deliberately stays server-side in the mapper, matching the 06-07 precedent that `packages/shared-schemas` has no dependency on `@mega-crm/delivery-core`).
- The dry-run route/repository now persist `defaultTimezone` alongside `mapping`/`duplicatePolicy`, and the apply worker re-reads `csv_imports.default_timezone` and passes it into its `applyCsvRowMapping` call -- dry-run preview and apply now agree byte-for-byte on which rows land which timezone.
- 5 new pure-function regression tests pin the mapper's default-timezone behavior (default applied, mapped value wins, no-default backward compatible, invalid default rejected, empty-cell falls back to default).

## Task Commits

Each task was committed atomically:

1. **Task 1: Add csv_imports.default_timezone column (migration + drizzle schema)** - `07239db` (feat)
2. **Task 2: Default-aware validated applyCsvRowMapping + shared dry-run contract + pure mapper tests** - `7cdfba4` (feat)
3. **Task 3: Thread defaultTimezone through dry-run persistence and the apply worker** - `ad04d64` (feat)

**Plan metadata:** (final docs commit follows this summary)

## Files Created/Modified
- `packages/db/migrations/0035_csv_imports_default_timezone.sql` - hand-written ALTER TABLE adding the nullable column, mirroring the 0029 contacts.timezone precedent
- `packages/db/migrations/meta/_journal.json` - registered migration 0035 (idx 35)
- `packages/db/src/schema/csv-imports.ts` - `defaultTimezone: text("default_timezone")` added to the drizzle table
- `packages/shared-schemas/src/csv-import.ts` - `csvDryRunRequestSchema.defaultTimezone` (optional nullish string, format-only)
- `packages/contacts-core/src/csv-mapping.ts` - `applyCsvRowMapping`'s new `options?: { defaultTimezone?: string | null }` param, applied before the existing IANA validation check
- `apps/api/src/modules/contacts/csv-import.routes.ts` - `computeDryRunSummary` takes/forwards `defaultTimezone`; dry-run handler reads it from the request and passes it to both the summary computation and persistence
- `apps/api/src/modules/contacts/csv-import.repository.ts` - `CsvImportRow`/`CSV_IMPORT_COLUMNS` surface `defaultTimezone`; `saveDryRunResult` writes it to the new column
- `apps/worker/src/queues/imports-csv.worker.ts` - `CsvImportConfigRow`/config SELECT surface `defaultTimezone`; the apply-time `applyCsvRowMapping` call passes it through
- `apps/api/src/modules/contacts/__tests__/csv-import.test.ts` - new `describe("applyCsvRowMapping default timezone (06-22/FLOW-05)")` block with 5 pure-function tests

## Decisions Made
- The default is applied+validated in exactly one shared function (`applyCsvRowMapping`), called by both the dry-run summary (apps/api) and the apply worker (apps/worker), so preview and apply cannot structurally diverge on what a default does (T-06-22-03 mitigation).
- Default only fills a row's timezone when it is still `undefined` after the mapping loop -- a mapped per-row value (valid or invalid) is never overridden or silently corrected by the default.
- `defaultTimezone` stays format-only (`z.string().min(1)`) in `packages/shared-schemas` -- the real `isValidIanaTimezone` allowlist check runs server-side in `applyCsvRowMapping`, consistent with the 06-07 STATE decision that shared-schemas has no dependency on `@mega-crm/delivery-core`.

## Deviations from Plan

**1. [Minor plan-text inaccuracy, no code impact] Task 3's action text says "pass it into BOTH applyCsvRowMapping call sites in this worker" -- `apps/worker/src/queues/imports-csv.worker.ts` has only ONE `applyCsvRowMapping` call site (line 91, inside the per-row processing loop).** Threaded `defaultTimezone` into that single existing call site; there was no second site to update. Verified via `grep -n "applyCsvRowMapping" apps/worker/src/queues/imports-csv.worker.ts` before and after the change.

---

**Total deviations:** 1 (plan-text inaccuracy only, no auto-fix rule invoked -- nothing to fix, just fewer call sites than described)
**Impact on plan:** None. All planned behavior shipped as specified.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required. This plan is server-side foundation only; no new environment variables, no new UI to configure.

## Next Phase Readiness
- 06-23 (wave 2, frontend) can now build the CSV mapping step's constrained default-timezone combobox against a real contract: POST `.../dry-run` accepts `defaultTimezone`, and the value is validated, persisted, and applied consistently through to the apply worker.
- All touched workspaces (`packages/db`, `packages/shared-schemas`, `packages/contacts-core`, `apps/api`, `apps/worker`) build clean; the `csv-import.test.ts` suite (22/22) and `imports-csv-idempotency.test.ts` suite (5/5) both pass with no regressions.
- No blockers for 06-23.

---
*Phase: 06-flows-triggered-chains*
*Completed: 2026-07-13*

## Self-Check: PASSED

All 9 files created/modified confirmed present on disk; all 3 task commits (07239db, 7cdfba4, ad04d64) confirmed in git log.
