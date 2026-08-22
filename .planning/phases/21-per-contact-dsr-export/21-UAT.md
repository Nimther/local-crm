---
status: testing
phase: 21-per-contact-dsr-export
source: [21-VERIFICATION.md]
started: 2026-08-22T13:45:00Z
updated: 2026-08-22T13:45:00Z
---

## Current Test

number: 1
name: Real blob download of the DSR export in a browser
expected: |
  A JSON file named dsr-export-{contactId}-{YYYY-MM-DD}.json downloads via the
  browser's normal download flow (Blob + synthetic anchor click), opens as valid
  JSON, and the filename carries no PII.
awaiting: user response

## Tests

### 1. Real blob download of the DSR export in a browser
expected: Click the Export button on a live contact card — a JSON file named dsr-export-{contactId}-{YYYY-MM-DD}.json downloads, opens as valid JSON, filename carries no PII.
result: [pending]

### 2. Two-tab erasure race (410 mid-session handling)
expected: Open a contact's card in tab A, anonymize/erase that same contact in tab B, then click Export in tab A. Tab A gets the typed 410, the on-screen message flips to the erased-contact copy, and the contact query invalidation drives the card into its not-found/disabled state rather than staying clickable.
result: [pending]

### 3. Narrow-viewport wrap check (UI-SPEC E1/E2 backstop)
expected: At a narrow viewport width, the contact-card header actions row (Export + Delete) wraps onto a new line rather than clipping/overflowing, and the inline reason/error paragraph beside the Export button wraps to multiple lines rather than being cut off.
result: [pending]

## Summary

total: 3
passed: 0
issues: 0
pending: 3
skipped: 0
blocked: 0

## Gaps
