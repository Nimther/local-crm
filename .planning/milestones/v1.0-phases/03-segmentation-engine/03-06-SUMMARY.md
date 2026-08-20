---
phase: 03-segmentation-engine
plan: 06
subsystem: api
tags: [postgres, statement_timeout, fastify, segmentation, dos-hardening]

# Dependency graph
requires:
  - phase: 03-segmentation-engine
    provides: "03-05's STANDARD_FIELD_KEYS allow-list (Zod-boundary + segments-core compiler in lockstep); 03-02's segment.repository.ts/segments.routes.ts CRUD+preview-count"
provides:
  - "statement_timeout coverage on createSegment/updateSegment/listSegmentMembers (previously only countSegmentMembers/preview-count had it)"
  - "57014 (query canceled) -> HTTP 400 mapping on POST/PATCH/members, closing the T-03-04 DoS exposure on save/read paths"
  - "HTTP-level regression tests proving the 03-05 unknown/empty-field boundary returns 400 (not 500) on the save path, and a tags/has_tag segment round-trips create->members"
affects: [03-07, 03-08, phase-06-trigger-chains]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Parameterized set_config('statement_timeout', $1, true) inside withTenantTransaction as the standard way to bound a segment-evaluation query (replaces string-interpolated SET LOCAL)"
    - "Route-level try/catch keyed on Postgres error code 57014, distinguishing degrade-to-{degraded:true} (preview-count, high-frequency/unsaved) from reject-with-400 (create/update/members, low-frequency/persisted) responses to the same underlying cancellation"

key-files:
  created:
    - apps/api/src/modules/segments/__tests__/segments-hardening.test.ts
  modified:
    - apps/api/src/modules/segments/segment.repository.ts
    - apps/api/src/modules/segments/segments.routes.ts

key-decisions:
  - "SAVE_EVAL_STATEMENT_TIMEOUT_MS set to 15000ms (vs preview-count's 2000ms) — saves/members are deliberate, lower-frequency actions than per-keystroke live preview, so a more generous bound is appropriate"
  - "create/update/members reject outright (400) on 57014 rather than degrading like preview-count — there is no meaningful degraded/partial state to return for a persisted write or a members listing"
  - "countSegmentMembers's existing statement_timeout application was also migrated to the same parameterized set_config form for consistency, even though its only caller passes a constant (no behavior change)"

requirements-completed: [SEGM-01, SEGM-04]

coverage:
  - id: D1
    description: "createSegment/updateSegment/listSegmentMembers accept and apply statementTimeoutMs via parameterized set_config; no string-interpolated SET LOCAL remains in segment.repository.ts"
    requirement: "SEGM-04"
    verification:
      - kind: unit
        ref: "npm run build -w apps/api (tsc clean) + grep confirms no SET LOCAL string interpolation remains"
        status: pass
    human_judgment: false
  - id: D2
    description: "POST /segments, PATCH /segments/:id, GET /:id/members map Postgres 57014 to HTTP 400 with a clear error body; non-57014 errors re-throw"
    requirement: "SEGM-04"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/segments/__tests__/preview-count.test.ts#D-08/T-03-04: SET LOCAL statement_timeout cancels a slow query with Postgres code 57014 (proves the 57014 mechanism the new catch blocks depend on)"
        status: pass
    human_judgment: true
    rationale: "No automated trigger for a real 57014 on the save/members path exists at test-data volume (same limitation acknowledged for preview-count in 03-02); the wiring is proven by code inspection + the shared mechanism test, not a dedicated cancellation-trip test on create/update/members. Flagging for human sign-off that this is an acceptable verification boundary."
  - id: D3
    description: "POST /segments with an unknown or empty standard field returns 400 (not 500) — the 03-05 boundary proven over the save path, closing the CR-01 gap"
    requirement: "SEGM-01"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/segments/__tests__/segments-hardening.test.ts#CR-01: POST /segments with an unknown standard field returns 400, not 500"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/segments/__tests__/segments-hardening.test.ts#CR-01: POST /segments with an empty standard field returns 400, not 500"
        status: pass
    human_judgment: false
  - id: D4
    description: "A tags/has_tag segment round-trips create (201, memberCount 1) -> GET members (total 1, correct contact) over HTTP"
    requirement: "SEGM-01"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/segments/__tests__/segments-hardening.test.ts#SEGM-01: a tags/has_tag segment round-trips create -> members over HTTP"
        status: pass
    human_judgment: false

duration: 15min
completed: 2026-07-06
status: complete
---

# Phase 03 Plan 06: Bound Every Segment-Evaluation Path + Prove Tags/Boundary Over HTTP Summary

