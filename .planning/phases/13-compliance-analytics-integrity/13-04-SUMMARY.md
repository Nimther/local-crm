---
phase: 13-compliance-analytics-integrity
plan: 04
subsystem: database
tags: [postgres, rls, webhooks, occurred_at, quarantine, delivery-core]

requires:
  - phase: 13-compliance-analytics-integrity
    provides: "13-01: ingress_journal + send_event_quarantine tables (migration 0055), writeQuarantinedEvent (packages/db/src/webhooks/quarantine.ts), markIngestionComplete/markJournalCompleteIfPresent"
provides:
  - classifyOccurredAt / OCCURRED_AT_MAX_PAST_DAYS / OCCURRED_AT_MAX_FUTURE_SKEW_MINUTES / OccurredAtVerdict (packages/delivery-core/src/occurred-at-bounds.ts, exported from index.ts)
  - ExtractEventOutcome three-outcome union (extracted/quarantine/skip) replacing extractEventRow's old null-or-row return
  - per-event quarantine routing in processWebhookEventBatch, same tenant transaction as the send_events insert and the journal completion mark
affects: [13-06-replay-sweep-and-retention-tick, 13-11-ingestion-health-watchdog]

tech-stack:
  added: []
  patterns:
    - "Pure classifier taking (candidate: unknown, now: Date) and returning a discriminated verdict union -- no ambient clock, deterministic for a given pair, mirrors normalizeEventType's DB-free house style"
    - "Extraction-step three-outcome union (extracted/quarantine/skip) replacing a nullable single-row return, so a per-event routing decision survives past the extraction boundary instead of collapsing to a boolean"

key-files:
  created:
    - packages/delivery-core/src/occurred-at-bounds.ts
    - packages/delivery-core/src/__tests__/occurred-at-bounds.test.ts
    - apps/worker/src/queues/__tests__/webhook-events-occurred-at-bounds.test.ts
  modified:
    - packages/delivery-core/src/index.ts
    - apps/worker/src/queues/webhook-events.worker.ts
    - packages/db/src/schema/send-events.ts
    - apps/worker/src/queues/__tests__/webhook-events-idempotency.test.ts
    - apps/worker/src/queues/__tests__/webhook-events-status.test.ts
    - apps/worker/src/queues/__tests__/webhook-events-suppression.test.ts
    - apps/worker/src/queues/__tests__/webhook-events-attribution.test.ts
    - apps/worker/src/queues/__tests__/webhook-events-processed.test.ts
    - apps/worker/src/queues/__tests__/webhook-events-sibling-drop.test.ts
    - apps/worker/src/queues/__tests__/webhook-events-journal.test.ts
    - apps/worker/src/queues/__tests__/webhook-open-click-counts.test.ts
    - apps/worker/src/queues/__tests__/analytics-rollup-idempotency.test.ts
    - apps/worker/src/queues/__tests__/analytics-rollup-tenant-isolation.test.ts
    - apps/worker/src/queues/__tests__/analytics-rollup-reconciliation-invariant.test.ts

key-decisions:
  - "Both OccurredAtVerdict kinds (rejected AND unusable) are quarantined whenever the event carries a usable sg_event_id -- decided by 13-04-PLAN.md itself resolving a prior cross-AI-review contradiction. The verdict kind only selects the reason string (too_old/too_far_future vs missing/non_finite/out_of_date_range); an event with no usable sg_event_id remains a plain skip with no quarantine row."
  - "processWebhookEventBatch's zero-row early return now requires BOTH zero insertable survivors AND zero quarantine candidates before skipping the tenant transaction -- an all-quarantined batch still opens the transaction to write quarantine rows, run debounceWebhookHealth, and mark the journal row complete, all in one transaction, per REVIEWS.md HIGH finding 1's precedent this plan extends."
  - "occurred_at_candidate (a TEXT column) is populated via a dedicated stringifyOccurredAtCandidate helper rather than String(candidate) directly, to satisfy @typescript-eslint/no-base-to-string and to avoid ever storing the literal string \"[object Object]\" for a non-primitive candidate."
  - "Rule 1 auto-fix: every existing webhook-events-*/analytics-rollup-* test fixture's hardcoded 2023/2026-era timestamp (1_700_000_000 and a fixed 2026-01-15 noon-UTC constant) is now old enough to fall outside classifyOccurredAt's [now-7d, now+5min] window. Replaced with module-scoped Math.floor(Date.now()/1000)-3600 (or, for the noon-UTC reconciliation-invariant fixture, a runtime yesterday-noon-UTC computation preserving its day-bucket guarantee) across 9 test files, preserving relative offsets (status.test.ts's +100s out-of-order fixtures) and rollup DAY derivation (both analytics-rollup-* files derive DAY from the same runtime constant, never a separate wall-clock read)."

