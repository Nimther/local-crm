---
phase: 07-analytics-dashboard-send-log
plan: 09
subsystem: analytics
tags: [postgres, bullmq, webhook, sendgrid, rollup, tdd]

# Dependency graph
requires:
  - phase: 07-analytics-dashboard-send-log
    provides: workspace_daily_rollup incremental increment (07-06) and the reconciliation backstop (07-06) this plan makes consistent
provides:
  - Unique-send semantics for workspace_daily_rollup.opened_count/clicked_count/bounced_count in the incremental webhook path, matching reconcileWorkspaceDay
  - isFirstNonDeliveryTerminal helper closing the bounce+spam double-count gap (CR-01)
  - A real-Postgres regression test pinning the dual-write invariant for future changes to either writer
affects: [analytics-dashboard, send-log, webhook-events]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Dual-writer invariant regression test: run the incremental path, capture counts, run the overwrite backstop, assert unchanged -- proves two independent writers agree without re-deriving expectations from the code under test"
    - "isFirstNonDeliveryTerminal: a single parameterized boolean-sum SELECT gates a shared counter across multiple mutually-exclusive terminal event types, mirroring reconciliation's OR-combined COUNT filter"

key-files:
  created:
    - apps/worker/src/queues/__tests__/analytics-rollup-reconciliation-invariant.test.ts
  modified:
    - apps/worker/src/queues/webhook-events.worker.ts
    - apps/worker/src/queues/analytics-rollup.ts
    - apps/worker/src/queues/__tests__/analytics-rollup-idempotency.test.ts

key-decisions:
  - "Adopted the unique-send semantic (not the repeat-event semantic) in the incremental path -- the cheaper, <=100%-rate option per CR-01, and the one already matching reconciliation and the campaign counters"
  - "sends.open_count/click_count deliberately left as the sole remaining per-event (non-unique-send) counters -- they answer a different question (engagement intensity) and webhook-open-click-counts.test.ts already pins their unconditional climb"
  - "isFirstNonDeliveryTerminal implemented as a single boolean-sum SELECT rather than three separate IS NULL checks -- keeps the gate atomic within the existing transaction and trivially extensible if a fourth terminal column is ever added"

patterns-established:
  - "First-write-gate (justSet) as the canonical shape for unique-send rollup counters: delivered, opened, clicked, unsubscribed all now share the identical `if (justSet) { ...; incrementWorkspaceDailyRollup(...) }` structure"

requirements-completed: [ANLT-04]

coverage:
  - id: D1
    description: "opened_count/clicked_count in workspace_daily_rollup are unique-send counts (gated on justSet), unchanged by a repeat open/click and by a subsequent reconciliation tick"
    requirement: "ANLT-04"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/analytics-rollup-reconciliation-invariant.test.ts#Scenario A: opened_count/clicked_count stay unique-send counts across a reconcile tick"
        status: pass
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/analytics-rollup-idempotency.test.ts#opened_count is a unique-send count"
        status: pass
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/analytics-rollup-idempotency.test.ts#clicked_count is a unique-send count"
        status: pass
    human_judgment: false
  - id: D2
    description: "A send that both hard-bounces and spam-reports contributes exactly 1 to bounced_count from the incremental path, matching reconciliation's OR-combined filter; suppression still fires on both terminals"
    requirement: "ANLT-04"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/analytics-rollup-reconciliation-invariant.test.ts#Scenario B: a hard bounce + a spam report on the same send contribute exactly 1 to bounced_count, unchanged after reconcile"
        status: pass
    human_judgment: false
  - id: D3
    description: "sends.open_count/click_count per-send repeat counters remain unconditional (unaffected by the justSet gating change)"
    requirement: "ANLT-04"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/webhook-open-click-counts.test.ts#Test D: opens/clicks -- unchanged, byte-identical file"
        status: pass
    human_judgment: false
  - id: D4
    description: "Dashboard's opened/clicked/bounce trend and KPI values stay stable across reconciliation ticks -- no oscillation between the two writers' definitions"
    verification: []
    human_judgment: true
    rationale: "Requires observing the live dashboard across two real ~3min reconciliation ticks while opening a send multiple times (carried from 07-VERIFICATION.md human_verification[1]); automated coverage proves the underlying invariant but not the rendered dashboard experience"

duration: 20min
completed: 2026-07-14
status: complete
---

# Phase 07 Plan 09: Rollup Dual-Writer Fix Summary

**Gated opened/clicked/bounced rollup increments on first-write semantics so the incremental webhook path and the reconciliation backstop compute identical unique-send counts, closing the dashboard's open/click/bounce oscillation (CR-01, ANLT-04 SC4).**

