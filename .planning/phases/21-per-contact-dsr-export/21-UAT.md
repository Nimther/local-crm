---
status: complete
phase: 21-per-contact-dsr-export
source: [21-VERIFICATION.md]
started: 2026-08-22T13:45:00Z
updated: 2026-08-23T00:00:00Z
---

## Current Test

[testing complete]

## Tests

### 1. Real blob download of the DSR export in a browser
expected: Click the Export button on a live contact card — a JSON file named dsr-export-{contactId}-{YYYY-MM-DD}.json downloads, opens as valid JSON, filename carries no PII.
result: pass

### 2. Two-tab erasure race (410 mid-session handling)
expected: Open a contact's card in tab A, anonymize/erase that same contact in tab B, then click Export in tab A. Tab A gets the typed 410, the on-screen message flips to the erased-contact copy, and the contact query invalidation drives the card into its not-found/disabled state rather than staying clickable.
result: issue
reported: "Tab B cannot erase the contact through the UI. Clicking 'Удалить контакт' sends DELETE with Content-Type: application/json but no body, so Fastify returns 400 FST_ERR_CTP_EMPTY_JSON_BODY and shows the generic error. After performing the same DELETE correctly through the API, the intended race handling passes: Export in stale tab A returns typed 410; 'Контакт обезличен — персональные данные удалены' appears; query invalidation triggers GET → 404; the export action disappears and the card switches to 'Не удалось загрузить контакт'. Root cause: apiFetch always sets Content-Type: application/json, including bodyless apiDelete calls."
severity: major

### 3. Narrow-viewport wrap check (UI-SPEC E1/E2 backstop)
expected: At a narrow viewport width, the contact-card header actions row (Export + Delete) wraps onto a new line rather than clipping/overflowing, and the inline reason/error paragraph beside the Export button wraps to multiple lines rather than being cut off.
result: issue
reported: "The narrow-viewport backstop fails. The Export + Delete action row does not wrap: both containers use flex-wrap: nowrap. The page develops horizontal overflow (body clientWidth 375px, scrollWidth 1029px), and the Delete button is rendered outside the visible viewport. The inline error text itself wraps into multiple lines (200px height at 20px line-height), but its block begins beyond the viewport, so the message is effectively off-screen rather than usable. Expected: header/action containers wrap without horizontal page overflow, and the inline message remains inside the visible content width."
severity: major

## Summary

total: 3
passed: 1
issues: 2
pending: 0
skipped: 0
blocked: 0

## Gaps

- gap_id: G-21-2
  truth: "Erasing/anonymizing a contact via the UI delete action ('Удалить контакт') succeeds, enabling the two-tab erasure race flow end-to-end"
  status: failed
  reason: "User reported: Clicking 'Удалить контакт' sends DELETE with Content-Type: application/json but no body, so Fastify returns 400 FST_ERR_CTP_EMPTY_JSON_BODY and shows the generic error. The 410 race handling itself passes when the DELETE is performed correctly via the API. Root cause: apiFetch always sets Content-Type: application/json, including bodyless apiDelete calls."
  severity: major
  test: 2
  artifacts: []  # Filled by diagnosis
  missing: []    # Filled by diagnosis

- gap_id: G-21-3
  truth: "At narrow viewport widths the contact-card header actions row (Export + Delete) wraps onto a new line without horizontal page overflow, and the inline reason/error paragraph stays within the visible content width"
  status: failed
  reason: "User reported: The Export + Delete action row does not wrap — both containers use flex-wrap: nowrap. Body clientWidth 375px vs scrollWidth 1029px (horizontal overflow); Delete button rendered outside the visible viewport. The inline error text wraps internally but its block begins beyond the viewport, so the message is effectively off-screen."
  severity: major
  test: 3
  artifacts: []  # Filled by diagnosis
  missing: []    # Filled by diagnosis
