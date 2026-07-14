---
phase: 02-contacts-event-ingestion
plan: 09
subsystem: api
tags: [zod, drizzle, react-hook-form, contacts, crud]

# Dependency graph
requires:
  - phase: 02-contacts-event-ingestion
    provides: Contact CRUD API (02-01) and ContactForm/CustomPropertyEditor UI (02-02)
provides:
  - Full-replacement semantics for the `properties` JSONB column on PATCH (a removed key stays removed)
  - Nullable standard fields (firstName/lastName/phone/city/country) on the update path -- null is an explicit clear, undefined keeps existing
  - Regression tests proving CR-04 (property deletion, field clearing, no-wipe invariant) that fail on pre-fix code
affects: [contacts, contact-detail-page, csv-import]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "PATCH null-vs-undefined convention: undefined means 'field omitted, keep existing value'; explicit null means 'clear this field'. Applies per-field, not per-request -- properties uses the same undefined/present distinction but as full-object replacement rather than per-key clearing."

key-files:
  created: []
  modified:
    - packages/shared-schemas/src/contact.ts
    - apps/api/src/modules/contacts/contact.repository.ts
    - apps/web/src/features/contacts/ContactForm.tsx
    - apps/api/src/modules/contacts/__tests__/contact-crud.test.ts

key-decisions:
  - "properties full-replacement uses `patch.properties ?? existing.properties` (nullish coalescing), not a truthy check -- an incoming `{}` (last key removed) is a real object and replaces correctly; only `undefined` (key omitted from the request body) falls back to existing."
  - "email/externalId excluded from the null-clear mechanism -- both are identity anchors (D-01/D-06/D-07) and are never cleared through this form; ContactForm keeps them send-only-when-present in both create and edit mode."
  - "cleanPayload's null-clear behavior is edit-mode-only (isEdit param) -- create mode has no existing value to protect and the create schema doesn't accept null for these fields."

patterns-established:
  - "Repository PATCH pattern: `patch.field !== undefined ? patch.field : existing.field` for nullable-clearable columns; `patch.field ?? existing.field` for whole-object-replace columns (JSONB properties)."

requirements-completed: [CONT-01, CONT-05]

coverage:
  - id: D1
    description: "Removing a custom property (PATCH with the remaining-only object) persists -- the deleted key is gone, not silently re-merged"
    requirement: "CONT-05"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/contacts/__tests__/contact-crud.test.ts#CR-04/CONT-05: removing a custom property (PATCH with the remaining-only object) persists -- the deleted key is gone, not re-merged"
        status: pass
    human_judgment: false
  - id: D2
    description: "Clearing a standard field (firstName/phone) to null persists after reload; untouched fields (city) are unaffected"
    requirement: "CONT-01"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/contacts/__tests__/contact-crud.test.ts#CR-04/CONT-01: clearing a standard field (firstName/phone) to null persists -- untouched fields (city) are unaffected"
        status: pass
    human_judgment: false
  - id: D3
    description: "An Overview-tab edit (PATCH with no properties key) never wipes existing custom properties"
    requirement: "CONT-01"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/contacts/__tests__/contact-crud.test.ts#CR-04: an Overview-tab edit (PATCH with no properties key) never wipes existing custom properties"
        status: pass
    human_judgment: false
  - id: D4
    description: "ContactForm's edit-mode cleanPayload sends explicit null for emptied firstName/lastName/phone/city/country so the browser-driven edit flow (not just direct API PATCH) closes CR-04 end-to-end"
    requirement: "CONT-01"
    verification:
      - kind: unit
        ref: "npm run build -w apps/web (type-check on cleanPayload's edit-mode branch)"
        status: pass
    human_judgment: true
    rationale: "No component-level test exercises ContactForm's cleanPayload directly (form logic is currently only covered end-to-end via the API-level PATCH tests, which validate the server contract but not that the browser actually emits null from an emptied input). A human should verify by emptying a field in the Overview edit form and reloading the contact detail page."

# Metrics
duration: 3min
completed: 2026-07-05
status: complete
---

# Phase 02 Plan 09: Contact Edit Merge-vs-Replace Fix (CR-04) Summary

**Fixed a merge-vs-replace mismatch where contact-edit PATCH requests silently discarded property deletions and cleared standard fields while reporting success -- properties are now a full replacement and null is an explicit clear signal, both proven by three new regression tests that fail on the pre-fix code.**

