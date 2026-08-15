---
phase: 15-observability-alerting-frontend-resilience
plan: 05
subsystem: ui
tags: [tanstack-query, react, error-states, empty-states, pagination, d-11]

# Dependency graph
requires:
  - phase: 15-observability-alerting-frontend-resilience
    provides: "plan 15-03's Card/Skeleton idiom and RouteSuspenseFallback sibling shape"
provides:
  - "QueryErrorState and EmptyState shared presentational components (apps/web/src/components/)"
  - "Contacts, segments and send-log data regions converted to pending -> error -> empty -> data branch order"
affects: ["15-07 (converts the remaining apps/web surfaces to the same components)"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "isFullyErrored (isError && !data) vs isStaleErrored (isError && Boolean(data)) split on every converted useQuery region -- a failed background refetch keeps showing stale rows with a banner instead of clobbering the table, since TanStack Query preserves `data` across a failed refetch (status flips to 'error', `data` is untouched)."
    - "isOutOfRange (total > 0 && page > totalPages) as an explicit third empty-shaped branch, distinct from the two total===0 branches, on the two paginated surfaces the plan named (ContactsListPage, SendLogPage)."
    - "QueryErrorState/EmptyState composed purely from Card/Button primitives, no new UI dependency, no alert primitive (none exists in this repo)."

key-files:
  created:
    - apps/web/src/components/QueryErrorState.tsx
    - apps/web/src/components/EmptyState.tsx
    - apps/web/src/components/__tests__/QueryErrorState.test.tsx
  modified:
    - apps/web/src/features/contacts/ContactsListPage.tsx
    - apps/web/src/features/contacts/ContactDetailPage.tsx
    - apps/web/src/features/contacts/ContactEventFeed.tsx
    - apps/web/src/features/contacts/CsvImportHistory.tsx
    - apps/web/src/features/segments/SegmentsListPage.tsx
    - apps/web/src/features/segments/SegmentDetailPage.tsx
    - apps/web/src/features/send-log/SendLogPage.tsx
    - apps/web/src/features/send-log/SendLogRowDrawer.tsx

key-decisions:
  - "Test QueryErrorState/EmptyState by calling the function components directly (no hooks in either) and walking the returned React element tree's props.children for the <Button> element -- no jsdom/@testing-library install needed (none exists in this repo, and this plan's own threat model forbids new dependencies), matching the same renderToStaticMarkup-based precedent already used by campaign-progress-ambiguous.test.tsx."
  - "EmptyState.description widened from string to ReactNode so ContactEventFeed's conditional API-docs link keeps working through the shared component (Rule 3 -- needed to complete the plan's own conversion of that file)."
  - "CsvImportHistory's and SegmentsListPage's secondary membersQuery (author-name/creator-name lookup) intentionally left on its existing silent degrade-to-'-' pattern, not wired to QueryErrorState -- it is enrichment on a row, not the list/detail/feed region OPS-17 targets, and this matches the pattern the codebase already established for that exact secondary query before this plan."
  - "Out-of-range-page handling added only where the plan text explicitly named it (ContactsListPage, SendLogPage) -- not added to SegmentsListPage/SegmentDetailPage's members table, which the plan's pagination clause does not name and whose existing disabled-at-bounds behavior was already correct."

requirements-completed: [OPS-17]

coverage:
  - id: D1
    description: "QueryErrorState and EmptyState shared, presentational, fully-tested components exist for the inline half of D-11"
    requirement: "OPS-17"
    verification:
      - kind: unit
        ref: "apps/web/src/components/__tests__/QueryErrorState.test.tsx (6 tests: Retry-once-per-click, disabled-while-pending, region-scoped title distinguishability, EmptyState message/CTA/no-Retry, distinctness from QueryErrorState)"
        status: pass
      - kind: other
        ref: "grep -c 'useQuery|useMutation|useNavigate|useSearchParams' on both files -> 0 for both"
        status: pass
    human_judgment: false
  - id: D2
    description: "Every contacts and segments data region (list/detail/feed/history/members) distinguishes failure from emptiness and offers a retry; ContactsListPage's pagination disables at both bounds, reports the real total, and an out-of-range page renders an explicit state"
    requirement: "OPS-17"
    verification:
      - kind: other
        ref: "grep -c QueryErrorState/EmptyState across the six files -> >=1 each; git show HEAD diff of queryKey values -> identical in all six files"
        status: pass
      - kind: unit
        ref: "npx vitest run --root apps/web -> 10 files, 64 tests pass"
        status: pass
      - kind: other
        ref: "npm run build -w apps/web (tsc --noEmit + vite build) -> exit 0"
        status: pass
    human_judgment: false
  - id: D3
    description: "The send log distinguishes a filtered-to-zero result (naming the active filters), an out-of-range page, and a failed request from one another; the row drawer's own event-timeline fetch failure stays contained to the drawer"
    requirement: "OPS-17"
    verification:
      - kind: other
        ref: "grep -c QueryErrorState on both files -> >=1 each; search-param names diffed against git show HEAD -> identical"
        status: pass
      - kind: unit
        ref: "npx vitest run --root apps/web -> pass (same 64-test suite, no send-log-specific unit test added -- covered by the shared component's own test suite plus build/lint)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Manual verification: with the API stopped, each converted region shows its error state with a working Retry; with the API running and a filter matching nothing, each shows its empty state"
    verification: []
    human_judgment: true
    rationale: "This plan's own <verification> section names this as a manual check requiring a running API/dev server. No dev server was started in this worktree execution; the automated proxies (unit tests on the shared components, build, query-key/search-param diffs against HEAD) are the closest available substitute. Requires a human or a later live-verification pass."
  - id: D5
    description: "Clicking Retry while a refetch is already in flight does not issue a duplicate request"
    verification: []
    human_judgment: true
    rationale: "The plan's own frontmatter marks this a `backstop` truth resting on TanStack Query's built-in refetch deduplication by query key, not on code this plan writes. The Retry button is `disabled={isFetching}` in every call site, which prevents a second UI click while pending, but the underlying dedup guarantee itself is a TanStack Query library behavior, not independently verified here."

# Metrics
duration: 35min
completed: 2026-08-15
status: complete
---

# Phase 15 Plan 05: Contacts/Segments/Send-Log Error, Empty & Pagination States Summary

**QueryErrorState/EmptyState shared components plus honest pending -> error -> empty -> data branch order across ContactsListPage, ContactDetailPage, ContactEventFeed, CsvImportHistory, SegmentsListPage, SegmentDetailPage, SendLogPage and SendLogRowDrawer (OPS-17, D-11 inline half).**

## Performance

- **Duration:** 35 min
- **Started:** 2026-08-15T16:06:00Z
- **Completed:** 2026-08-15T16:20:00Z
- **Tasks:** 3
- **Files modified:** 11 (3 created, 8 modified)

## Accomplishments
- Two new shared, presentational components (`QueryErrorState.tsx`, `EmptyState.tsx`) composed entirely from the existing Card/Button primitives -- no new UI dependency, no `alert` primitive (none exists in this repo). Neither fetches, reads the router, or owns query state; call sites pass their own `isError`/`isFetching`/`refetch`/`data`. Fully TDD'd (RED commit before GREEN commit) with a 6-test suite that exercises Retry-fires-once, disabled-while-pending, region-scoped-title distinguishability, and error-vs-empty visual/textual distinctness -- all without a DOM-rendering harness (none exists in this repo; direct function-call + element-tree-walk technique, matching the `renderToStaticMarkup` precedent already established by `campaign-progress-ambiguous.test.tsx`).
- `ContactsListPage`, `SegmentsListPage` and `SendLogPage` each split their `useQuery` object into `isFullyErrored` (no prior data -- full-region `QueryErrorState`) vs `isStaleErrored` (a failed background refetch that still has stale rows -- a contained banner above the still-rendered table, never a table replacement). This is provably correct against TanStack Query's own state machine: a failed refetch flips `status` to `'error'` but does not clear `data`.
- `ContactsListPage` and `SendLogPage` additionally detect `page > totalPages && total > 0` (an out-of-range page -- e.g. the last row on the last page was deleted server-side) and render an explicit "page not found" state with a "return to page 1" action, instead of an empty-looking table with mismatched "Стр. N из M" text.
- `ContactDetailPage` and `SegmentDetailPage` each had a single `if (isError || !data)` branch that conflated "failed to load" with "genuinely not found" -- both are now split into `QueryErrorState` (Retry-able) vs `EmptyState` (no Retry, a fact not a failure). `SegmentDetailPage`'s existing WR-06 ordering fix (check `isError` before the loading/skeleton branch, so a failed fetch never hangs on an infinite skeleton) is preserved.
- `ContactEventFeed` and `SegmentDetailPage`'s member table each independently handle their own fetch failure -- a failed event feed does not blank the surrounding contact detail page, and a failed member-list fetch does not blank the segment editor above it.
- `SendLogPage`'s filtered-to-zero empty state now names which filters are active (contact/campaign/цепочка/status count/period), so "no sends match this filter" reads distinctly from "we could not load your sends" -- the send log was explicitly the surface where those two previously looked identical. `SendLogRowDrawer`'s own event-timeline query gets the same fully/stale-errored split, contained entirely within the drawer.
- Verified against `git show HEAD` that queryKey values and (for `SendLogPage`) search-param names are byte-identical to before this plan across all eight converted files -- no query key, request URL or API contract changed.

## Task Commits

Each task was committed atomically:

1. **Task 1: Build the shared inline error and empty-state components** - `f194155` (test, RED) + `8731016` (feat, GREEN)
2. **Task 2: Convert the contacts and segments surfaces** - `f88699a` (feat)
3. **Task 3: Convert the send-log surface, including its pagination** - `2d11174` (feat)

_No plan-metadata commit -- per worktree instructions, STATE.md/ROADMAP.md are not touched by this agent; this SUMMARY.md is committed separately via `git add -f` (`.planning/` is gitignored in this repo)._

## Files Created/Modified
- `apps/web/src/components/QueryErrorState.tsx` (new) - Shared inline error region: region-scoped title, optional curated detail line, pending-disabled Retry button
- `apps/web/src/components/EmptyState.tsx` (new) - Shared zero-rows region: title, ReactNode description, optional action node, no Retry control ever
- `apps/web/src/components/__tests__/QueryErrorState.test.tsx` (new) - 6-test suite covering both components' `<behavior>` block and their mutual distinctness
- `apps/web/src/features/contacts/ContactsListPage.tsx` - Full/stale error split, EmptyState for both zero-rows cases, out-of-range-page state
- `apps/web/src/features/contacts/ContactDetailPage.tsx` - Split conflated isError/not-found branch; PropertiesTab's property-registry query gets pending/error branches
- `apps/web/src/features/contacts/ContactEventFeed.tsx` - Error/stale-error/empty branches around the unified timeline query, preserving the events-filter API-docs link
- `apps/web/src/features/contacts/CsvImportHistory.tsx` - Error/stale-error/empty branches around the import-history query
- `apps/web/src/features/segments/SegmentsListPage.tsx` - Same error/empty split as ContactsListPage (no out-of-range branch -- not named for this page)
- `apps/web/src/features/segments/SegmentDetailPage.tsx` - Split segmentQuery's conflated isError/not-found branch (preserving WR-06 ordering); members table gets pending/error/empty/data branches
- `apps/web/src/features/send-log/SendLogPage.tsx` - Full/stale error split, filter-naming empty state, out-of-range-page state
- `apps/web/src/features/send-log/SendLogRowDrawer.tsx` - Drawer-contained error/stale-error split around the event-timeline query

## Decisions Made
- Tested the two new components without any DOM-rendering harness: calling the function components directly (neither uses hooks) returns the exact React element tree their JSX describes, and a small `findByType` helper walks `.props.children` to locate the `<Button>` element as-authored -- no need to invoke Card/Button's own render, so no renderer or hook dispatcher is required at all. `renderToStaticMarkup` covers the remaining textual/visual-distinctness assertions. This follows the exact precedent `campaign-progress-ambiguous.test.tsx` already set for this repo's `environment: "node"` vitest lane.
- Widened `EmptyState.description` from `string` to `ReactNode` (a same-file amendment to a Task 1 deliverable, made while executing Task 2) so `ContactEventFeed`'s conditional "see the API-keys docs" link could keep working through the shared component instead of being dropped.
- Left `CsvImportHistory`'s and `SegmentsListPage`'s secondary `membersQuery` (author/creator display-name lookup) on its pre-existing silent degrade-to-`"—"` pattern rather than wiring it to `QueryErrorState` -- it is row-enrichment data, not the list/detail/feed region OPS-17's must-haves target, and this exactly matches how the codebase already treated that same query before this plan (`SegmentsListPage`'s `membersQuery` had no error handling prior to this plan either).
- Added the out-of-range-page branch only to `ContactsListPage` and `SendLogPage`, per the plan's own pagination clause naming only those two pages; `SegmentsListPage`/`SegmentDetailPage`'s pagination controls were already correctly disabled at both bounds and were left as-is to avoid scope creep beyond what the plan asked for.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] EmptyState.description needed to accept ReactNode, not just string**
- **Found during:** Task 2, converting `ContactEventFeed`'s zero-rows branch (its empty-state copy conditionally embeds a `<a href=.../>` link to the API-keys docs when `typeFilter === "events"`)
- **Issue:** `EmptyState`'s `description` prop (built in Task 1, before this call site's exact shape was known) was typed `string`, which cannot carry the conditional `<a>` link without dropping it or duplicating the whole empty-state block outside the shared component
- **Fix:** Widened `EmptyState.description` to `ReactNode` (a `string` is already a valid `ReactNode`, so no existing call site needed a change)
- **Files modified:** `apps/web/src/components/EmptyState.tsx`
- **Verification:** `npx vitest run --root apps/web` still 64/64 pass; `npm run build -w apps/web` exit 0; `ContactEventFeed`'s API-docs link renders identically to before this plan when `typeFilter === "events"` and the timeline is empty
- **Committed in:** `f88699a` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (Rule 3 - a Task 1 component's prop type needed widening to complete Task 2's own named action; not a scope expansion, the call site and its exact copy were already specified by the plan's read_first for `ContactEventFeed.tsx`)
**Impact on plan:** No scope creep -- confined to a prop-type widening on a component this plan itself introduced, needed to preserve pre-existing behavior (the API-docs link) through the conversion the plan explicitly asked for.

## Issues Encountered
- **This worktree had no `node_modules` installed** (git worktrees don't share `node_modules`, matching the same situation `15-03-SUMMARY.md` documented). Since `package-lock.json` was byte-identical between this worktree and the main checkout (both at the same base commit, main checkout clean, confirmed via `diff`), `node_modules` directories were symlinked in from the main checkout (root + `apps/{web,api,worker}` + `scripts`) purely to run `vitest`, `tsc`/`vite build`, and `eslint` for verification -- all symlinks were removed and `git status` confirmed clean before writing this SUMMARY. No symlink or `node_modules` content was ever staged or committed.
- **`npm run lint` (repo-wide) still fails with the same 19 pre-existing `@typescript-eslint` errors in `packages/queue-core/src/{dead-letter-writer.ts,error-listeners.ts,__tests__/error-listeners.test.ts}`** documented in `15-03-SUMMARY.md`, dating to phase 12's `refactor(12-10)` commit, entirely unrelated to this plan's `apps/web` changes. Confirmed out of scope per the executor's scope-boundary rule: scoped `npx eslint` runs against every file this plan touched lint clean with zero errors/warnings. Not fixed (pre-existing, unrelated files) -- flagged here for the orchestrator's broken-windows ledger.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Plan 15-07 (converts the remaining `apps/web` surfaces to the same components) can proceed -- `QueryErrorState`/`EmptyState` exist, are tested, and this plan's four converted feature areas serve as the worked reference for the `isFullyErrored`/`isStaleErrored`/`isOutOfRange` pattern.
- The manual live-verification item (API stopped -> error state with working Retry; filter matching nothing -> empty state) from this plan's own `<verification>` section was not performed in this worktree execution (no dev server/API running) -- flagged as `human_judgment: true` (D4) for a later live-verification pass, consistent with how this milestone has treated manual UI checks in prior phases.
- The `packages/queue-core` lint failures (pre-existing, phase 12) remain open and unrelated to this phase's own verification gate; flagged for the orchestrator/broken-windows ledger, not fixed here.

## Known Stubs
None. All converted regions are wired to real query data; no hardcoded empty values or placeholder copy was introduced.

## Threat Flags
None. `QueryErrorState` renders only a fixed, curated title/detail (never a raw server error body, matching T-15-13's mitigation) and every converted region's error/empty split is the exact mitigation T-15-14 names -- no new network endpoint, auth path, file-access pattern, or schema change at a trust boundary was introduced.

## Self-Check: PASSED

- All 11 created/modified files confirmed present on disk.
- All 4 commit hashes (`f194155`, `8731016`, `f88699a`, `2d11174`) confirmed present in `git log --oneline --all`.

---
*Phase: 15-observability-alerting-frontend-resilience*
*Completed: 2026-08-15*