requirements-completed: [CMP-05]

coverage:
  - id: D1
    description: "classifyOccurredAt: pure, deterministic bounding classifier over [now-7d, now+5min] with distinct rejected/unusable verdict kinds, each carrying the un-coerced candidate verbatim"
    requirement: "CMP-05"
    verification:
      - kind: unit
        ref: "packages/delivery-core/src/__tests__/occurred-at-bounds.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Out-of-range/unusable webhook events are quarantined per event (no batch-level failure), producing zero send_events rows, zero fact-column writes, zero campaign-counter increments, and zero workspace_daily_rollup increments; batch-mates are unaffected"
    requirement: "CMP-05"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/webhook-events-occurred-at-bounds.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "A journaled batch whose every event is quarantined still marks ingress_journal.ingestion_completed_at non-null (never re-enqueued as stuck)"
    requirement: "CMP-05"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/webhook-events-occurred-at-bounds.test.ts#a journaled batch whose every event is quarantined leaves ingress_journal.ingestion_completed_at non-null"
        status: pass
    human_judgment: false
  - id: D4
    description: "No existing webhook/analytics-rollup behavior regressed by introducing the bounding window (fixture timestamps refreshed to stay in-window)"
    requirement: "CMP-05"
    verification:
      - kind: integration
        ref: "apps/worker full test suite (npx vitest run --root apps/worker): 65 files, 430 tests"
        status: pass
    human_judgment: false

duration: ~55min
completed: 2026-08-11
status: complete
---

# Phase 13 Plan 04: occurred_at Bounding + Quarantine Routing Summary

**Pure `classifyOccurredAt` classifier (`[now-7d, now+5min]`, versioned constants) plus per-event `send_event_quarantine` routing in the webhook worker, so a manipulated or clock-skewed provider timestamp can no longer choose a `send_events` partition or enter its dedup key.**

## Performance

- **Duration:** ~55 min
- **Tasks:** 2
- **Files created:** 3
- **Files modified:** 14

## Accomplishments

- `classifyOccurredAt(timestamp, now)` in `packages/delivery-core`: a pure, DB-free, fully deterministic classifier returning `{ kind: "accepted", occurredAt }`, `{ kind: "rejected", reason: "too_old" | "too_far_future", candidate }`, or `{ kind: "unusable", reason: "missing" | "non_finite" | "out_of_date_range", candidate }`. Preserves the pre-existing `MAX_DATE_TIME_VALUE_MS` guard and the WR-01 no-wall-clock-fallback rule.
- `OCCURRED_AT_MAX_PAST_DAYS = 7` and `OCCURRED_AT_MAX_FUTURE_SKEW_MINUTES = 5`, both versioned constants with rationale comments cross-referencing SendGrid's retry/deferral windows and the distinct Phase 10 header-timestamp tolerance.
- `webhook-events.worker.ts`'s `extractEventRow` now returns a three-outcome `ExtractEventOutcome` (`extracted` / `quarantine` / `skip`) instead of `ExtractedEventRow | null`, threading one `now` captured per batch into every event's classification.
- `processWebhookEventBatch` writes quarantine rows via `writeQuarantinedEvent` (13-01) inside the SAME tenant transaction as the `send_events` insert, guards the INSERT on a non-empty survivor list, and marks a journaled batch's `ingress_journal` row complete inside that same transaction even when every event was quarantined.
- A batch mixing good and bad events inserts exactly the good ones and quarantines exactly the bad ones; a fully-quarantined batch resolves cleanly with `{ inserted: 0 }` rather than throwing.

## Task Commits

