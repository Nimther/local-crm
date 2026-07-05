---
phase: 02-contacts-event-ingestion
reviewed: 2026-07-05T10:02:22Z
depth: standard
scope: incremental (gap-closure delta, plans 02-13 and 02-14 only; prior full-phase review of 93 files at reviewed: 2026-07-05T05:12:30Z is preserved in git history)
files_reviewed: 3
files_reviewed_list:
  - apps/web/e2e/contact-search-focus.spec.ts
  - apps/web/src/features/contacts/ContactsListPage.tsx
  - apps/api/src/db/__tests__/withTenantTransaction-dead-connection.test.ts
findings:
  critical: 0
  warning: 3
  info: 5
  total: 8
status: issues_found
---

# Phase 02: Code Review Report (Incremental — Gap-Closure Delta)

**Reviewed:** 2026-07-05T10:02:22Z
**Depth:** standard
**Files Reviewed:** 3
**Status:** issues_found

## Summary

Incremental review of the Phase 02 gap-closure changes: the search-focus-loss fix in `ContactsListPage.tsx` (`placeholderData: keepPreviousData`, toolbar always mounted, skeleton scoped to results region), its Playwright regression spec, and the `withTenantTransaction` dead-connection fault-injection test.

The core fix is correct and belt-and-braces: the toolbar/input now sits above the loading conditional (mounted regardless of query state), and `keepPreviousData` prevents `isLoading` from re-triggering on keystroke-driven queryKey changes. The e2e spec's methodology is sound — `page.keyboard.type` (not `pressSequentially`/`fill`) is the right choice to avoid masking unmount-driven focus loss, and I verified the seeding path works end-to-end: `page.request.post` shares the browser context's HttpOnly session cookie, the Vite dev proxy forwards `/api` to :4000, and `POST /api/workspaces/:slug/contacts` accepts an `{ email }`-only body. The dead-connection test genuinely exercises the `withTenantTransaction` catch → ROLLBACK-fails → `client.release(err)` destroy path (verified against `packages/tenant-context/src/index.ts:80-94`), and its pool-recovery assertion (6 sequential transactions, none receiving the doomed pid) is valid evidence.

No critical issues. Three warnings: a guaranteed duplicate network request (stale-page fetch) on every filter change from page > 1, unhandled query-error state that renders as "no contacts", and a dim-cue condition broader than its documented intent. Five info items, mostly test hygiene.

## Warnings

### WR-01: Filter/search change while on page > 1 fires a wasted stale-page request before the page-reset effect runs

**File:** `apps/web/src/features/contacts/ContactsListPage.tsx:72-74, 84-100`
**Issue:** `page` is reset to 1 in a `useEffect` reacting to `[search, status, tag, sorting]`. Effects run *after* render/commit, so when the debounced `search` (or status/tag/sort) changes while `page > 1`, the component first renders with the new filter and the **old** page, producing a new queryKey (e.g., `search=maria&page=3`) that fires a real network request. One tick later the effect resets `page` to 1 and a second request fires (`search=maria&page=1`). Every filter change from a deep page costs a guaranteed throwaway fetch, and if the abandoned key happens to have cached data, `keepPreviousData` will briefly display that wrong-page result before the page-1 key takes over. This interaction became more visible with the `keepPreviousData` change (both requests now render data rather than a skeleton).
**Fix:** Reset the page in the same render pass instead of an effect, using React's supported render-phase state adjustment:
```tsx
const filterKey = `${search.trim()}|${status ?? ""}|${tag ?? ""}|${sort ?? ""}`;
const [prevFilterKey, setPrevFilterKey] = useState(filterKey);
if (prevFilterKey !== filterKey) {
  setPrevFilterKey(filterKey);
  if (page !== 1) setPage(1); // re-renders before commit: the stale-page queryKey never reaches useQuery
}
```
(Remove the `useEffect` at lines 72-74.)

### WR-02: Query error state is unhandled — an API failure renders as "Пока нет ни одного контакта" / "Нет контактов по заданным фильтрам"

**File:** `apps/web/src/features/contacts/ContactsListPage.tsx:102-104, 257-281`
**Issue:** `contactsQuery.isError` is never checked. When the list request fails (network error, 500, expired session on refetch), `isLoading` is false and `data` is `undefined`, so `items = []`, `total = 0`, and the component renders the empty-state card affirmatively claiming the workspace has no contacts (or "no contacts match the filters" if a search is active) — a false statement about the user's data with no retry affordance. This state was reachable before the change too, but the delta rewrote exactly this rendering branch without adding the missing arm, and `keepPreviousData` adds a new path into it: a mid-typing refetch that exhausts retries drops from "previous data shown" straight into the false empty state.
**Fix:** Add an error arm before the empty-state checks:
```tsx
{isInitialLoad ? (
  <Skeleton className="h-96 w-full" />
) : contactsQuery.isError ? (
  <Card>
    <CardHeader>
      <CardTitle>Не удалось загрузить контакты</CardTitle>
      <CardDescription>
        {contactsQuery.error instanceof Error ? contactsQuery.error.message : "Попробуйте ещё раз."}
      </CardDescription>
    </CardHeader>
    <CardContent>
      <Button variant="outline" onClick={() => contactsQuery.refetch()}>Повторить</Button>
    </CardContent>
  </Card>
) : ( /* existing branches */ )}
```

