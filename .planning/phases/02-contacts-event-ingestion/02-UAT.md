---
status: testing
phase: 02-contacts-event-ingestion
source: [02-VERIFICATION.md]
started: 2026-07-05T05:20:34Z
updated: 2026-07-05T05:20:34Z
---

## Current Test

number: 1
name: Create contact with tag and custom property
expected: |
  Contact appears in list with tag and property visible; toast «Контакт создан» shows.
awaiting: user response

## Tests

### 1. Create contact with tag and custom property
expected: Create a contact with an email, a tag, and one custom property — toast «Контакт создан» and the contact appears in the list with tag and property visible.
result: [pending]

### 2. List search, filters, sort, pagination
expected: Search by email and by name; apply the status filter and a tag filter; sort a column; page forward/back. Each interaction filters/sorts/paginates correctly; filtered-empty copy shows when nothing matches.
result: [pending]

### 3. Edit contact — remove property, clear field, reload (CR-04 end-to-end)
expected: Open a contact; add a custom property, then remove one, then clear the phone field; save. Reload the page. Removed property stays removed, cleared field stays cleared, untouched fields (e.g. city) are unaffected.
result: [pending]

### 4. Duplicate email inline error (D-07)
expected: Attempting to create a second contact with the same email shows inline «Этот email уже используется другим контактом…» copy.
result: [pending]

### 5. external_id read-only display (D-06)
expected: A contact with a set external_id shows it read-only with the D-06 helper text.
result: [pending]

### 6. Full CSV import wizard flow (D-16)
expected: Upload a small CSV, map columns (including «Создать новое свойство…»), choose duplicate policy, run dry-run, confirm the three stat cards, apply, watch progress bar, navigate away and back into the import from history. Dry-run writes nothing; apply progresses and resumes correctly on re-entry; completion report shows correct counts.
result: [pending]

### 7. Error CSV download + import history (D-18/D-20)
expected: On a CSV import with errors, download the error CSV and confirm the reason column; import history lists the run with file, date, author, and summary.
result: [pending]

### 8. Oversized CSV upload rejected (WR-04, 02-12 D4)
expected: Uploading a CSV larger than the 50MB limit sets import status to 'failed' and the upload responds 413, instead of hanging or silently truncating.
result: [pending]

### 9. Live event feed on contact card (D-14)
expected: Send a test event for a contact via POST /v1/events (API key from 02-03) or seed one; the contact's События tab shows the event with name, relative time, and an expandable JSON payload.
result: [pending]

### 10. UI-SPEC visual fidelity
expected: Spacing/typography/color and Russian copy match the Phase 2 UI-SPEC across the contact list/form/detail and CSV wizard.
result: [pending]

### 11. WR-09 dead-connection-destroy sign-off (02-11 D4)
expected: Review the WR-09 dead-pooled-connection-destroy reasoning (source assertion only — no fault-injection test exists in this suite). Either accept the source-assertion-only proof, or request a follow-up plan to add fault-injection coverage before Phase 4 (send pipeline) depends on this same connection-pool path at much higher volume.
result: [pending]

## Summary

total: 11
passed: 0
issues: 0
pending: 11
skipped: 0
blocked: 0

## Gaps
