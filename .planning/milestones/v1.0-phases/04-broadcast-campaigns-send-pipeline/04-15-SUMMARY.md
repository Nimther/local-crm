---
phase: 04-broadcast-campaigns-send-pipeline
plan: 15
subsystem: api
tags: [zod, shared-schemas, campaigns, segments, pagination, gap-closure]

# Dependency graph
requires:
  - phase: 04-broadcast-campaigns-send-pipeline
    provides: segmentListQuerySchema/campaignListQuerySchema (04-01), CampaignBuilderPage/CampaignsListPage (04-08)
provides:
  - Shared EXHAUSTIVE_LOOKUP_PAGE_SIZE=200 constant in @mega-crm/shared-schemas
  - Widened segmentListQuerySchema/campaignListQuerySchema pageSize bound (100 -> 200)
  - Three web call sites (segment picker, campaigns-list segment-name lookup, D-03 warning) wired to the shared constant
affects: [phase-04-uat, campaigns, segments]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Client/server bounded-value contracts (e.g. pagination ceilings) live as a single exported constant in shared-schemas, imported by both the Zod schema and every client call site, with a regression test pinning the exact value both sides agree on."

key-files:
  created:
    - packages/shared-schemas/src/pagination.ts
    - packages/shared-schemas/src/__tests__/pagination.test.ts
  modified:
    - packages/shared-schemas/src/index.ts
    - packages/shared-schemas/src/segment.ts
    - packages/shared-schemas/src/campaign.ts
    - apps/web/src/features/campaigns/CampaignBuilderPage.tsx
    - apps/web/src/features/campaigns/CampaignsListPage.tsx
    - apps/web/src/features/segments/SegmentDetailPage.tsx

key-decisions:
  - "EXHAUSTIVE_LOOKUP_PAGE_SIZE=200 is a single exported constant in a new pagination.ts module, imported by both list-query Zod schemas (raising their max bound) and all three web exhaustive-lookup call sites, so the client/server contract cannot silently drift again."
  - "segmentMembersQuerySchema left untouched (still max(100)) — it was out of scope for this gap; only the two list-query schemas whose call sites actually requested 200 were widened."

patterns-established:
  - "Bounded pagination ceilings shared between Zod schema and client fetch call sites via one exported numeric constant + a contract-pinning test (value accepted by schema, value+1 rejected)."

requirements-completed: [CAMP-01, CAMP-02]

coverage:
  - id: D1
    description: "segmentListQuerySchema and campaignListQuerySchema accept pageSize=EXHAUSTIVE_LOOKUP_PAGE_SIZE (200) and still reject 201, non-integers, and <1; both still default to 20 when omitted."
    requirement: CAMP-01
    verification:
      - kind: unit
        ref: "packages/shared-schemas/src/__tests__/pagination.test.ts#EXHAUSTIVE_LOOKUP_PAGE_SIZE contract"
        status: pass
    human_judgment: false
  - id: D2
    description: "Campaign builder's segment picker (CampaignBuilderPage), campaigns-list segment-name lookup (CampaignsListPage), and D-03 scheduled-campaign warning (SegmentDetailPage) all request pageSize=EXHAUSTIVE_LOOKUP_PAGE_SIZE instead of a raw 200 literal, and the web workspace typechecks/builds clean with no residual literal."
    requirement: CAMP-02
    verification:
      - kind: unit
        ref: "npm run build -w @mega-crm/web (tsc --noEmit + vite build) — clean"
        status: pass
    human_judgment: true
    rationale: "Live confirmation that the actual GET requests now return 2xx (not 400) requires the running app/API and the phase-level UAT re-run of Test 3 and Test 12 — carried forward to phase UAT per human_verify_mode: end-of-phase."

duration: 15min
completed: 2026-07-06
status: complete
---

# Phase 04 Plan 15: Shared pagination-ceiling gap closure Summary

**Introduced a single shared `EXHAUSTIVE_LOOKUP_PAGE_SIZE=200` constant in `@mega-crm/shared-schemas`, widened `segmentListQuerySchema`/`campaignListQuerySchema`'s `pageSize` bound to reference it, and repointed all three Phase-4 web exhaustive-lookup call sites (segment picker, campaigns-list segment-name lookup, D-03 scheduled-campaign warning) at the same constant — closing the UAT Test 3 400 blocker and the two silent 400s it masked.**

## Performance

