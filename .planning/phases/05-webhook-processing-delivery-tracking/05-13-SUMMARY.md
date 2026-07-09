---
phase: 05-webhook-processing-delivery-tracking
plan: 13
subsystem: api
tags: [sendgrid, webhook, bullmq, postgres, vitest]

# Dependency graph
requires:
  - phase: 05-webhook-processing-delivery-tracking
    provides: webhook ingestion pipeline (extractEventRow, processWebhookEventBatch, fact-column + counter + suppression side effects) built across 05-01..05-12
provides:
  - Corrected extractEventRow reading send_id/test markers from the event's top level (the shape SendGrid's Event Webhook actually posts)
  - New webhook-events-attribution.test.ts integration suite proving end-to-end delivery attribution against a real flattened payload
  - All existing webhook test fixtures migrated off the fictional nested custom_args shape
affects: [06-flows-triggered-sends]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Webhook marker extraction reads top-level event fields first, with a nested fallback retained for backward compatibility -- never a hard cutover that could silently break an alternate caller shape"

key-files:
  created:
    - apps/worker/src/queues/__tests__/webhook-events-attribution.test.ts
  modified:
    - apps/worker/src/queues/webhook-events.worker.ts
    - apps/worker/src/queues/__tests__/webhook-events-status.test.ts
    - apps/worker/src/queues/__tests__/webhook-events-idempotency.test.ts
    - apps/worker/src/queues/__tests__/webhook-events-suppression.test.ts

key-decisions:
  - "extractEventRow reads event.send_id / event.test at the top level first, falling back to the nested custom_args read only defensively -- never removes the fallback outright, since a caller could theoretically still send the nested shape"
  - "UUID_RE validation and D-15 orphan-nulling behavior preserved unchanged -- only the field-read location changed, not the validation/resolution logic"
  - "One-time backfill of pre-fix send_events rows explicitly deferred (documented in the plan) -- affects only historical dev-DB rows, not durable behavior; a fresh live send is the honest re-verification"

patterns-established:
  - "Top-level-first, nested-fallback field extraction for any future SendGrid Event Webhook field additions"

requirements-completed: [WBHK-04, SUBS-02, WBHK-02]

coverage:
  - id: D1
    description: "extractEventRow reads send_id and the test marker from the event's top level (the real SendGrid Event Webhook shape), with the nested custom_args read kept only as a defensive fallback"
    requirement: "WBHK-02"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/webhook-events-attribution.test.ts#the stored send_events row records the resolved send_id (not null) for a flattened payload"
        status: pass
    human_judgment: false
  - id: D2
    description: "A real flattened delivered/open/click event resolves its send_id, sets the sends fact column, and increments the matching campaign counter"
    requirement: "WBHK-04"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/webhook-events-attribution.test.ts#a flattened delivered payload attributes send_id and increments the campaign delivered counter"
        status: pass
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/webhook-events-attribution.test.ts#a flattened open payload increments the opened counter"
        status: pass
    human_judgment: false
  - id: D3
    description: "Suppression/bounce/unsubscribe attribution (SUBS-02) shares the same corrected send_id-resolution path -- pre-existing suppression suite migrated to the real payload shape and still green"
    requirement: "SUBS-02"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/webhook-events-suppression.test.ts (all 9 tests)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Live re-verification: a fresh test-campaign send, delivered + opened over the https tunnel, shows non-zero campaign delivered/opened counters (the original UAT Test 4 failure)"
    verification: []
    human_judgment: true
    rationale: "Requires a live SendGrid send + real inbox interaction (delivery + open) over the https tunnel per docs/webhook-live-uat.md -- cannot be proven by an automated unit/integration test alone; the code fix + integration test above guarantee the attribution path this live send exercises."

duration: 12min
completed: 2026-07-09
status: complete
---

# Phase 05 Plan 13: Webhook flattened-payload attribution fix Summary

**Fixed `extractEventRow` to read `send_id`/`test` from the event's top level (the real shape SendGrid's Event Webhook posts) instead of a fictional nested `custom_args` wrapper, restoring end-to-end delivery attribution and campaign metric counters; migrated all webhook test fixtures to the real payload shape.**

## Performance

- **Duration:** 12 min
- **Started:** 2026-07-09T22:16:00Z
- **Completed:** 2026-07-09T22:28:14Z
- **Tasks:** 3
- **Files modified:** 4 (1 created, 3 modified)

## Accomplishments