## Performance

- **Duration:** 20 min
- **Started:** 2026-07-14T06:38:00Z
- **Completed:** 2026-07-14T06:43:02Z
- **Tasks:** 3
- **Files modified:** 4 (1 created, 3 modified)

## Accomplishments
- Regression test (`analytics-rollup-reconciliation-invariant.test.ts`) proves, against real Postgres, that `processWebhookEventBatch` and `reconcileWorkspaceDay` now compute identical `opened_count`/`clicked_count`/`bounced_count` for the same (workspace, day)
- `opened`/`clicked` rollup increments moved inside the `justSet` first-write gate in `webhook-events.worker.ts` -- unique-send semantics, matching reconciliation and the campaign counters
- New `isFirstNonDeliveryTerminal` helper gates `bounced_count` (rollup + campaign) across all four non-delivery terminal cases (`bounce_hard`, `bounce_soft` streak, `dropped`, `spam_report`) so a send counts once no matter how many of the three terminal columns end up set
- `sends.open_count`/`click_count` per-event repeat counters left untouched and unconditional (proven by the pre-existing, byte-identical `webhook-open-click-counts.test.ts`)

## Task Commits

Each task was committed atomically:

1. **Task 1: Failing dual-write invariant regression test (RED)** - `7d384a5` (test)
2. **Task 2: Gate opened/clicked rollup increments on the justSet first-write gate (GREEN A)** - `629cf2e` (feat)
3. **Task 3: Gate bounced_count on the first non-delivery terminal per send (GREEN B)** - `a49ea53` (feat)

**Plan metadata:** (this commit)

_Note: TDD plan -- RED (test) -> GREEN A -> GREEN B, no separate REFACTOR commit needed._

## Files Created/Modified
- `apps/worker/src/queues/__tests__/analytics-rollup-reconciliation-invariant.test.ts` - New real-Postgres regression test: Scenario A (opened/clicked unique-send stability across a reconcile tick) and Scenario B (bounce+spam single-count)
- `apps/worker/src/queues/webhook-events.worker.ts` - `open`/`click` cases restructured to gate the rollup increment on `justSet`; new `isFirstNonDeliveryTerminal` helper; `bounce_hard`/`bounce_soft`/`dropped`/`spam_report` cases gate their `bounced_count` increments on it while keeping suppression unconditional
- `apps/worker/src/queues/analytics-rollup.ts` - Doc-comment updated to describe the new unique-send-vs-per-event gating split (no functional change)
- `apps/worker/src/queues/__tests__/analytics-rollup-idempotency.test.ts` - opened/clicked tests updated to assert unchanged-at-1 on a distinct repeat instead of climbing to 2 (renamed to reflect unique-send semantics)

## Decisions Made
- Adopted the unique-send semantic in the incremental path rather than switching reconciliation to a repeat-event semantic -- the cheaper option (no new column/query shape) and the one that keeps open rate <= 100% (per CR-01's own recommendation)
- Suppression calls (`applySuppression`/`applyUnsubscribe`) stay unconditional in all four bounce/spam cases -- only the counter increments are gated on `isFirstNonDeliveryTerminal`, so a second terminal on an already-bounced send still suppresses correctly without double-counting

## Deviations from Plan

None - plan executed exactly as written. All three tasks' acceptance criteria were met without needing any Rule 1-4 auto-fixes; `webhook-open-click-counts.test.ts` was left byte-for-byte unchanged as required.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- The dual-write invariant this plan closes was the last open item from 07-REVIEW's CR-01 / 07-VERIFICATION's gap 2 (ANLT-04 SC4)
- Remaining carried-forward item: the live dashboard human-verification pass (watch «Открыто» KPI/trend stay stable across two real reconciliation ticks while opening a send multiple times) -- tracked as D4 above, same as 07-VERIFICATION's human_verification[1]

## Self-Check: PASSED

- FOUND: apps/worker/src/queues/__tests__/analytics-rollup-reconciliation-invariant.test.ts
- FOUND: apps/worker/src/queues/webhook-events.worker.ts
- FOUND: apps/worker/src/queues/analytics-rollup.ts
- FOUND: apps/worker/src/queues/__tests__/analytics-rollup-idempotency.test.ts
- FOUND commit: 7d384a5 (test)
- FOUND commit: 629cf2e (feat)
- FOUND commit: a49ea53 (feat)

---
*Phase: 07-analytics-dashboard-send-log*
*Completed: 2026-07-14*