- **Duration:** ~15 min
- **Completed:** 2026-07-06T23:11Z
- **Tasks:** 2/2
- **Files modified:** 8 (2 created, 6 modified)

## Accomplishments

- Root-caused client/server pageSize mismatch (client sent 200, both list-query schemas capped at `max(100)`) is now closed by a single source-of-truth constant instead of three independent literal edits.
- `segmentListQuerySchema` and `campaignListQuerySchema` both accept `pageSize=200` while still rejecting `201` — the bound stayed finite, only the ceiling moved.
- A new `pagination.test.ts` contract test pins the exact value the client sends against both schemas, so this specific client/server drift cannot recur silently.
- All three affected web call sites (`CampaignBuilderPage`'s `SegmentPicker`, `CampaignsListPage`'s segment-name lookup, `SegmentDetailPage`'s D-03 referencing-campaigns query) now import and use the shared constant instead of a hardcoded `200` literal.

## Task Commits

Each task was committed atomically (TDD RED → GREEN for Task 1):

1. **Task 1: Add shared EXHAUSTIVE_LOOKUP_PAGE_SIZE constant, widen both list schemas, pin the contract with a test**
   - `e67113f` (test — RED: pagination.test.ts fails against the still-max(100) schemas)
   - `c169dda` (feat — GREEN: both schemas widened, pagination.test.ts passes 18/18)
2. **Task 2: Point all three web exhaustive-lookup call sites at the shared constant** - `b54219d` (fix)

**Plan metadata:** _(pending — see final commit below)_

_Note: Task 1 followed the plan's `tdd="true"` RED/GREEN cycle; no REFACTOR commit was needed._

## Files Created/Modified

- `packages/shared-schemas/src/pagination.ts` - Exports `EXHAUSTIVE_LOOKUP_PAGE_SIZE = 200` with a doc comment explaining its role as the shared client/server pagination ceiling for low-cardinality exhaustive lookups.
- `packages/shared-schemas/src/__tests__/pagination.test.ts` - Regression test: both list schemas accept the constant and yield it back, still reject constant+1, still reject <1/non-integers, still default to 20.
- `packages/shared-schemas/src/index.ts` - Added `export * from "./pagination.js"`.
- `packages/shared-schemas/src/segment.ts` - `segmentListQuerySchema.pageSize` now `.max(EXHAUSTIVE_LOOKUP_PAGE_SIZE)` (was `.max(100)`); `segmentMembersQuerySchema` left untouched (out of scope).
- `packages/shared-schemas/src/campaign.ts` - `campaignListQuerySchema.pageSize` now `.max(EXHAUSTIVE_LOOKUP_PAGE_SIZE)` (was `.max(100)`).
- `apps/web/src/features/campaigns/CampaignBuilderPage.tsx` - `SegmentPicker`'s `listSegments` call now passes `pageSize: EXHAUSTIVE_LOOKUP_PAGE_SIZE`.
- `apps/web/src/features/campaigns/CampaignsListPage.tsx` - Segment-name lookup's `listSegments` call now passes `pageSize: EXHAUSTIVE_LOOKUP_PAGE_SIZE`.
- `apps/web/src/features/segments/SegmentDetailPage.tsx` - D-03 referencing-campaigns `listCampaigns` call now passes `pageSize: EXHAUSTIVE_LOOKUP_PAGE_SIZE`.

## Decisions Made

- Single shared exported constant (not independent per-file literals) so the client request value and both schema bounds are structurally guaranteed to agree, with a test pinning that guarantee.
- Only the two list-query schemas whose call sites actually requested 200 were widened; `segmentMembersQuerySchema` (member list, Phase-3 callers already within the 100 bound) was deliberately left untouched per the plan's explicit scope boundary.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- The three previously-400ing requests (segment picker, campaigns-list segment-name lookup, D-03 warning) now pass their schema validation; `npm run build -w @mega-crm/web` and `npm run test -w @mega-crm/shared-schemas` are both clean.
- Live confirmation (UAT Test 3 re-run: segment picker lists selectable segments; UAT Test 12: D-03 warning renders for a segment referenced by a scheduled campaign) is carried forward to phase-level UAT per `human_verify_mode: end-of-phase` — no running dev server was available in this execution session to drive a live HTTP request.

---
*Phase: 04-broadcast-campaigns-send-pipeline*
*Completed: 2026-07-06*

## Self-Check: PASSED

All 8 created/modified files verified present on disk; all 3 task commits (e67113f, c169dda, b54219d) verified in git log.