- Root-caused-and-closed gap from 05-UAT.md round 5 Test 4: SendGrid flattens `mail/send` custom args (`send_id`, `workspace_id`, `campaign_id`, `test`) onto the event JSON's TOP LEVEL — there is no nested `custom_args` object in real webhook payloads. `extractEventRow` previously only read the nested shape, so `send_id` was always `null` and the entire fact-column/counter/suppression side-effect chain was silently skipped.
- Added `webhook-events-attribution.test.ts`, a new integration suite replaying the VERBATIM flattened shape through the real `processWebhookEventBatch` worker entrypoint, proving: (a) a delivered event sets `sends.delivered_at` and increments `campaigns.delivered_count`; (b) an open event sets `first_opened_at` and increments `opened_count`; (c) the stored `send_events` row's `send_id` column is non-null and matches the fixture send.
- Migrated every fixture in `webhook-events-status.test.ts`, `webhook-events-idempotency.test.ts`, and `webhook-events-suppression.test.ts` off the fictional nested shape onto the real flattened shape, with outcomes unchanged — the suite now exercises the exact payload contract SendGrid delivers, closing the coverage gap that let this bug ship to production undetected by 100% of automated tests.

## Task Commits

Each task was committed atomically:

1. **Task 1: RED — integration test replaying a verbatim flattened SendGrid payload** - `d5f47b2` (test)
2. **Task 2: GREEN — read send_id and test marker from the event top level** - `3570314` (fix)
3. **Task 3: Migrate every existing webhook fixture to the real flattened payload shape** - `e4a74fd` (test)

**Plan metadata:** (this commit, made after SUMMARY.md is written)

## Files Created/Modified

- `apps/worker/src/queues/__tests__/webhook-events-attribution.test.ts` - New integration suite proving flattened-payload attribution end-to-end (delivered fact + counter, open fact + counter, send_events.send_id resolution)
- `apps/worker/src/queues/webhook-events.worker.ts` - `extractEventRow` now reads `event.send_id`/`event.test` at the top level first, nested `custom_args` read kept as a defensive fallback; UUID validation and D-15 orphan-nulling unchanged
- `apps/worker/src/queues/__tests__/webhook-events-status.test.ts` - `sendgridEvent` helper and the no-campaign inline event migrated to top-level markers
- `apps/worker/src/queues/__tests__/webhook-events-idempotency.test.ts` - Two inline events (replay-side-effects test, bad-timestamp-replay test) migrated to top-level markers
- `apps/worker/src/queues/__tests__/webhook-events-suppression.test.ts` - `sendgridEvent` helper, test-marker event, and orphan-send event migrated to top-level markers

## Decisions Made

- Kept the nested `custom_args` read as a defensive fallback rather than deleting it outright — costs nothing and guards against any caller that might still construct the older shape.
- Preserved `UUID_RE` validation and D-15's orphan-nulling behavior exactly as-is — only the field-read *location* changed, not the validation or cross-tenant resolution logic that follows.
- Deferred the optional one-time backfill of pre-fix `send_events` rows (explicitly scoped out in the plan) — affects only historical dev-DB rows; the honest re-verification is a fresh live send exercising the now-corrected path.

## Deviations from Plan

None - plan executed exactly as written. All three tasks completed per their `<action>`/`<verify>`/`<done>` specs with no auto-fixes required.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 05 (webhook-processing-delivery-tracking) is now functionally complete: all 13 plans executed, and the one live-UAT-discovered gap (campaign metrics stuck at zero despite real delivery/open events) is closed with regression coverage.
- Remaining carried-forward item (unchanged, tracked in STATE.md): an integration test replaying a REAL SIGNED SendGrid payload through the FULL HTTP stack (raw-body ECDSA verification layer) — this plan's attribution test exercises the worker/`processWebhookEventBatch` layer where the defect lived, not the HTTP-signature layer.
- Recommended before closing Phase 05: re-run `docs/webhook-live-uat.md` Test 4 (send a fresh test campaign over the https tunnel, deliver + open the email) to confirm the campaign's delivered/opened counters now increment in the live environment — this is coverage item D4 above, requiring human/live-environment judgment.
- Ready for Phase 06 (flows-triggered-sends) to build on a verified-correct delivery-tracking foundation.

---
*Phase: 05-webhook-processing-delivery-tracking*
*Completed: 2026-07-09*

## Self-Check: PASSED

All 6 created/modified files found on disk; all 3 task commits (`d5f47b2`, `3570314`, `e4a74fd`) verified present in git history.