Each task was committed atomically (TDD RED/GREEN):

1. **Task 1: Pure occurred_at bounding classifier with versioned constants**
   - `e496afc` (test) — RED: failing boundary tests for `classifyOccurredAt`
   - `4c9711b` (feat) — GREEN: classifier implementation + index.ts export
2. **Task 2: Route out-of-range events to quarantine, per event, without failing the batch**
   - `70354f1` (test) — RED: new worker occurred-at-bounds test suite + fixture-timestamp refresh across 9 existing test files (Rule 1 auto-fix, see Deviations)
   - `82e9690` (feat) — GREEN: worker restructure, `send-events.ts` doc-comment update, reconciliation-invariant fixture fix

## Files Created/Modified

- `packages/delivery-core/src/occurred-at-bounds.ts` — `classifyOccurredAt`, `OCCURRED_AT_MAX_PAST_DAYS`, `OCCURRED_AT_MAX_FUTURE_SKEW_MINUTES`, `OccurredAtVerdict`
- `packages/delivery-core/src/__tests__/occurred-at-bounds.test.ts` — 11 boundary-case unit tests, fixed injected `now`
- `packages/delivery-core/src/index.ts` — re-exports the new classifier
- `apps/worker/src/queues/webhook-events.worker.ts` — `ExtractEventOutcome`, `QuarantineCandidate`, `stringifyOccurredAtCandidate`, restructured `extractEventRow`/`processWebhookEventBatch`
- `apps/worker/src/queues/__tests__/webhook-events-occurred-at-bounds.test.ts` — 8 integration tests against an ephemeral database covering the full behavior list
- `packages/db/src/schema/send-events.ts` — doc-comment records `occurred_at` as now bounded, `received_at` as the separate un-bounded server authority
- 9 existing `apps/worker/src/queues/__tests__/*.ts` files — hardcoded 2023/2026-era fixture timestamps refreshed to a runtime-computed in-window value (see Deviations)

## Decisions Made

