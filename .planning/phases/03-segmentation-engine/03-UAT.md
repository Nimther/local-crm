---
status: testing
phase: 03-segmentation-engine
source: [03-VERIFICATION.md]
started: 2026-07-06T10:40:00Z
updated: 2026-07-06T10:40:00Z
---

## Current Test

number: 1
name: Segment edit refreshes members without reload (D-13)
expected: |
  Open a saved segment's detail page, change a condition (e.g. widen the country filter), save,
  and confirm the «Участники» member table and count refresh to reflect the new definition
  without a page reload.
awaiting: user response

## Tests

### 1. Segment edit refreshes members without reload (D-13)
expected: Member list and any displayed count update to match the edited definition (D-13's refreshToken mechanism is present in code but not exercised end-to-end by any test).
result: [pending]

### 2. Segments list enrichment renders count, freshness, author (D-11)
expected: With at least one segment that has a non-null memberCount/memberCountAt and one whose author differs from the viewer — member-count renders in Display weight with a correctly formatted «на {дата, время}» freshness line; the author name resolves correctly via GET /members (not a raw id or blank).
result: [pending]

## Summary

total: 2
passed: 0
issues: 0
pending: 2
skipped: 0
blocked: 0

## Gaps
