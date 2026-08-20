---
phase: 06-flows-triggered-chains
plan: 23
subsystem: ui
tags: [react, csv-import, timezone, contacts]

# Dependency graph
requires:
  - phase: 06-flows-triggered-chains
    provides: "06-22's server-side defaultTimezone acceptance in csvDryRunRequestSchema and applyCsvRowMapping"
provides:
  - "CSV import mapping step renders the constrained IANA TimezoneCombobox as a per-import default-timezone control"
  - "dry-run POST body threads defaultTimezone (only when set) into the 06-22 server-side default-application path"
affects: [contacts, csv-import, uat]

# Tech tracking
tech-stack:
  added: []
  patterns: []

key-files:
  created: []
  modified:
    - apps/web/src/features/contacts/CsvImportWizard.tsx

key-decisions:
  - "Reused the existing TimezoneCombobox component verbatim (same directory) rather than building a new control -- matches contact form and workspace send settings for a consistent constrained-IANA-zone UX"
  - "defaultTimezone omitted from the dry-run POST body entirely when unset (spread conditional), not sent as null/empty -- preserves backward compatibility with imports that map their own timezone column"

patterns-established: []

requirements-completed: [FLOW-05]

coverage:
  - id: D1
    description: "MappingStep renders a labelled 'Часовой пояс по умолчанию' TimezoneCombobox (constrained IANA zones, no free text) near the duplicate-policy control"
    requirement: FLOW-05
    verification:
      - kind: unit
        ref: "npm run build -w apps/web (tsc --noEmit && vite build)"
        status: pass
    human_judgment: true
    rationale: "Visual rendering and dropdown behavior require a live browser walk of UAT Test 10 -- the web unit lane is node-only (no jsdom/@testing-library) per project convention, so render correctness cannot be asserted by an automated test in this repo"
  - id: D2
    description: "Selecting a default timezone includes it in the dry-run POST body; leaving it unset omits the field entirely (backward-compatible)"
    requirement: FLOW-05
    verification:
      - kind: unit
        ref: "npm run build -w apps/web (tsc --noEmit confirms dry-run body matches csvDryRunRequestSchema)"
        status: pass
    human_judgment: true
    rationale: "Runtime request-body behavior (conditional spread firing correctly across both branches) is best confirmed by the same live UAT Test 10 re-run that verifies the rendered control"

duration: 6min
completed: 2026-07-13
status: complete
---

# Phase 06 Plan 23: CSV Import Default-Timezone Combobox Summary

**MappingStep now renders the constrained IANA TimezoneCombobox as a per-import default-timezone control, closing the user-facing half of UAT Test 10's reported gap.**

## Performance

- **Duration:** 6 min
- **Started:** 2026-07-13T16:35:04Z
- **Completed:** 2026-07-13T16:41:07Z
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments
- CSV column-mapping step (`MappingStep`) imports and renders the existing `TimezoneCombobox` (same component used by the contact form and workspace send settings) as a labelled "Часовой пояс по умолчанию" control, with helper text explaining it applies to imported rows without their own timezone value.
- The dry-run mutation's POST body now conditionally includes `defaultTimezone` only when a zone is chosen, matching the 06-22 `csvDryRunRequestSchema` and staying backward-compatible with imports that map their own timezone column.
- `npm run build -w apps/web` (tsc --noEmit + vite build) passes, confirming the new request shape typechecks against the extended shared schema.

## Task Commits

Each task was committed atomically:

1. **Task 1: Render the default-timezone TimezoneCombobox in the CSV mapping step** - `52e2cf1` (feat)

**Plan metadata:** (pending — final docs commit follows this SUMMARY)

## Files Created/Modified
- `apps/web/src/features/contacts/CsvImportWizard.tsx` - MappingStep imports TimezoneCombobox, adds `defaultTimezone` state, renders the labelled combobox near the duplicate-policy RadioGroup, and threads the selection into the dry-run POST body conditionally.

## Decisions Made
- Reused `TimezoneCombobox` verbatim (no new component) -- consistent constrained-IANA-zone UX with the contact form and workspace send settings, and avoids re-implementing the Intl.supportedValuesOf-backed search/clear interaction.
- `defaultTimezone` is spread into the dry-run body only when truthy (`...(defaultTimezone ? { defaultTimezone } : {})`), so an unset control sends no field at all rather than `null` -- matches the plan's literal backward-compatibility requirement.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- The mapping surface now visibly renders the promised timezone dropdown; UAT Test 10's re-run (deferred to end-of-phase human_verify per project convention) should confirm the searchable «Часовой пояс по умолчанию» control lists IANA zones at `/w/{slug}/contacts/import`.
- No blockers for downstream phase-06 plans.

---
*Phase: 06-flows-triggered-chains*
*Completed: 2026-07-13*

## Self-Check: PASSED

- FOUND: apps/web/src/features/contacts/CsvImportWizard.tsx
- FOUND: 52e2cf1