See frontmatter `key-decisions`. Summary: both `rejected` and `unusable` verdicts are quarantined per the plan's own resolved contradiction; the transaction-opening gate now checks quarantine candidates in addition to insertable survivors; candidate stringification uses a dedicated helper to satisfy lint and avoid `[object Object]`; and the widespread fixture-timestamp fallout is fixed as one Rule 1 deviation.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Stale fixture timestamps across 9 existing test files broke under the new bounding window**
- **Found during:** Task 2, before writing the new test file (confirmed via `advisor` before proceeding)
- **Issue:** Nearly every `webhook-events-*.test.ts` and `analytics-rollup-*.test.ts` fixture used a hardcoded `timestamp: 1_700_000_000` (2023-11-14) or, in `analytics-rollup-reconciliation-invariant.test.ts`, a hardcoded 2026-01-15 noon-UTC constant. Once `classifyOccurredAt`'s `[now-7d, now+5min]` window is enforced (current date 2026-08-11), every one of those fixtures is now `too_old` and would be silently routed to quarantine instead of inserted — breaking `inserted` counts, delivery-fact assertions, campaign-counter assertions, and `workspace_daily_rollup` assertions across the whole webhook test surface, with no change to this plan's own `files_modified` list.
- **Fix:** Replaced each hardcoded constant with a module-scoped `Math.floor(Date.now() / 1000) - 3600` (1 hour ago), or — for the noon-UTC reconciliation-invariant fixture, which depends on landing exactly on `T12:00:00.000Z` for UTC-day-bucket consistency — a runtime "yesterday at noon UTC" computation. Preserved relative offsets used to test event ordering (`webhook-events-status.test.ts`'s `FIXED_TIMESTAMP + 100` out-of-order fixtures) and preserved `DAY` derivation from the SAME runtime constant in both `analytics-rollup-*` files (never a separate wall-clock read, so `occurred_at` and the asserted rollup day can never disagree).
- **Files modified:** `apps/worker/src/queues/__tests__/webhook-events-idempotency.test.ts`, `webhook-events-status.test.ts`, `webhook-events-suppression.test.ts`, `webhook-events-attribution.test.ts`, `webhook-events-processed.test.ts`, `webhook-events-sibling-drop.test.ts`, `webhook-events-journal.test.ts`, `webhook-open-click-counts.test.ts`, `analytics-rollup-idempotency.test.ts`, `analytics-rollup-tenant-isolation.test.ts`, `analytics-rollup-reconciliation-invariant.test.ts`
- **Verification:** Full `apps/worker` suite (65 files, 430 tests) passes; the plan's own named 6-file verify command and the delivery-core suite both pass.
- **Committed in:** `70354f1` (test/RED commit, since the new occurred-at-bounds test's own fixtures needed the same fix to author correctly) and `82e9690` (the reconciliation-invariant fix, discovered only after the worker restructure landed and the full suite was run).

**2. [Rule 1 - Bug] `webhook-events-journal.test.ts`'s Test 2 (sibling-drop) previously used the same 2023 fixed timestamp, which would now mask its own intent**
- **Found during:** advisor review before implementation
- **Issue:** With the old stale timestamp, Test 2 ("a journaled batch whose every event belongs to a sibling workspace") would pass for the wrong reason post-restructure — the event would be quarantined for being too old before ever reaching the sibling-drop check, while the test's `inserted: 0` assertion would still go green, silently no longer proving what its name claims.
- **Fix:** Refreshed the same file's `flattenedSendgridEvent` default timestamp alongside the Test 1/Test 4 fix (both needed it for `inserted: 1` assertions), which incidentally restores Test 2's original intent as a side effect of the same edit.
- **Files modified:** `apps/worker/src/queues/__tests__/webhook-events-journal.test.ts`
- **Verification:** `webhook-events-journal.test.ts` passes (8 tests); Test 2 now genuinely exercises the sibling-drop path rather than the quarantine path.
- **Committed in:** `70354f1`

**3. [Rule 1 - Bug] `String(candidate)` on an `unknown` verdict candidate triggered `@typescript-eslint/no-base-to-string`**
- **Found during:** Task 2, `npm run lint`
- **Issue:** A bare `String(verdict.candidate)` would collapse a non-primitive candidate (were one ever to reach this branch) to the literal string `"[object Object]"`, which the lint rule flags and which would silently discard forensic value from the quarantine row.
- **Fix:** Added `stringifyOccurredAtCandidate`, a small helper distinguishing `null`/`undefined` (→ `null`), string (passthrough), number/boolean (`String(...)`), and everything else (`JSON.stringify`, falling back to `Object.prototype.toString.call` if that throws).
- **Files modified:** `apps/worker/src/queues/webhook-events.worker.ts`
- **Verification:** `npm run lint` exits 0; the `"nope"` and numeric-candidate quarantine tests in `webhook-events-occurred-at-bounds.test.ts` assert the exact stored string.
- **Committed in:** `82e9690`

---

**Total deviations:** 3 auto-fixed (all Rule 1 — bug fixes directly caused by this plan's own change, none architectural)
**Impact on plan:** All three were necessary to keep the plan's own "no existing webhook behavior regressed" acceptance criterion true and to pass `npm run lint`. No scope creep beyond fixture timestamps and one stringification helper — no new tables, packages, routes, or architectural changes.

## Issues Encountered

None beyond the fixture fallout documented above, which was anticipated and confirmed via `advisor` before implementation began.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- `classifyOccurredAt` and the quarantine-routing path are ready for plan 13-06 (replay sweep) and plan 13-11 (ingestion-health watchdog) to build on; neither is wired to consume `send_event_quarantine` rows yet (that remains out of scope for this plan, as it was for 13-01).
- The 7-day/5-minute window values are planner-tuned versioned constants (documented in `13-04-PLAN.md`'s `flagged_assumptions`), not yet validated against this platform's own observed event-lateness distribution — if real traffic shows legitimate events arriving older than 7 days, `send_event_quarantine`'s accumulated rows are the evidence base for retuning `OCCURRED_AT_MAX_PAST_DAYS`.
- No blockers for downstream phases.

---
*Phase: 13-compliance-analytics-integrity*
*Completed: 2026-08-11*

## Self-Check: PASSED

All created files verified present on disk; all 5 commits (`e496afc`, `4c9711b`, `70354f1`, `82e9690`, `a8e9da6`) verified in `git log`.
