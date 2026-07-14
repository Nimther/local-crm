---
phase: 02-contacts-event-ingestion
plan: 13
subsystem: ui
tags: [react, tanstack-query, playwright, contacts]

# Dependency graph
requires:
  - phase: 02-contacts-event-ingestion
    provides: "02-02: ContactsListPage (search/filter/sort/pagination list view, CONT-01/D-13)"
provides:
  - "ContactsListPage list query no longer unmounts the search toolbar/input on every debounced keystroke"
  - "Playwright regression (contact-search-focus.spec.ts) guarding char-by-char search typing"
affects: [contacts, ui-review, phase-02-uat]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "TanStack Query v5 list views use placeholderData: keepPreviousData so a changed queryKey (search/filter/sort/page) stays in 'success' status instead of re-entering isPending/isLoading; isLoading is reserved for the genuine first load only"
    - "List-page skeletons are scoped to the results region, never a full-page early return above the header/toolbar -- the toolbar/input must never be behind a conditional that can unmount it"
    - "In-flight refetches on an already-loaded page are surfaced via a dim/opacity cue (isPlaceholderData || isFetching) on the results container, not a remount"

key-files:
  created:
    - apps/web/e2e/contact-search-focus.spec.ts
  modified:
    - apps/web/src/features/contacts/ContactsListPage.tsx

key-decisions:
  - "Playwright RED test uses page.keyboard.type (not locator.pressSequentially/fill) because locator-based typing re-focuses the element before each keypress, which would mask the exact unmount-driven focus loss under test"
  - "Skeleton import kept, now used only inside the results region for the genuine first-load state"

patterns-established:
  - "Pattern: keepPreviousData + results-scoped skeleton + isPlaceholderData/isFetching dim cue is the standard shape for any future paginated/filterable list view in this codebase"

requirements-completed: []

coverage:
  - id: D1
    description: "Typing a search term character-by-character into the contact list search input keeps the input focused throughout; no keystroke is dropped and the caret is never lost to <body> while the list refetches (UAT Test 2 closed)"
    verification:
      - kind: e2e
        ref: "apps/web/e2e/contact-search-focus.spec.ts#typing character-by-character into the contact search keeps focus and accumulates the value"
        status: pass
    human_judgment: false
  - id: D2
    description: "The contact list refetches results for a new search/filter/sort/page term without unmounting the search toolbar or input; the full-page skeleton appears only on the genuine first load, never on subsequent changes"
    verification:
      - kind: e2e
        ref: "apps/web/e2e/contact-search-focus.spec.ts#typing character-by-character into the contact search keeps focus and accumulates the value"
        status: pass
      - kind: other
        ref: "npm run build -w apps/web (tsc --noEmit + vite build)"
        status: pass
    human_judgment: true
    rationale: "The e2e spec proves focus/value preservation programmatically, but the visual quality of the dim refetch cue vs. the full-page skeleton (no flash, correct scoping) is a subjective rendering judgment best confirmed by a human re-running UAT Test 2 by hand, per the plan's own human-check verification step."

duration: 13min
completed: 2026-07-05
status: complete
---

# Phase 2 Plan 13: Contact List Search Focus Loss (Gap Closure) Summary

**Fixed ContactsListPage's list query with `placeholderData: keepPreviousData` and moved the loading skeleton out of a page-wide early return into the results region only, so the search toolbar/input never unmount mid-typing — closing UAT Test 2.**

## Performance

- **Duration:** 13 min
- **Started:** 2026-07-05T14:36:17+05:00
- **Completed:** 2026-07-05T14:49:15+05:00
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- Added a deterministic Playwright RED/GREEN regression (`contact-search-focus.spec.ts`) that types character-by-character via `page.keyboard.type` and asserts focus + accumulated value after every debounced refetch — confirmed RED (value truncated to `"m"`, focus dropped to `<body>`) before the fix, GREEN after.
- Root-caused fix applied to `ContactsListPage.tsx`: `placeholderData: keepPreviousData` on the contacts query keeps the query in `'success'` status across search/filter/sort/page changes, so `isLoading` is true only on the genuine first load.
- Removed the full-page skeleton early-return that sat above the header/toolbar; the header and search/filter toolbar are now unconditionally part of the returned JSX tree and can never be unmounted by a refetch.
- Scoped the initial-load skeleton to the results region only, and added a lightweight dim/opacity cue (`isPlaceholderData || isFetching`) on the results container for in-flight refetches — the search input itself is never dimmed or disabled.

## Task Commits

Each task was committed atomically:

1. **Task 1: Failing Playwright regression — search input loses focus while typing (RED)** - `0206f7c` (test)
2. **Task 2: Keep the search toolbar mounted during refetch — keepPreviousData + results-scoped skeleton (GREEN)** - `685d130` (fix)

**Plan metadata:** (pending — final docs commit follows this SUMMARY)

## Files Created/Modified
- `apps/web/e2e/contact-search-focus.spec.ts` - Playwright regression: types "maria@example.com" one character at a time with 350ms pauses (exceeding the 300ms debounce), asserting focus after every character and the full accumulated value at the end.
- `apps/web/src/features/contacts/ContactsListPage.tsx` - Imports `keepPreviousData`; adds it to `contactsQuery`; replaces the full-page skeleton early-return with an `isInitialLoad` skeleton scoped to the results region and an `isRefetching` dim-opacity wrapper around the existing empty-state/table/pagination block. Header and search/filter toolbar are now always rendered.

## Decisions Made
- Used `page.keyboard.type` instead of `locator.pressSequentially`/`locator.fill` in the regression test — locator-based typing re-focuses the element before each keystroke, which would have masked the exact unmount-driven focus loss this test exists to catch (documented in-file as a code comment per the plan's instruction).
- Kept the `Skeleton` import and reused it only inside the results region for the first-load case, per the plan's explicit instruction not to drop it.

## Deviations from Plan

None - plan executed exactly as written. Both tasks matched the plan's file list, task actions, and verification steps precisely; no Rule 1-4 fixes were needed.

## Issues Encountered

None. Local dev stack (Postgres on :5432, Redis, Playwright Chromium) was already available in this environment, so both the RED and GREEN Playwright runs executed directly rather than requiring a fallback verification path.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- UAT Test 2 (major) is closed: the regression test is green and the plan's automated build check (`npm run build -w apps/web`) is clean.
- Human re-verification of the visual dim-cue quality (D2's `human_judgment: true` deliverable) remains open per the plan's own `<human-check>` verification step — carry forward to phase-level UAT alongside other Phase 2 deferred manual checks.
- No new dependencies, no schema changes, no new endpoints — this plan only adjusted client-side render/caching behavior for an already-working feature (CONT-01/D-13).

---
*Phase: 02-contacts-event-ingestion*
*Completed: 2026-07-05*

## Self-Check: PASSED

- FOUND: apps/web/e2e/contact-search-focus.spec.ts
- FOUND: apps/web/src/features/contacts/ContactsListPage.tsx
- FOUND commit: 0206f7c
- FOUND commit: 685d130
