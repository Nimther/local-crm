---
phase: 07-analytics-dashboard-send-log
plan: 01
subsystem: database
tags: [drizzle, postgres, rls, webhook, contacts-core, subscription-status]

requires:
  - phase: 06-flows-triggered-chains
    provides: flow_run_steps append-only audit-log shape (mirrored by subscription_status_history)
  - phase: 05-webhook-processing-delivery-tracking
    provides: webhook-events.worker.ts's applySuppression/applyUnsubscribe + setFactColumnOnce/justSet gating pattern
provides:
  - subscription_status_history table (D-09) written from all four status-mutation call sites
  - sends.open_count/click_count repeat-engagement counters (A4/D-11)
  - recordSubscriptionStatusChange(client, params) exported from @mega-crm/contacts-core
affects: [07-02-contact-timeline, 07-05-send-log]

tech-stack:
  added: []
  patterns:
    - "Append-only audit-log table (subscription_status_history) mirroring flow_run_steps' shape, written inside the caller's existing tenant transaction"
    - "Capture-prior-status-before-UPDATE pattern (SELECT before UPDATE) since RETURNING only exposes the new row"
    - "Caller-gated history write: recordSubscriptionStatusChange never compares old/new itself -- every call site gates on nextStatus !== existing.subscriptionStatus"

key-files:
  created:
    - packages/db/src/schema/subscription-status-history.ts
    - packages/db/migrations/0036_analytics_status_history_counts.sql
    - packages/contacts-core/src/subscription-status-history.ts
    - apps/api/src/modules/contacts/__tests__/subscription-status-history.test.ts
    - apps/worker/src/queues/__tests__/webhook-open-click-counts.test.ts
  modified:
    - packages/db/src/schema/sends.ts
    - packages/db/src/index.ts
    - packages/contacts-core/src/contact-repository.ts
    - packages/contacts-core/src/index.ts
    - apps/api/src/modules/contacts/contact.repository.ts
    - apps/api/src/modules/delivery/unsubscribe.routes.ts
    - apps/worker/src/queues/webhook-events.worker.ts
    - apps/worker/src/queues/__tests__/webhook-events-suppression.test.ts

key-decisions:
  - "Test C (webhook_suppression history write) tested at the repository/helper level in apps/api's test file, since apps/api has no dependency path to apps/worker's process; the real webhook-worker call site is additionally covered end-to-end by extending webhook-events-suppression.test.ts"
  - "applySuppression/applyUnsubscribe now do a SELECT-before-UPDATE to capture the prior subscription_status, since UPDATE...RETURNING only exposes the post-update row"
  - "unsubscribe.routes.ts reads the contact's current status before the UPDATE and skips the history write when already unsubscribed (no-op, no value change)"

patterns-established:
  - "Shared subscription-status-history helper called from 4 independent mutation sites (contacts-core upsert, api updateContact, unsubscribe route, webhook worker) -- no per-site hand-written INSERT"

requirements-completed: [ANLT-03, ANLT-05]

coverage:
  - id: D1
    description: "subscription_status_history table + sends.open_count/click_count columns created via migration 0036 with RLS ENABLE+FORCE+NULLIF-guard"
    requirement: "ANLT-03"
    verification:
      - kind: unit
        ref: "npm run build -w packages/db (schema compiles, migration applied to dev DB)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Every subscription_status change writes exactly one history row (source + old->new status); a no-op status write (same value) writes zero rows"
    requirement: "ANLT-03"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/contacts/__tests__/subscription-status-history.test.ts#Test A: flipping subscribed->unsubscribed via updateContact (manual_ui) writes exactly one history row"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/contacts/__tests__/subscription-status-history.test.ts#Test B: updating a contact to the SAME status it already has writes zero new history rows"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/webhook-events-suppression.test.ts#D-13: a hard bounce suppresses the contact + writes exactly one workspace_suppressions row (reason hard_bounce)"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/webhook-events-suppression.test.ts#D-11/D-13: unsubscribe flips status to unsubscribed and writes ZERO workspace_suppressions rows"
        status: pass
    human_judgment: false
  - id: D3
    description: "sends.open_count/click_count climb once per genuinely-new open/click event; a replayed webhook batch (same sg_event_id) does not double-increment"
    requirement: "ANLT-05"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/webhook-open-click-counts.test.ts#Test D: opens -- a new open sets 0->1, a second distinct open sets 1->2, a replayed batch (same sg_event_id) leaves it unchanged"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/webhook-open-click-counts.test.ts#Test D: clicks -- a new click sets 0->1, a second distinct click sets 1->2, a replayed batch leaves it unchanged"
        status: pass
    human_judgment: false

duration: 30min
completed: 2026-07-14
status: complete
---

# Phase 7 Plan 1: Subscription-Status History + Repeat Open/Click Counters Summary

**New append-only `subscription_status_history` audit table wired into all 4 status-mutation call sites, plus `sends.open_count`/`click_count` repeat-engagement counters incremented on every genuinely-new webhook open/click**

## Performance

- **Duration:** ~30 min
- **Completed:** 2026-07-14
- **Tasks:** 3 (all completed)
- **Files modified:** 13 (5 created, 8 modified)

