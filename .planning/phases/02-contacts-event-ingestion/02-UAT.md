---
status: testing
phase: 02-contacts-event-ingestion
source: [02-VERIFICATION.md]
started: 2026-07-05T05:20:34Z
updated: 2026-07-05T10:10:41Z
---

## Current Test

number: 12
name: Re-confirm search keeps focus while typing (02-13 fix)
expected: |
  On the contact list, type a name or email into search character-by-character: focus stays in the input the whole time, no full-page skeleton flash; the table dims briefly while refreshing and updates with filtered results.
awaiting: user response

## Tests

### 1. Create contact with tag and custom property
expected: Create a contact with an email, a tag, and one custom property — toast «Контакт создан» and the contact appears in the list with tag and property visible.
result: pass

### 2. List search, filters, sort, pagination
expected: Search by email and by name; apply the status filter and a tag filter; sort a column; page forward/back. Each interaction filters/sorts/paginates correctly; filtered-empty copy shows when nothing matches.
result: pass
reported: "Всё работает, но при вводе имени или имейла в поиске страница начинает обновляться сразу и фокус слетает во время ввода в инпуте. Либо нужно вставлять уже готовый имейл в поиск, либо найти другой способ для обновления страницы во время ввода"
severity: major
note: "Focus-loss issue fixed by plan 02-13 (keepPreviousData + always-mounted toolbar); verified by Playwright regression apps/web/e2e/contact-search-focus.spec.ts (RED before fix, GREEN after; independently re-run by verifier). Human re-confirmation tracked as test 12."

### 3. Edit contact — remove property, clear field, reload (CR-04 end-to-end)
expected: Open a contact; add a custom property, then remove one, then clear the phone field; save. Reload the page. Removed property stays removed, cleared field stays cleared, untouched fields (e.g. city) are unaffected.
result: pass

### 4. Duplicate email inline error (D-07)
expected: Attempting to create a second contact with the same email shows inline «Этот email уже используется другим контактом…» copy.
result: pass

### 5. external_id read-only display (D-06)
expected: A contact with a set external_id shows it read-only with the D-06 helper text.
result: pass

### 6. Full CSV import wizard flow (D-16)
expected: Upload a small CSV, map columns (including «Создать новое свойство…»), choose duplicate policy, run dry-run, confirm the three stat cards, apply, watch progress bar, navigate away and back into the import from history. Dry-run writes nothing; apply progresses and resumes correctly on re-entry; completion report shows correct counts.
result: pass

### 7. Error CSV download + import history (D-18/D-20)
expected: On a CSV import with errors, download the error CSV and confirm the reason column; import history lists the run with file, date, author, and summary.
result: pass

### 8. Oversized CSV upload rejected (WR-04, 02-12 D4)
expected: Uploading a CSV larger than the 50MB limit sets import status to 'failed' and the upload responds 413, instead of hanging or silently truncating.
result: pass
note: "Frontend rejects >50MB file with an error before upload starts — clean rejection observed (no hang/truncation). Server-side 413 path covered by automated tests (02-12 D4)."

### 9. Live event feed on contact card (D-14)
expected: Send a test event for a contact via POST /v1/events (API key from 02-03) or seed one; the contact's События tab shows the event with name, relative time, and an expandable JSON payload.
result: pass

### 10. UI-SPEC visual fidelity
expected: Spacing/typography/color and Russian copy match the Phase 2 UI-SPEC across the contact list/form/detail and CSV wizard.
result: pass

### 11. WR-09 dead-connection-destroy sign-off (02-11 D4)
expected: Review the WR-09 dead-pooled-connection-destroy reasoning (source assertion only — no fault-injection test exists in this suite). Either accept the source-assertion-only proof, or request a follow-up plan to add fault-injection coverage before Phase 4 (send pipeline) depends on this same connection-pool path at much higher volume.
result: pass
source: automated
note: "Follow-up delivered by plan 02-14: fault-injection test apps/api/src/db/__tests__/withTenantTransaction-dead-connection.test.ts kills the backend mid-transaction (pg_terminate_backend), asserts destroy-on-error (pid gone from pg_stat_activity, never reused) and pool recovery across 6 subsequent transactions. Passing; independently re-run by verifier. Original follow-up request note preserved in git history."

### 12. Re-confirm search keeps focus while typing (02-13 fix)
expected: On the contact list, type a name or email into search character-by-character — focus stays in the input the whole time, no full-page skeleton flash; the table dims briefly while refreshing and updates with filtered results.
result: [pending]

### 13. Dim refetch cue visual quality (02-13 D2 human-check)
expected: While the list refreshes (search/filter change), the results region dims subtly instead of swapping to a skeleton — the cue reads as "updating", is not jarring, and matches the UI-SPEC visual tone.
result: [pending]

## Summary

total: 13
passed: 11
issues: 0
pending: 2
follow_up_requested: 0
skipped: 0
blocked: 0

## Gaps

- truth: "WR-09 dead-pooled-connection-destroy path is proven only by source assertion, no fault-injection test"
  status: resolved
  resolution: "Plan 02-14 added apps/api/src/db/__tests__/withTenantTransaction-dead-connection.test.ts — passing, independently re-run by verifier (re-verification #2)."
  reason: "Sign-off declined as-is. Need a fault-injection test (simulate mid-transaction connection death, e.g. pg_terminate_backend) exercising withTenantTransaction's release-with-error branch, before Phase 4 (send pipeline) increases write concurrency on this same code path."
  severity: major
  test: 11
  root_cause: "Coverage gap, not a code defect: no fault-injection test exists that kills a pooled connection mid-transaction, so WR-09's destroy-on-error behavior rests on source assertion only. No debug investigation needed — the missing artifact is the test itself."
  artifacts: []
  missing: ["fault-injection test for withTenantTransaction release-with-error path (e.g. pg_terminate_backend mid-transaction; assert connection is destroyed, not returned to pool, and pool recovers)"]
  debug_session: ""

- truth: "Search input keeps focus while typing; list refreshes without disrupting input (debounced)"
  status: resolved
  resolution: "Plan 02-13 fixed ContactsListPage.tsx (placeholderData: keepPreviousData; toolbar always mounted; skeleton scoped to results). Playwright regression contact-search-focus.spec.ts RED→GREEN; human re-confirmation = test 12."
  reason: "User reported: Всё работает, но при вводе имени или имейла в поиске страница начинает обновляться сразу и фокус слетает во время ввода в инпуте. Либо нужно вставлять уже готовый имейл в поиск, либо найти другой способ для обновления страницы во время ввода"
  severity: major
  test: 2
  root_cause: "Full-page skeleton early return on contactsQuery.isLoading sits above the search toolbar, and the contacts useQuery has no placeholderData: keepPreviousData. Each debounced search change creates a new queryKey with no cached data → query re-enters isPending/isLoading → entire page (including focused search Input) is unmounted and replaced by skeletons; focus drops to <body>. The 300ms debounce only delays the swap — typing an email includes ≥300ms pauses, so it fires repeatedly mid-entry."
  artifacts:
    - path: "apps/web/src/features/contacts/ContactsListPage.tsx"
      issue: "lines 178-185: isLoading early-return unmounts toolbar+input; lines 94-98: query lacks placeholderData: keepPreviousData"
  missing:
    - "Add placeholderData: keepPreviousData to contacts list query so previous results stay rendered while new key fetches"
    - "Restrict skeleton early-return to genuine initial load (keep toolbar/search input mounted unconditionally); indicate refetch with lightweight cue (dim table on isPlaceholderData/isFetching)"
  debug_session: ".planning/debug/contact-search-focus-loss.md"
