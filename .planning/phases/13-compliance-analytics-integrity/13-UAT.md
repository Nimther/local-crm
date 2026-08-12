---
status: testing
phase: 13-compliance-analytics-integrity
source: [13-VERIFICATION.md]
started: 2026-08-12T04:51:29Z
updated: 2026-08-12T04:51:29Z
---

## Current Test

number: 1
name: Unsubscribe atomicity and convergence (ROADMAP SC1 / CMP-01)
expected: |
  Exactly one status change, one consent-history row, one unsubscribed_at fact, one counter increment, regardless of order or replay.
awaiting: user response

## Tests

### 1. Unsubscribe atomicity and convergence (ROADMAP SC1 / CMP-01)
expected: Send a real campaign email, click unsubscribe, confirm send/consent-history/campaign-counter all update exactly once, then replay the SendGrid unsubscribe webhook for the same send and confirm nothing changes a second time. Exactly one status change, one consent-history row, one unsubscribed_at fact, one counter increment, regardless of order or replay.
result: [pending]

### 2. Daily numbers under multiple session timezones (ROADMAP SC2 / CMP-02, CMP-03, CMP-06)
expected: Note a day's sent/delivered counts, trigger reconciliation, repeat under SET TIME ZONE 'Asia/Tokyo', confirm unchanged; inject a 4-day-late webhook event and confirm the day is marked dirty, cleared by the next tick, and the count reflects the late event. Counts are session-timezone-independent and late events land on the day they occurred, not the day they arrived.
result: [pending]

### 3. Erasure end-to-end, extended by gap-closure plan 13-16 (ROADMAP SC3 / CMP-04)
expected: Delete a contact with sends/events/external_id, confirm disappearance from lists/segments, confirm PII columns null and anonymized_at set, wait for scrub completion, confirm send_events.payload no longer carries the email, re-import the former external_id/email and confirm a new contact is created and suppression still refuses it. THEN (13-16 extension) delete a contact that previously produced at least one webhook event with an out-of-bounds timestamp (so a send_event_quarantine row carrying that contact's address exists); confirm the erasure completes as above; confirm the quarantine row is STILL PRESENT immediately afterward (not scrubbed, by design); confirm it is gone after SEND_EVENT_QUARANTINE_RETENTION_DAYS (7 days) has elapsed for that row — or a controlled received_at backdate plus a live webhook-replay-sweep tick — with no manual SQL.
result: [pending]

### 4. Event integrity (ROADMAP SC4 / CMP-05, CMP-07)
expected: Send a webhook event timestamped 30 days in the past, confirm quarantine + no send_events row + no metric movement; send the same event twice under two different sg_event_id values and confirm exactly one send_events row and one counter increment. Out-of-range timestamps are quarantined per-event without failing the batch; redelivery with an unstable sg_event_id still dedupes to one row.
result: [pending]

### 5. Backfill and alerts (ROADMAP SC5 / CMP-08, CMP-09)
expected: Stop the worker, deliver a signed webhook batch, confirm an un-ingested journal row, restart, confirm the replay sweep marks it ingested and processes events exactly once; seed a workspace above the complaint warn threshold with OPERATOR_ALERT_EMAIL pointed at a real inbox and confirm operator + tenant-member emails arrive, cooldown suppresses a repeat, and escalation to critical sends immediately.
result: [pending]

## Summary

total: 5
passed: 0
issues: 0
pending: 5
skipped: 0
blocked: 0

## Gaps
