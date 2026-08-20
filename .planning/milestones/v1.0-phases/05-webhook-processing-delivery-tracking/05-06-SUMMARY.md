---
phase: 05-webhook-processing-delivery-tracking
plan: 06
subsystem: worker
tags: [bullmq, webhooks, idempotency, sendgrid, postgres]

# Dependency graph
requires:
  - phase: 05-webhook-processing-delivery-tracking
    provides: send_events UNIQUE(workspace_id, sg_event_id, occurred_at) dedup key and processWebhookEventBatch handler (05-01/05-03)
provides:
  - extractEventRow skips (returns null) events with a missing, non-numeric, or out-of-range timestamp instead of substituting wall-clock time
  - Two regression tests proving redelivery of a missing/invalid-timestamp event does not double-count, and an out-of-range timestamp does not crash the batch
affects: [05-webhook-processing-delivery-tracking verification, future webhook worker changes]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "occurred_at is deterministic-per-event or the event is skipped entirely — never wall-clock time — so ON CONFLICT dedup fires reliably on every redelivery"

key-files:
  created: []
  modified:
    - apps/worker/src/queues/webhook-events.worker.ts
    - apps/worker/src/queues/__tests__/webhook-events-idempotency.test.ts

key-decisions:
  - "Bounds check is Math.abs(timestamp * 1000) <= 8.64e15 (ECMAScript max time value in ms), applied before constructing new Date(), guaranteeing the Date constructor can never throw RangeError for an in-range value"
  - "Unusable timestamp is treated identically to a missing sg_event_id: extractEventRow returns null and the row is silently dropped by the existing .filter(row !== null) — no caller-side change needed"

patterns-established: []

requirements-completed: [WBHK-03]

coverage:
  - id: D1
    description: "extractEventRow returns null (skip) for a missing/non-numeric timestamp instead of substituting wall-clock time, so a redelivered event with an invalid timestamp is deterministically skipped on every attempt and never double-counts"
    requirement: "WBHK-03"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/webhook-events-idempotency.test.ts#WBHK-03/D-09: a redelivered event with a missing/invalid timestamp does not double-insert or double-count"
        status: pass
    human_judgment: false
  - id: D2
    description: "extractEventRow bounds-checks the timestamp before constructing a Date, so an out-of-range numeric timestamp in one event is skipped without throwing RangeError or failing the rest of the batch"
    requirement: "WBHK-03"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/webhook-events-idempotency.test.ts#an out-of-range numeric timestamp in one event does not fail the rest of the batch"
        status: pass
    human_judgment: false

duration: 6min
completed: 2026-07-09
status: complete
---

# Phase 05 Plan 06: Deterministic occurred_at (missing/invalid/out-of-range timestamp handling) Summary

**Hardened `extractEventRow` to skip webhook events with a missing, non-numeric, or out-of-range `timestamp` instead of substituting `new Date().toISOString()`, closing the WR-01/WR-02 exactly-once dedup gaps found in 05-VERIFICATION.md.**

## Performance

- **Duration:** 6 min
- **Started:** 2026-07-09T06:17:00Z (approx.)
- **Completed:** 2026-07-09T06:23:15Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- Regression Test A (RED-first): proves a redelivered event with a missing/invalid `timestamp` is skipped identically on every attempt — no double-insert, no double-count of `sends.delivered_at` / `campaigns.delivered_count`.
- Regression Test B (RED-first): proves an out-of-range numeric `timestamp` (`1e20`) skips only that one event and the batch still resolves with `{ inserted: 2 }` for the two well-formed events, instead of throwing `RangeError` and crashing the whole job.
- `extractEventRow` now validates `event.timestamp` with `typeof === "number" && Number.isFinite(...) && Math.abs(timestamp * 1000) <= 8.64e15` before constructing a `Date`; on failure it returns `null` (same treatment as a missing `sg_event_id`) instead of falling back to wall-clock time.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add failing regression tests for the missing/invalid and out-of-range timestamp cases** - `608b78d` (test)
2. **Task 2: Skip events with a non-finite / out-of-range timestamp instead of substituting wall-clock time** - `1785d8c` (fix)

**Plan metadata:** (pending — final docs commit below)

## Files Created/Modified
- `apps/worker/src/queues/webhook-events.worker.ts` - `extractEventRow` timestamp validation hardened; `occurredAt` is deterministic-or-skip, never wall-clock
- `apps/worker/src/queues/__tests__/webhook-events-idempotency.test.ts` - two new regression tests (missing/invalid-timestamp redelivery; out-of-range timestamp batch survival)

## Decisions Made
- Bounds check (`Math.abs(timestamp * 1000) <= 8.64e15`) chosen over a try/catch around `new Date()` — it's a pure guard with no exception-handling control flow, and 8.64e15 ms is the documented ECMAScript maximum time value, so the bound is provably sufficient to prevent `RangeError`.
- No change to `processWebhookEventBatch`: the existing `.filter((row): row is ExtractedEventRow => row !== null)` already discards newly-skipped rows, and the empty-batch early return already handles an all-skipped batch.

## Deviations from Plan

None - plan executed exactly as written. Both tasks completed per their `<action>` and `<acceptance_criteria>` blocks with no scope changes.

## Issues Encountered

None. Task 1 tests failed for exactly the expected reasons against the unfixed worker (Test A: `first.inserted` was `1` not `0` due to the wall-clock fallback; Test B: the promise rejected with `RangeError: Invalid time value`). Task 2's fix turned both green with no further iteration needed, and the full `webhook-events-idempotency` + `webhook-events-status` + `webhook-events-suppression` suite (24 tests) passed alongside a clean `apps/worker` build.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- 05-VERIFICATION.md truth #3 ("Duplicate webhook deliveries (same sg_event_id) do not double-count or corrupt delivery statistics") can now flip from partial → passing for the missing/invalid-timestamp redelivery case, once re-verified.
- Gap closure plan 05-07 (remaining CR-01 item from 05-REVIEW.md) is unaffected by this change and can proceed independently.

---
*Phase: 05-webhook-processing-delivery-tracking*
*Completed: 2026-07-09*

## Self-Check: PASSED

- FOUND: apps/worker/src/queues/webhook-events.worker.ts
- FOUND: apps/worker/src/queues/__tests__/webhook-events-idempotency.test.ts
- FOUND: .planning/phases/05-webhook-processing-delivery-tracking/05-06-SUMMARY.md
- FOUND commit: 608b78d
- FOUND commit: 1785d8c