## Performance

- **Duration:** 3 min (09:24:10 -> 09:25:45 across the three task commits)
- **Started:** 2026-07-05T09:23:00+05:00 (approx, prior to first commit)
- **Completed:** 2026-07-05T09:25:45+05:00
- **Tasks:** 3
- **Files modified:** 4

## Accomplishments
- Regression tests (RED) proving CR-04: property-deletion and field-clearing PATCHes failed against the pre-fix repository/schema exactly as documented in the plan, while the no-wipe invariant already passed
- Server fix (GREEN): `updateContactSchema` accepts `null` for the five clearable standard fields; `updateContact` replaces `properties` wholesale (`patch.properties ?? existing.properties`) instead of merging
- UI fix (GREEN): `ContactForm`'s `cleanPayload` sends explicit `null` for emptied clearable fields in edit mode, closing the browser-driven flow end-to-end while create mode is unaffected

## Task Commits

Each task was committed atomically:

1. **Task 1: Failing regression tests for property deletion + field clearing (RED)** - `e651ae3` (test)
2. **Task 2: Server -- properties full-replacement + null-clears-standard-field (GREEN, server half)** - `dc057f3` (fix)
3. **Task 3: UI -- form sends explicit null for emptied clearable fields (GREEN, UI half)** - `b0af5a6` (fix)

**Plan metadata:** (pending -- see final commit below)

_Note: this plan used `fix` rather than `feat` for the GREEN commits since the work closes a bug (CR-04), not a new feature -- consistent with the commit-type table in the executor workflow. The plan's frontmatter `type` is `execute`, not `tdd`, so the strict plan-level TDD gate sequence validation (which requires `feat(...)`) does not apply; the task-level `tdd="true"` RED/GREEN discipline (test commit first, confirmed failing for the documented reason, then implementation commit, confirmed passing) was followed exactly._

## Files Created/Modified
- `apps/api/src/modules/contacts/__tests__/contact-crud.test.ts` - Three new regression tests (property deletion, field clearing, no-wipe invariant)
- `packages/shared-schemas/src/contact.ts` - `updateContactSchema`'s firstName/lastName/phone/city/country gain `.nullable()`
- `apps/api/src/modules/contacts/contact.repository.ts` - `CreateContactInput`'s clearable fields widened to `string | null`; `updateContact`'s properties merge replaced with `patch.properties ?? existing.properties`
- `apps/web/src/features/contacts/ContactForm.tsx` - `cleanPayload` gains an `isEdit` parameter; emitted `null` for emptied clearable fields in edit mode only

## Decisions Made
- properties full-replacement uses nullish coalescing (`??`), not a truthy check, so an incoming `{}` (last custom property removed) is treated as a real replacement value, not "no properties sent"
- email/externalId are excluded from the null-clear mechanism in both the schema and the form -- they remain identity anchors per D-01/D-06/D-07 and were never in scope for clearing
- The null-clear behavior in `cleanPayload` is edit-mode-only, gated by whether a `contact` prop is present, so create-mode payloads are unaffected and don't send null values the create schema doesn't accept

## Deviations from Plan

None - plan executed exactly as written. Task 2's acceptance criteria anticipated Test B might still fail until Task 3 (UI half) landed, but since Test B PATCHes the API directly with `firstName: null, phone: null` (mirroring the wire contract, not going through the browser form), it already passed after the Task 2 server fix alone -- Task 3 was still required and executed to close the actual browser-driven flow (D4 above), matching the plan's stated purpose ("Full CR-04 flow is closed").

## Issues Encountered
None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- CR-04 is closed: contact edits that delete a custom property or clear a standard field now persist correctly, and the false-success-toast bug is fixed
- Regression coverage (3 new tests, 11/11 in contact-crud suite, 97/97 in the full API suite) protects this behavior going forward
- D4's human-judgment item (browser-level verification of the emptied-field flow) is deferred per this project's `human_verify_mode: end-of-phase` setting and should be included in Phase 02's end-of-phase UAT alongside the other deferred manual checks already tracked in STATE.md

---
*Phase: 02-contacts-event-ingestion*
*Completed: 2026-07-05*

## Self-Check: PASSED

All files created/modified confirmed present; all task commits (e651ae3, dc057f3, b0af5a6) confirmed in git log.
