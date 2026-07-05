---
status: resolved
trigger: "UAT Test 2 (Phase 02): contact list search loses input focus and refreshes page on every keystroke"
created: 2026-07-05T09:30:00Z
updated: 2026-07-05T09:40:00Z
mode: find_root_cause_only
symptoms_prefilled: true
---

## Current Focus

hypothesis: "CONFIRMED — full-page skeleton early-return on contactsQuery.isLoading unmounts the search Input on every debounced query-key change, because the query has no placeholderData: keepPreviousData (TanStack Query v5 treats each new search string as a brand-new query in isPending state)"
test: "Source-verified against ContactsListPage.tsx, queryClient.ts, App.tsx, components/ui/input.tsx; grep for keepPreviousData/placeholderData across apps/web/src"
expecting: "n/a — root cause confirmed with file/line evidence"
next_action: "Return ROOT CAUSE FOUND to orchestrator (find_root_cause_only mode — no fix applied)"

reasoning_checkpoint:
  hypothesis: "Each debounced search change produces a new TanStack Query key with no cached data → isLoading becomes true → the early return at ContactsListPage.tsx:178-185 replaces the entire page tree (including the search <Input>) with skeletons → the input DOM node is unmounted → browser drops focus; when the fetch resolves the input remounts without focus"
  confirming_evidence:
    - "ContactsListPage.tsx:94-98 — queryKey includes queryParams.toString() (search term); no placeholderData/keepPreviousData option"
    - "ContactsListPage.tsx:178-185 — `if (contactsQuery.isLoading) return <Skeleton/>` early return sits ABOVE the toolbar/Input render, so the Input at lines 198-203 unmounts whenever isLoading flips true"
    - "grep across apps/web/src: zero occurrences of keepPreviousData or placeholderData; queryClient.ts defaultOptions only set retry/refetchOnWindowFocus"
    - "@tanstack/react-query 5.101.2 (apps/web/package.json:29) — v5 semantics: isLoading = isPending && isFetching; a changed queryKey with no cache is isPending, so isLoading is true on every new search string, not just first load"
  falsification_test: "If the toolbar/Input stayed mounted during refetch (no early return, or keepPreviousData present), focus could not be lost by unmount; also if search were router/URL state the whole route would remount — verified it is plain useState (line 63) and the route element is stable (App.tsx:71), so unmount can only come from the isLoading early return"
  fix_rationale: "n/a — diagnose-only mode; fix direction handed to plan-phase --gaps"
  blind_spots: "Not runtime-reproduced in a browser (main-checkout read-only constraint); however the mechanism is deterministic from TanStack Query v5 documented semantics + the early-return structure, and it matches both halves of the user report (visual 'page refresh' = skeleton swap; focus loss = input unmount)"

## Symptoms

expected: "Search by email and by name filters the contact list correctly while typing. Search input keeps focus while typing; list refreshes without disrupting input (debounced)."
actual: "On each keystroke the page starts refreshing immediately and the input loses focus mid-typing; user has to paste a complete email instead of typing. Verbatim (RU): 'Всё работает, но при вводе имени или имейла в поиске страница начинает обновляться сразу и фокус слетает во время ввода в инпуте. Либо нужно вставлять уже готовый имейл в поиск, либо найти другой способ для обновления страницы во время ввода'"
errors: "None reported"
reproduction: "Test 2 in .planning/phases/02-contacts-event-ingestion/02-UAT.md — type a name or email character-by-character into the contact list search input"
started: "Discovered during Phase 2 UAT (2026-07-05); severity: major"

## Eliminated

- hypothesis: "No debounce — every keystroke triggers an immediate refetch"
  evidence: "A 300ms trailing debounce exists: useDebouncedValue at ContactsListPage.tsx:41-48, applied at line 64. Debounce delays the refetch but cannot prevent the focus loss: any typing pause ≥300ms (normal when typing an email) fires the debounce mid-entry, and the resulting isLoading skeleton swap still unmounts the input."
  timestamp: 2026-07-05T09:36:00Z