**statement_timeout now covers create/update/members (not just preview-count), 57014 maps to a clean 400 everywhere, and HTTP tests prove the unknown/empty-field boundary and a tags segment both work end-to-end.**

## Performance

- **Duration:** 15 min
- **Started:** 2026-07-06T04:42:00Z
- **Completed:** 2026-07-06T04:44:00Z
- **Tasks:** 2
- **Files modified:** 3 (2 modified, 1 created)

## Accomplishments
- Every path that evaluates a compiled segment definition (preview-count, create, update, members) now runs under a `statement_timeout`, applied via a parameterized `set_config('statement_timeout', $1, true)` — the last string-interpolated `SET LOCAL` in the module (in `countSegmentMembers`) was migrated too, closing IN-08.
- POST /segments, PATCH /segments/:id, and GET /:id/members each wrap their evaluation in a try/catch mapping Postgres 57014 (query canceled) to a clean HTTP 400 with a "too expensive to evaluate" message, instead of falling through to Fastify's default 500 — closing WR-03/T-03-04.
- New `segments-hardening.test.ts` proves over HTTP: an unknown standard field on POST /segments returns 400 (not 500); an empty standard field returns 400 (not 500); a `has_tag` tags segment creates with the correct `memberCount` and its members endpoint returns the tagged contact.

## Task Commits

Each task was committed atomically:

1. **Task 1: Bound every evaluation path with statement_timeout + map 57014 to 4xx (WR-03)** - `ed01f99` (feat)
2. **Task 2: HTTP-level regression tests — 400 on unknown/empty standard field + tags round-trip** - `297400a` (test)

**Plan metadata:** (this commit) `docs(03-06): complete plan`

## Files Created/Modified
- `apps/api/src/modules/segments/segment.repository.ts` - `createSegment`/`updateSegment`/`listSegmentMembers` accept `{ statementTimeoutMs? }`, applied via parameterized `set_config`; `countSegmentMembers` migrated to the same parameterized form
- `apps/api/src/modules/segments/segments.routes.ts` - `SAVE_EVAL_STATEMENT_TIMEOUT_MS` constant, `isQueryCanceledError` helper, try/catch on POST/PATCH/members mapping 57014 to 400; preview-count's existing catch refactored to reuse the same helper
- `apps/api/src/modules/segments/__tests__/segments-hardening.test.ts` - new integration test file: unknown/empty-field-over-HTTP 400 coverage, tags round-trip

## Decisions Made
- `SAVE_EVAL_STATEMENT_TIMEOUT_MS = 15000` (vs preview-count's `2000`) — saves/members are deliberate, lower-frequency actions, so a more generous bound than live-preview's per-keystroke evaluation is appropriate.
- create/update/members reject with 400 on 57014 (not a degraded response like preview-count) — there's no meaningful partial/degraded state to return for a persisted write or a members listing, unlike an unsaved live-preview count.
- `countSegmentMembers`'s pre-existing statement_timeout application was migrated to the same parameterized `set_config` form purely for consistency (no behavior change — its one caller passes a constant, never user input).

## Deviations from Plan

None — plan executed exactly as written. The plan's own Task 2 instructions explicitly excluded attempting to force a real statement_timeout cancellation on the save path in a test (no reliable automated trigger at test-data volume); this was followed as specified, and the 57014-mechanism proof continues to rely on `preview-count.test.ts`'s existing direct-SQL cancellation test.

## Issues Encountered
None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- All segment-evaluation paths (preview-count, create, update, members) are now uniformly DoS-bounded; the T-03-04 threat register entry can be marked mitigated across every affected component, not just preview-count.
- The tags-over-HTTP round-trip (create -> members) is proven at the API tier, unblocking 03-07/03-08's UI work on tags-based segments (the builder UI reachability gap is a separate, UI-side fix tracked in those plans).
- The 03-05 unknown/empty-field boundary is now regression-guarded over HTTP on the save path in addition to preview-count, closing the CR-01 finding that this path was previously untested and 500'd.

---
*Phase: 03-segmentation-engine*
*Completed: 2026-07-06*

## Self-Check: PASSED

- FOUND: apps/api/src/modules/segments/segment.repository.ts
- FOUND: apps/api/src/modules/segments/segments.routes.ts
- FOUND: apps/api/src/modules/segments/__tests__/segments-hardening.test.ts
- FOUND: .planning/phases/03-segmentation-engine/03-06-SUMMARY.md
- FOUND commit: ed01f99 (Task 1)
- FOUND commit: 297400a (Task 2)
- FOUND commit: 79655b3 (SUMMARY docs)
