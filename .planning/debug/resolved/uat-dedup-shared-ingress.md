---
status: resolved
trigger: "uat-verify dedup compare counts every ingress_journal row in a shared SendGrid workspace, so unrelated live traffic makes the exact-replay assertion fail"
created: 2026-08-18T00:00:00Z
updated: 2026-08-18T00:00:00Z
---

# Debug: UAT dedup shared-ingress interference

## Symptoms

- **Expected behavior:** `uat-verify dedup --mode compare` passes after one byte-exact replay when the matching `send_events` row remains unique, exactly one matching ingress-journal entry is added, and counters do not change.
- **Actual behavior:** the command reports a journal delta of hundreds while the shared SendGrid account is receiving unrelated live events; manual payload-scoped checks prove the tested payload increased by exactly one and the mutated payload was rejected.
- **Error messages:** `ingress_journal row count ... changed by 376 ... not the expected increase of exactly 1` (later 943 after additional account traffic).
- **Timeline:** surfaced during Phase 16 production UAT; the command had not previously been exercised under a shared, active SendGrid account.
- **Reproduction:** take a dedup snapshot, allow unrelated events for the same workspace to arrive, replay the captured signed payload once, then compare.

## Current Focus

- hypothesis: `collectDedupSnapshot` counts all workspace journal rows instead of only rows whose `raw_batch` equals the replay capture.
- test: add a capture-scoped regression test showing unrelated journal rows do not affect the comparison, then make the CLI require and parse `--capture` for both snapshot and compare.
- expecting: one exact replay changes the matching-payload journal count by exactly one while unrelated workspace traffic is ignored.
- next_action: complete
- reasoning_checkpoint: production evidence already isolates the failure to the unscoped journal-count query; send-event and counter assertions passed.
- tdd_checkpoint: regression test failed against the unscoped query, then passed after capture-scoped implementation

## Evidence

- timestamp: 2026-08-18T00:00:00Z
  observation: production compare observed total workspace journal deltas of 376 and 943 while `send_events` remained 1 and counters stayed unchanged.
- timestamp: 2026-08-18T00:00:00Z
  observation: manual query scoped to the captured raw batch observed exactly two matching rows after original ingestion plus one exact replay, and no additional row after byte-flip rejection.
- timestamp: 2026-08-18T00:00:00Z
  observation: shared-account ingress advanced by about three rows per second without actions from the UAT session.

## Eliminated

- hypothesis: send-event deduplication is broken
  reason: the exact four-column dedup key remained at one row through exact and mutated replays.
- hypothesis: replay changed analytics or campaign counters
  reason: the official comparison reported no counter mismatch.

## Resolution

- root_cause: `uat-verify` counted every `ingress_journal` row for the workspace, so unrelated events on the shared SendGrid account contaminated the expected replay delta.
- fix: require the replay capture, scope journal counting to `raw_batch = $2::jsonb`, pin capture and dedup identities across snapshots, validate the selected event exists in the capture, and mount a protected persistent scratch directory in both runbook commands.
- verification: 50 targeted tests, ESLint, full scripts test lane, all GitHub CI checks, production exact replay HTTP 200 with compare PASS, byte-flip HTTP 400 with compare PASS, and restored tolerance/readiness confirmed.
- files_changed: scripts/uat-verify.mjs; scripts/__tests__/uat-verify.test.mjs; docs/runbooks/uat-live-sendgrid.md