### WR-03: Dim-cue condition is broader than its documented intent — results region dims on every background revalidation (window focus, reconnect)

**File:** `apps/web/src/features/contacts/ContactsListPage.tsx:185-188, 262`
**Issue:** The comment states the dim cue is for "an in-flight refetch of an already-loaded page (new queryKey reusing placeholder data)", but the implementation is `contactsQuery.isPlaceholderData || contactsQuery.isFetching`. `isFetching` is true during *any* fetch, including TanStack Query's default `refetchOnWindowFocus` and `refetchOnReconnect` revalidations of the *current* key — so the entire table flashes to 50% opacity every time the user re-focuses the tab, even when the displayed data is current. Additionally, `isPlaceholderData` is redundant in this disjunction: whenever placeholder data is displayed, a fetch for the new key is in flight, so `isFetching` is already true — the left operand can never independently be true.
**Fix:** Use `isPlaceholderData` alone; it is true exactly in the intended case (previous key's data shown while the new key loads):
```tsx
const isRefetching = contactsQuery.isPlaceholderData;
```

## Info

### IN-01: Ineffective `process.env.DATABASE_URL` assignment in `beforeAll` — the shared pool is constructed at module import time

**File:** `apps/api/src/db/__tests__/withTenantTransaction-dead-connection.test.ts:19`
**Issue:** `pool` (`packages/tenant-context/src/index.ts:15`) is created with `process.env.DATABASE_URL` **at import time**, before any `beforeAll` runs. The assignment `process.env.DATABASE_URL = getTestDatabaseUrl()` therefore has no effect on the pool under test; the test only works because `apps/api/vitest.config.ts` `test.env` injects `DATABASE_URL = TEST_DATABASE_URL` before module load. The line is dead code (copied from `rls-pooling-chaos.test.ts:23`) that encodes a wrong mental model — a future author could rely on it to point the pool at a different DB and silently fail to. No incorrect behavior is currently reachable: if `TEST_DATABASE_URL` is unset, `apps/api/src/test/db-fixture.ts:12-18` throws before any query runs.
**Fix:** Delete the assignment (in both this file and the sibling) or replace it with a comment noting the pool's target DB is fixed by `vitest.config.ts` `test.env` at import time.

### IN-02: Comment overstates what the `pg_stat_activity` check proves

**File:** `apps/api/src/db/__tests__/withTenantTransaction-dead-connection.test.ts:76-80`
**Issue:** The comment says "Prove the backend was genuinely destroyed (not just marked)" — but the query only proves the *server-side backend process* exited, which `pg_terminate_backend` guarantees independently of anything `withTenantTransaction` does. It says nothing about the client-side destroy path (`client.release(err)`), which is the behavior under test. The actual evidence for the destroy path is the subsequent 6-transaction pid loop (lines 84-99), which is sound.
**Fix:** Reword, e.g. "Sanity check: the server backend is gone, so any pool client still holding this pid is necessarily dead."

### IN-03: Fixed 100 ms sleep for termination propagation is a mild flake risk on loaded CI

**File:** `apps/api/src/db/__tests__/withTenantTransaction-dead-connection.test.ts:60-62`
**Issue:** The test sleeps a fixed 100 ms for the server-initiated termination to land on the client socket. In almost all orderings the assertion holds even if the event hasn't landed (the follow-up `SELECT 1` or the `COMMIT` fails against the dead backend), but on a heavily loaded CI host there is a narrow window where the remaining transaction could race SIGTERM processing. Low probability; noted for awareness.
**Fix (optional):** Poll instead of sleeping — retry `client.query("SELECT 1")` in a short loop until it rejects (bounded by the test timeout).

### IN-04: E2E spec accumulates users/workspaces/contacts in the local dev database with no cleanup

**File:** `apps/web/e2e/contact-search-focus.spec.ts:19-44`
**Issue:** Each run registers a new `owner-${Date.now()}@example.com` user, creates a workspace, and seeds 2 contacts against the dev database (`playwright.config.ts` runs the real stack). Nothing is cleaned up. This matches the pre-existing pattern in `register-create-workspace.spec.ts`, so it is consistent — but repeated runs steadily pollute the dev DB.
**Fix:** Acceptable for now given the established pattern; consider a shared e2e teardown or a dedicated e2e database when the suite grows.

### IN-05: Refetch dim cue is opacity-only — not conveyed to assistive technology

**File:** `apps/web/src/features/contacts/ContactsListPage.tsx:262`
**Issue:** The in-flight-refetch state is communicated solely via `opacity-50` on the results region. Screen-reader users get no indication that displayed results are stale/being replaced.
**Fix:** Add `aria-busy={isRefetching}` to the results-region `div`; optionally a visually-hidden live region announcing "Обновление результатов…".

---

_Reviewed: 2026-07-05T10:02:22Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
