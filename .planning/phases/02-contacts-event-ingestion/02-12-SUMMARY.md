---
phase: 02-contacts-event-ingestion
plan: 12
subsystem: api
tags: [csv-import, bullmq, fastify-multipart, csv-parse, drizzle, data-integrity]

# Dependency graph
requires:
  - phase: 02-contacts-event-ingestion
    provides: "02-07 (CSV mapping/dry-run/apply pipeline), 02-08 (CSV import UI + status polling)"
provides:
  - "applyCsvRowMapping validates subscriptionStatus (subscribed/unsubscribed only; suppressed and free text rejected) -- same mapper used by both dry-run and apply"
  - "markCsvImportFailed repository function -- the schema's 'failed' status is now actually written"
  - "csv-import upload route: parser/stream errors and truncated uploads set status='failed' and return 422/413 instead of a bare 500 + stuck 'uploaded'"
  - "imports-csv worker: throws when rows remain unresolved at the final recount, so BullMQ marks the job failed and retries it instead of silently leaving status 'applying' forever"
affects: [csv-import, contacts-core, imports-csv-worker]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Shared-mapper validation: any field-specific business rule (e.g. subscriptionStatus enum) is validated inside applyCsvRowMapping itself, not in either of its two callers, so dry-run and apply can never drift"
    - "Worker terminal-state contract: a job handler must throw (not resolve) whenever it cannot bring all of its units of work (rows) to a terminal state -- silent partial success is treated as a bug, not an acceptable outcome"

key-files:
  created: []
  modified:
    - packages/contacts-core/src/csv-mapping.ts
    - apps/worker/src/queues/imports-csv.worker.ts
    - apps/api/src/modules/contacts/csv-import.routes.ts
    - apps/api/src/modules/contacts/csv-import.repository.ts
    - apps/api/src/modules/contacts/__tests__/csv-import.test.ts
    - apps/worker/src/queues/__tests__/imports-csv-idempotency.test.ts

key-decisions:
  - "subscriptionStatus validation lives in applyCsvRowMapping (the shared mapper), not in either caller -- guarantees dry-run/apply agreement by construction, not by convention"
  - "suppressed is refused unconditionally via CSV, even though it's a valid enum value in every other context -- suppression is automated-only (D-12)"
  - "Worker still writes status='applying' before throwing on stillPending>0, preserving the true in-progress state for anyone polling status while the job is queued for retry"
  - "Cursor still advances within a single pass even if a row's error-marking UPDATE itself fails -- avoids an unbounded tight retry loop against a systemic failure; the throw-triggered BullMQ retry (fresh invocation, cursor reset to 0) is what re-picks up that still-'pending' row, not an in-run retry"
  - "Truncation detection relies on data.file.truncated checked AFTER the parse loop completes -- @fastify/multipart's file-size limit ends the stream normally (no thrown error) for the single-file request.file()+pipe pattern this route uses"

patterns-established:
  - "Validate business-rule enums once, in the shared function both the preview (dry-run) path and the execution (apply) path call -- never re-derive the same classification in two places"

requirements-completed: []  # gap_closure plan hardening already-satisfied CONT-02; no new requirement IDs

coverage:
  - id: D1
    description: "applyCsvRowMapping rejects any subscriptionStatus value other than subscribed/unsubscribed (case-insensitive), including suppressed, and normalizes valid values"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/contacts/__tests__/csv-import.test.ts#applyCsvRowMapping subscriptionStatus validation (WR-05a)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Dry-run and apply agree on invalid subscriptionStatus rows -- a bad value is counted in errorCount, never willCreate/willUpdate"
    requirement: null
    verification:
      - kind: integration
        ref: "apps/api/src/modules/contacts/__tests__/csv-import.test.ts#WR-05b: dry-run reports an invalid subscriptionStatus value as an error, not a create/update (no drift with apply)"
        status: pass
    human_judgment: false
  - id: D3
    description: "A malformed CSV (unclosed quote) that throws mid-stream sets the import status to 'failed' and returns a non-success response, instead of a bare 500 leaving the row stuck 'uploaded'"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/contacts/__tests__/csv-import.test.ts#WR-04: a malformed CSV that throws mid-stream sets the import status to 'failed', not stuck 'uploaded'"
        status: pass
    human_judgment: false
  - id: D4
    description: "A truncated upload (data.file.truncated) sets status 'failed' and returns 413"
    verification: []
    human_judgment: true
    rationale: "No automated test exercises an actual 50MB truncated upload (impractical payload size for the test suite); the code path was implemented per the plan's documented mechanism (data.file.truncated checked after the parse loop) and code-reviewed, but not exercised end-to-end by an automated test. Flagged for phase-level UAT or a future targeted test with a reduced multipart size limit."
  - id: D5
    description: "An apply job that cannot resolve every row (stillPending>0 at recount) throws instead of silently completing while the import stays stuck 'applying'"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/imports-csv-idempotency.test.ts#WR-03: an apply job that cannot resolve every row THROWS instead of silently leaving the import stuck 'applying'"
        status: pass
    human_judgment: false

# Metrics
duration: 15min
completed: 2026-07-05
status: complete
---

# Phase 02 Plan 12: CSV Pipeline Robustness Gap Closure Summary

**Shared CSV mapper now validates subscriptionStatus (closing dry-run/apply drift and the suppressed-via-CSV D-12 bypass); the upload route surfaces parser and truncation failures as status='failed' instead of a false success; and the apply worker throws on unresolved rows so BullMQ actually retries instead of leaving imports stuck 'applying' forever.**