## Accomplishments

- `subscription_status_history` table (D-09) created via migration 0036, applied to the dev DB, with RLS ENABLE+FORCE+NULLIF-guarded `workspace_isolation` policy and a `(workspace_id, contact_id, changed_at)` index for the timeline read path
- `sends.open_count`/`click_count` integer counters added (A4/D-11)
- `recordSubscriptionStatusChange(client, params)` exported from `@mega-crm/contacts-core`, called from all four mutation call sites -- each caller gates the call on the status value actually changing, so a no-op status write records zero history rows
- Webhook worker's open/click handling now increments `open_count`/`click_count` on every genuinely-new event (independent of the `justSet` first-occurrence gate used for the campaign unique-recipient counters), while a replayed batch (dedup'd by `sg_event_id`) produces zero additional increments

## Task Commits

Each task was committed atomically:

1. **Task 1: Add subscription_status_history table + sends open/click counters + migration 0036** - `ee8a9bc` (feat)
2. **Task 2: [BLOCKING] Apply migration 0036 to the dev database** - no code commit (ran `npm run db:migrate`; verified table + columns exist live)
3. **Task 3: recordSubscriptionStatusChange helper + wire 4 call sites + webhook open/click counts** - `925a0fd` (test, RED) then `ed62305` (feat, GREEN)

**Plan metadata:** (this commit)

## Files Created/Modified

- `packages/db/src/schema/subscription-status-history.ts` - Drizzle table definition mirroring `flow-run-steps.ts`'s append-only shape
- `packages/db/src/schema/sends.ts` - added `openCount`/`clickCount` integer columns
- `packages/db/src/index.ts` - registered the new schema module in the barrel
- `packages/db/migrations/0036_analytics_status_history_counts.sql` - CREATE TABLE + RLS block + `sends` ALTER + index
- `packages/db/migrations/meta/_journal.json` - idx 36 entry
- `packages/contacts-core/src/subscription-status-history.ts` - `recordSubscriptionStatusChange` helper (INSERT-only, no own transaction)
- `packages/contacts-core/src/index.ts` - export the new helper + types
- `packages/contacts-core/src/contact-repository.ts` - `upsertContactByIdentity` wired (source `csv_or_api_upsert`)
- `apps/api/src/modules/contacts/contact.repository.ts` - `updateContact` wired (source `manual_ui`)
- `apps/api/src/modules/delivery/unsubscribe.routes.ts` - POST handler wired (source `unsubscribe_route`), reads prior status before the UPDATE
- `apps/worker/src/queues/webhook-events.worker.ts` - `applySuppression`/`applyUnsubscribe` wired (source `webhook_suppression`/`webhook_unsubscribe`), plus `open_count`/`click_count` increments in `applyEventSideEffects`
- `apps/api/src/modules/contacts/__tests__/subscription-status-history.test.ts` - Tests A/B/C
- `apps/worker/src/queues/__tests__/webhook-open-click-counts.test.ts` - Test D
- `apps/worker/src/queues/__tests__/webhook-events-suppression.test.ts` - extended with history-row assertions for the real `webhook_suppression`/`webhook_unsubscribe` call sites

## Decisions Made

- Test C (the `webhook_suppression` history-write behavior) is tested at the repository/helper level directly in `apps/api`'s new test file, since `apps/api` has no dependency path to `apps/worker`'s process to invoke `processWebhookEventBatch` directly. The actual webhook-worker call site is additionally verified end-to-end by extending the existing `webhook-events-suppression.test.ts` (both the hard-bounce and unsubscribe tests now assert the correct history row), so the real production code path has genuine integration coverage in addition to the apps/api-level unit-style test.
- `applySuppression`/`applyUnsubscribe` in the webhook worker now perform a `SELECT` immediately before their `UPDATE` to capture the prior `subscription_status` -- `UPDATE ... RETURNING` only ever exposes the post-update row, so this was necessary to record an accurate old→new pair.
- `unsubscribe.routes.ts` reads the contact's current status before the UPDATE and skips the history write when the contact is already unsubscribed (a no-op update with no value change), matching the plan's "no history row when unchanged" rule.

## Deviations from Plan

None - plan executed as written, with one interpretive clarification (Test C's test location, see Decisions above) needed to reconcile the plan's literal `apps/api -- subscription-status-history` acceptance command with `apps/api` having no way to invoke `apps/worker`'s webhook-processing function directly. Functional coverage of the real webhook_suppression/webhook_unsubscribe call sites was added to `apps/worker`'s existing suppression test file to close that gap.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required. Migration 0036 was applied to the local dev database as part of Task 2.

## Next Phase Readiness

- `subscription_status_history` and `sends.open_count`/`click_count` are live in the dev DB and ready for 07-02 (contact timeline) and 07-05 (send log) to read from.
- No blockers identified for downstream plans in this phase.

---
*Phase: 07-analytics-dashboard-send-log*
*Completed: 2026-07-14*

## Self-Check: PASSED

All created files verified present on disk; all three task commit hashes (`ee8a9bc`, `925a0fd`, `ed62305`) verified present in git history.
