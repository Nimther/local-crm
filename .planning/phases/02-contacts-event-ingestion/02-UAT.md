---
status: diagnosed
phase: 02-contacts-event-ingestion
source: [02-VERIFICATION.md]
started: 2026-07-05T05:20:34Z
updated: 2026-07-05T07:10:00Z
---

## Current Test

[testing complete]

## Tests

### 1. Create contact with tag and custom property
expected: Create a contact with an email, a tag, and one custom property — toast «Контакт создан» and the contact appears in the list with tag and property visible.
result: pass

### 2. List search, filters, sort, pagination
expected: Search by email and by name; apply the status filter and a tag filter; sort a column; page forward/back. Each interaction filters/sorts/paginates correctly; filtered-empty copy shows when nothing matches.
result: issue
reported: "Всё работает, но при вводе имени или имейла в поиске страница начинает обновляться сразу и фокус слетает во время ввода в инпуте. Либо нужно вставлять уже готовый имейл в поиск, либо найти другой способ для обновления страницы во время ввода"
severity: major

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
result: follow-up-requested
note: "Source-assertion-only proof not accepted as final sign-off. Requesting a follow-up plan to add fault-injection coverage (simulate mid-transaction connection death, e.g. via pg_terminate_backend or a fault-injection harness) for withTenantTransaction's release-with-error path, before Phase 4 (send pipeline) drives much higher concurrency through the same shared connection-pool code (withTenantTransaction, upsertContactByIdentity, BullMQ workers)."

## Summary

total: 11
passed: 9
issues: 1
pending: 0
follow_up_requested: 1
skipped: 0
blocked: 0

## Gaps

- truth: "WR-09 dead-pooled-connection-destroy path is proven only by source assertion, no fault-injection test"
  status: follow-up-requested
  reason: "Sign-off declined as-is. Need a fault-injection test (simulate mid-transaction connection death, e.g. pg_terminate_backend) exercising withTenantTransaction's release-with-error branch, before Phase 4 (send pipeline) increases write concurrency on this same code path."
  severity: major
  test: 11
  root_cause: "Coverage gap, not a code defect: no fault-injection test exists that kills a pooled connection mid-transaction, so WR-09's destroy-on-error behavior rests on source assertion only. No debug investigation needed — the missing artifact is the test itself."
  artifacts: []
  missing: ["fault-injection test for withTenantTransaction release-with-error path (e.g. pg_terminate_backend mid-transaction; assert connection is destroyed, not returned to pool, and pool recovers)"]
  debug_session: ""

- truth: "Search input keeps focus while typing; list refreshes without disrupting input (debounced)"
  status: failed
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