## Performance

- **Duration:** ~15 min
- **Completed:** 2026-07-05
- **Tasks:** 3
- **Files modified:** 6

## Accomplishments
- WR-05: `applyCsvRowMapping` (the SAME function used by both the dry-run counter and the apply worker) now validates `subscriptionStatus`, accepting only `subscribed`/`unsubscribed` (case-normalized) and rejecting everything else -- including `suppressed`, closing the D-12 compliance bypass and the dry-run/apply drift in one place.
- WR-04: the upload route's streaming parse loop is now wrapped in try/catch; a parser/stream error (e.g. an unclosed CSV quote) marks the import `failed` and returns 422 instead of a bare 500 that stranded the row in `uploaded`. A truncated upload (`data.file.truncated`, set when `@fastify/multipart`'s 50MB limit silently cuts the stream) marks `failed` and returns 413.
- WR-03: `processImportsCsvJob` now throws when the final recount shows `stillPending > 0`, so BullMQ marks the job failed and (with 02-10's `defaultJobOptions`) retries it -- each row's own idempotency guard (locked re-check of its `pending` status) makes the retry safe.
- `markCsvImportFailed` added to the repository, making the schema's `failed` status actually reachable (closes IN-06's masking of WR-04).
- 4 new regression tests (WR-05a, WR-05b, WR-04, WR-03) all confirmed RED against unmodified code, then GREEN after their respective fixes.

## Task Commits

Each task was committed atomically:

1. **Task 1: Failing tests -- invalid CSV status, malformed upload, stuck-applying (RED)** - `91e6884` (test)
2. **Task 2: Shared mapper validates subscriptionStatus (WR-05)** - `181ec6d` (feat)
3. **Task 3: Worker no-silent-stuck (WR-03) + upload failure path & truncation guard (WR-04)** - `bde49fb` (feat)

_TDD gate sequence confirmed in git log: test(02-12) -> feat(02-12) -> feat(02-12)._

## Files Created/Modified
- `packages/contacts-core/src/csv-mapping.ts` - `applyCsvRowMapping` validates/normalizes `subscriptionStatus`, refusing `suppressed` and any non-enum value
- `apps/worker/src/queues/imports-csv.worker.ts` - throws on `stillPending > 0` at final recount; clarifying comments on cursor-advance safety in the per-row catch block
- `apps/api/src/modules/contacts/csv-import.routes.ts` - upload route wraps the parse loop in try/catch (-> `markCsvImportFailed` + 422) and checks `data.file.truncated` (-> `markCsvImportFailed` + 413)
- `apps/api/src/modules/contacts/csv-import.repository.ts` - added `markCsvImportFailed`
- `apps/api/src/modules/contacts/__tests__/csv-import.test.ts` - WR-05a (mapper unit tests), WR-05b (dry-run drift), WR-04 (malformed upload) regression tests
- `apps/worker/src/queues/__tests__/imports-csv-idempotency.test.ts` - WR-03 (stillPending -> throw) regression test

## Decisions Made
- subscriptionStatus validation lives inside the shared `applyCsvRowMapping`, not duplicated in either caller -- guarantees dry-run/apply agreement structurally rather than by convention.
- `suppressed` is refused unconditionally via CSV even though it's otherwise a valid enum value -- suppression stays automated-only (D-12).
- The worker still records `status='applying'` before throwing on `stillPending>0`, so anyone polling status mid-retry sees the true in-progress state rather than an ambiguous value.
- Cursor advancement within a single run is left unchanged (advances even when a row's error-mark UPDATE itself fails) -- deliberately avoids an unbounded tight retry loop against a systemic failure inside one job execution; the throw-triggered BullMQ retry is what re-processes that row on a fresh invocation (cursor resets to 0), not an in-run retry.
- Truncation detection checks `data.file.truncated` AFTER the parse loop completes, since `@fastify/multipart`'s size-limit handling ends the stream normally (no thrown error) for this route's single-file `request.file()` + `.pipe()` pattern -- confirmed via source inspection of `@fastify/multipart@` (installed version) rather than assumed.

## Deviations from Plan

None - plan executed exactly as written. The truncation-guard code path (413 response) was implemented per the plan's specification but has no dedicated automated test (see "Known Gaps" below) -- this is a scope note, not a deviation from what was asked.

## Issues Encountered
None.

## Known Gaps

- **Truncated-upload path (WR-04's 413 branch) is implemented but not automated-test-covered.** Exercising the actual `data.file.truncated` branch requires a real upload exceeding `UPLOAD_MAX_BYTES` (50MB), which is impractical to construct in the fast unit/integration suite. The code was written and reviewed against `@fastify/multipart`'s source (confirmed the size-limit handling ends the stream normally rather than throwing for this route's `request.file()` + `.pipe()` pattern), but is flagged in the `coverage` block (`D4`, `human_judgment: true`) for phase-level UAT or a future targeted test using a reduced test-only size limit.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- CSV import pipeline's dry-run/apply drift, false-success, and stuck-forever failure modes (WR-05/WR-04/WR-03) are closed with regression coverage.
- One known gap carried forward: automated coverage for the truncated-upload 413 path (see Known Gaps above) -- recommend a phase-level UAT check with a manually oversized file, or a follow-up test using a test-only reduced `fileSize` limit.
- Deferred (per plan's `<deferrals>`, unchanged): WR-02, WR-07, WR-08, WR-10, IN-01..IN-09 except IN-06 (now closed as a side effect of WR-04).

---
*Phase: 02-contacts-event-ingestion*
*Completed: 2026-07-05*