- hypothesis: "Search term lifted into URL/router state causing a route remount per keystroke"
  evidence: "searchInput is plain component useState (ContactsListPage.tsx:63); useParams reads only slug (line 60); no navigate/setSearchParams on input change; route element is stable with no key prop (App.tsx:71 `<Route path=\"contacts\" element={<ContactsListPage />} />`)."
  timestamp: 2026-07-05T09:37:00Z

- hypothesis: "Input component re-created each render (defined inside parent render function)"
  evidence: "Input is a module-level React.forwardRef component in apps/web/src/components/ui/input.tsx:7-21 — stable identity across renders. Column defs and helpers are also module-level/useMemo'd. Unmount comes from the conditional early return, not component identity churn."
  timestamp: 2026-07-05T09:37:00Z

- hypothesis: "Global QueryClient config (suspense, refetch storm) causes the remount"
  evidence: "apps/web/src/lib/queryClient.ts:4-11 sets only retry: 1 and refetchOnWindowFocus: false. No suspense mode, no global placeholderData that would mask or cause the behavior."
  timestamp: 2026-07-05T09:38:00Z

## Evidence

- timestamp: 2026-07-05T09:30:00Z
  checked: ".planning/debug/knowledge-base.md"
  found: "Knowledge base does not exist — no prior known patterns to test first"
  implication: "Proceed with open investigation"

- timestamp: 2026-07-05T09:34:00Z
  checked: "apps/web/src/features/contacts/ContactsListPage.tsx (full read)"
  found: "Line 63-64: searchInput useState + 300ms debounced `search`. Lines 83-92: queryParams memo includes search. Lines 94-98: useQuery with queryKey ['workspace', slug, 'contacts', queryParams.toString()] and NO placeholderData. Lines 178-185: `if (contactsQuery.isLoading) return <Skeleton/>` — early return ABOVE the entire page tree including the search Input (lines 198-203)."
  implication: "Every debounced search change → new queryKey → new uncached query → isLoading true → whole page (with the focused input) swapped for skeletons → input unmounted → focus lost. On fetch completion a fresh input mounts with preserved value but no focus."

- timestamp: 2026-07-05T09:35:00Z
  checked: "grep keepPreviousData|placeholderData across apps/web/src; apps/web/package.json"
  found: "Zero matches anywhere in the web app. @tanstack/react-query pinned at 5.101.2."
  implication: "In v5, isLoading = isPending && isFetching; a changed queryKey with no cached data is isPending. Without placeholderData: keepPreviousData, the skeleton branch re-triggers on every search/filter/sort/page change, not only on first load."

- timestamp: 2026-07-05T09:38:00Z
  checked: "apps/web/src/App.tsx routes (lines 55-85), apps/web/src/lib/queryClient.ts, apps/web/src/components/ui/input.tsx"
  found: "Stable route element, no key/Suspense wrappers; minimal QueryClient defaults; plain forwardRef Input."
  implication: "No alternative remount source exists — the isLoading early return is the only mechanism that unmounts the input."

## Resolution

root_cause: "ContactsListPage renders a full-page skeleton via an early return on contactsQuery.isLoading (ContactsListPage.tsx:178-185) that sits above the search toolbar in the render tree, and the contacts useQuery (lines 94-98) lacks placeholderData: keepPreviousData. In TanStack Query v5 (5.101.2), every debounced search change produces a new queryKey with no cached data, putting the query back into isPending/isLoading — so ~300ms after each typing pause the entire page tree, including the focused search <Input> (lines 198-203), is unmounted and replaced by skeletons. Unmounting the input drops browser focus to <body>; when data arrives the input remounts with its value intact but without focus. The 300ms debounce (lines 41-48, 64) only delays this — normal typing cadence for an email includes ≥300ms pauses, so it fires repeatedly mid-entry, producing the reported 'page refreshes and focus is lost while typing'."
fix: ""
verification: ""
files_changed: []
