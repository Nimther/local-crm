---
phase: 05-webhook-processing-delivery-tracking
plan: 03
subsystem: worker
tags: [postgres, rls, bullmq, sendgrid, webhooks, suppression, delivery-tracking]

# Dependency graph
requires:
  - phase: 05-webhook-processing-delivery-tracking
    plan: "05-01"
    provides: "send_events dedup-only worker skeleton (RETURNING gate), workspace_webhook_endpoints table"
  - phase: 05-webhook-processing-delivery-tracking
    plan: "05-02"
    provides: "normalizeEventType, resolveSuppression, SOFT_BOUNCE_SUPPRESS_THRESHOLD (pure, DB-free decision modules)"
provides:
  - "sends delivery fact columns (delivered_at/first_opened_at/first_clicked_at/bounced_at/dropped_at/unsubscribed_at/spam_reported_at + bounce_reason/drop_reason)"
  - "contacts.consecutive_soft_bounces streak counter"
  - "campaigns delivery counters (delivered_count/opened_count/clicked_count/bounced_count/unsubscribed_count)"
  - "processWebhookEventBatch full side-effect pipeline: facts, counters, suppression state machine, soft-bounce streak, test/orphan short-circuits, health debounce"
affects: [05-04, 05-05, delivery-tracking-ui, campaign-metrics]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "FK-safety pre-resolution: before inserting send_events (send_id carries a real FK to sends(id)), batch-resolve which candidate send_ids are actually live in this workspace and null out any that aren't, rather than letting the INSERT crash on referential integrity for a deleted/never-existed send"
    - "Idempotent fact write via WHERE <col> IS NULL first-write UPDATE, gating both D-06 (never overwrite) and D-09 (exactly-once counter increment) from the same RETURNING check"
    - "Suppression dual-write (contacts.subscription_status + workspace_suppressions) as a small shared helper invoked per-outcome, never a bulk mutation"

key-files:
  created:
    - packages/db/migrations/0022_sends_delivery_columns.sql
    - packages/db/migrations/0023_contacts_soft_bounce_streak.sql
    - packages/db/migrations/0024_campaigns_delivery_counters.sql
    - apps/worker/src/queues/__tests__/webhook-events-status.test.ts
    - apps/worker/src/queues/__tests__/webhook-events-suppression.test.ts
  modified:
    - packages/db/src/schema/sends.ts
    - packages/db/src/schema/contacts.ts
    - packages/db/src/schema/campaigns.ts
    - packages/db/migrations/meta/_journal.json
    - apps/worker/src/queues/webhook-events.worker.ts
    - apps/worker/src/queues/__tests__/webhook-events-idempotency.test.ts

key-decisions:
  - "spam_report and dropped events both increment campaigns.bounced_count (no dedicated spam/dropped counter exists) -- Task 1 only added 5 counter columns (delivered/opened/clicked/bounced/unsubscribed); every non-delivery terminal that isn't an unsubscribe folds into bounced_count, matching the D-08 'не доставлено' UI grouping. The specific reason stays queryable per-send via sends.bounce_reason/drop_reason."
  - "Orphan send_id resolution happens as a batch pre-check BEFORE the send_events INSERT, not after: send_events.send_id carries a real FK to sends(id), so passing through an unresolved custom_args.send_id would throw a foreign-key violation at insert time regardless of is_test/orphan intent -- a gap inherited unchanged from 05-01 that Task 1's new columns first made testable. Fixed by batch-SELECTing which candidate send_ids are live in this workspace and nulling any that aren't, before building the INSERT values."
  - "dropped's bounced_count increment happens for EVERY dropped event that sets dropped_at for the first time, independent of resolveSuppression's outcome (suppressed/unsubscribed/none) -- a drop is 'не доставлено' regardless of the specific reason, per Task 1's explicit recommendation."

patterns-established:
  - "Two-task TDD split across a worker-implementation task and an integration-test task (rather than one RED/GREEN task): implementation committed first (feat), integration coverage committed second (test) -- appropriate when the tests exercise a wide multi-branch state machine that is easier to author accurately once the implementation exists to validate fixture shapes against."

requirements-completed: [WBHK-02, WBHK-04, SUBS-02]

coverage:
  - id: D1
    description: "A newly-inserted delivered event sets sends.delivered_at exactly once and increments campaigns.delivered_count exactly once; a replay does neither"
    requirement: "WBHK-04"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/webhook-events-status.test.ts#delivered sets delivered_at + delivered_count=1; a replay leaves both unchanged"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/webhook-events-idempotency.test.ts#WBHK-04/D-09: a replayed batch leaves the delivery fact and campaign counter unchanged (exactly-once side effects)"
        status: pass
    human_judgment: false
  - id: D2
    description: "opened/clicked events set first_opened_at/first_clicked_at once and increment unique-recipient counters once"
    requirement: "WBHK-04"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/webhook-events-status.test.ts#open sets first_opened_at + opened_count once"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/webhook-events-status.test.ts#click sets first_clicked_at + clicked_count once"
        status: pass
    human_judgment: false
  - id: D3
    description: "A hard bounce sets sends.bounced_at + flips the contact to suppressed AND writes a workspace_suppressions row with reason hard_bounce, in the same transaction"
    requirement: "SUBS-02"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/webhook-events-suppression.test.ts#D-13: a hard bounce suppresses the contact + writes exactly one workspace_suppressions row (reason hard_bounce)"
        status: pass
    human_judgment: false
  - id: D4
    description: "3 consecutive soft bounces (blocked) suppress the contact with reason soft_bounce_streak; a delivered event resets the streak to 0"
    requirement: "SUBS-02"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/webhook-events-suppression.test.ts#D-10: the 3rd consecutive soft bounce suppresses (reason soft_bounce_streak); a delivered event resets the streak"
        status: pass
    human_judgment: false
  - id: D5
    description: "spam_report -> suppressed(spam_report); unsubscribe/group_unsubscribe -> unsubscribed (status only, no suppression row)"
    requirement: "SUBS-02"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/webhook-events-suppression.test.ts#D-11: a spam report suppresses the contact with reason spam_report"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/webhook-events-suppression.test.ts#D-11/D-13: unsubscribe flips status to unsubscribed and writes ZERO workspace_suppressions rows"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/webhook-events-suppression.test.ts#D-11: group_unsubscribe also flips status to unsubscribed with zero suppression rows"
        status: pass
    human_judgment: false
  - id: D6
    description: "dropped maps to suppressed/unsubscribed/no-change by reason, recording dropped_at + reason on the send"
    requirement: "SUBS-02"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/webhook-events-suppression.test.ts#D-12: dropped 'Bounced Address' suppresses the contact"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/webhook-events-suppression.test.ts#D-12: dropped 'Unsubscribed Address' unsubscribes the contact (no suppression row)"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/webhook-events-suppression.test.ts#D-12: dropped with a technical reason causes NO status change"
        status: pass
    human_judgment: false
  - id: D7
    description: "Out-of-order events never overwrite an already-set fact column"
    requirement: "WBHK-04"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/webhook-events-status.test.ts#D-06: two distinct delivered events for the same send never double-set the fact or double-count"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/webhook-events-status.test.ts#D-06: an out-of-order (earlier-timestamped) bounce arriving after delivered never touches delivered_at"
        status: pass
    human_judgment: false
  - id: D8
    description: "An event marked test='true' is stored with is_test=true and produces zero status/counter/suppression side effects"
    requirement: "SUBS-02"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/webhook-events-suppression.test.ts#D-15/Pitfall 2: an event marked custom_args.test='true' is stored is_test=true and produces zero suppression/counter side effects"
        status: pass
    human_judgment: false
  - id: D9
    description: "An event whose custom_args.send_id resolves to no live send is stored but produces no suppression"
    requirement: "WBHK-04"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/webhook-events-suppression.test.ts#D-15: an event whose custom_args.send_id resolves to no live send is stored but suppresses nothing"
        status: pass
    human_judgment: false
  - id: D10
    description: "workspace_webhook_endpoints.last_event_at is advanced during processing but debounced, not written on every event"
    requirement: "WBHK-04"
    verification:
      - kind: other
        ref: "webhook-events.worker.ts debounceWebhookHealth: single conditional UPDATE ... WHERE last_event_at IS NULL OR < now() - interval '60 seconds', called once per batch after the per-event loop"
        status: pass
    human_judgment: false

duration: 20min
completed: 2026-07-08
status: complete
---

# Phase 5 Plan 3: Delivery Fact Columns, Counters, and the Full Suppression Engine Summary

**Turned the 05-01 dedup-only webhook worker into the complete delivery-status + suppression engine: idempotent fact-column writes, exactly-once campaign counters, and the full D-10/D-11/D-12/D-13 suppression state machine (including the soft-bounce streak) -- all gated by the dedup RETURNING rows inside one tenant-scoped transaction.**

## Performance

- **Duration:** ~20 min
- **Completed:** 2026-07-08
- **Tasks:** 3
- **Files modified:** 12

## Accomplishments

- Added delivery fact + reason columns to `sends` (`delivered_at`, `first_opened_at`, `first_clicked_at`, `bounced_at`, `dropped_at`, `unsubscribed_at`, `spam_reported_at`, `bounce_reason`, `drop_reason`), a `consecutive_soft_bounces` streak counter to `contacts`, and unique-recipient delivery counters to `campaigns` (`delivered_count`/`opened_count`/`clicked_count`/`bounced_count`/`unsubscribed_count`) via migrations 0022-0024, applied live.
- `processWebhookEventBatch` now applies the full behavior contract for every genuinely-new (dedup-`RETURNING`-gated), non-test event whose `send_id` resolves to a live send: idempotent `WHERE <col> IS NULL` first-write fact updates (D-06), exactly-once campaign counters gated by that same first-write check (D-09), the complete suppression decision table from 05-02 (`resolveSuppression`) applied as a dual `contacts.subscription_status` + `workspace_suppressions` write (D-13), an atomic row-locked soft-bounce streak that suppresses at `SOFT_BOUNCE_SUPPRESS_THRESHOLD` (3) and resets to 0 on a genuinely-new delivery (D-10), and a debounced `workspace_webhook_endpoints.last_event_at` write once per batch (D-03).
- Discovered and fixed a latent FK-integrity gap inherited from 05-01: `send_events.send_id` carries a real foreign key to `sends(id)`, so an orphaned/never-existed `custom_args.send_id` would throw a constraint violation at INSERT time rather than the intended "stored but produces no suppression" (D-15) behavior. Fixed with a batch pre-resolution step that nulls out any candidate `send_id` not actually live in the workspace, before building the `send_events` INSERT.
- 22 new/extended integration tests against a real Postgres fixture cover exactly-once status/counter updates, out-of-order fact safety, the full suppression state machine (hard bounce, spam, unsubscribe/group_unsubscribe, the 3-way dropped-reason branches, the soft-bounce streak with reset), the test-marker short-circuit, and the orphaned-send case.

## Task Commits

Each task was committed atomically:

1. **Task 1: Delivery fact columns (sends), soft-bounce streak (contacts), delivery counters (campaigns) + BLOCKING migration push** - `db90fe8` (feat)
2. **Task 2: Full webhook-events side-effect pipeline** - `1596364` (feat)
3. **Task 3: Integration coverage** - `f9babae` (test)

## Files Created/Modified

- `packages/db/src/schema/sends.ts` - 7 fact timestamptz columns + 2 reason text columns
- `packages/db/src/schema/contacts.ts` - `consecutiveSoftBounces` integer, default 0
- `packages/db/src/schema/campaigns.ts` - 5 delivery counter integer columns, default 0
- `packages/db/migrations/0022_sends_delivery_columns.sql` - sends ALTER TABLE
- `packages/db/migrations/0023_contacts_soft_bounce_streak.sql` - contacts ALTER TABLE
- `packages/db/migrations/0024_campaigns_delivery_counters.sql` - campaigns ALTER TABLE
- `packages/db/migrations/meta/_journal.json` / `meta/0024_snapshot.json` - split-migration bookkeeping (04-01 precedent)
- `apps/worker/src/queues/webhook-events.worker.ts` - full side-effect pipeline (`applyEventSideEffects`, `setFactColumnOnce`, `incrementCampaignCounter`, `applySuppression`, `applyUnsubscribe`, `debounceWebhookHealth`, orphan-send pre-resolution)
- `apps/worker/src/queues/__tests__/webhook-events-status.test.ts` - fact + counter exactly-once, out-of-order safety (6 tests)
- `apps/worker/src/queues/__tests__/webhook-events-suppression.test.ts` - full suppression state machine, test-marker, orphan (10 tests)
- `apps/worker/src/queues/__tests__/webhook-events-idempotency.test.ts` - extended with a replay-side-effects assertion (1 new test)

## Decisions Made

- `spam_report` and `dropped` events both increment `campaigns.bounced_count` -- no dedicated spam/dropped counter exists (Task 1 added only 5 counter columns); every non-delivery, non-unsubscribe terminal folds into `bounced_count`, matching the D-08 "не доставлено" UI grouping, with the specific reason still queryable per-send via `bounce_reason`/`drop_reason`.
- Orphan `send_id` resolution runs as a batch pre-check (one `SELECT id FROM sends WHERE id = ANY(...)`) BEFORE the `send_events` INSERT, not discovered reactively -- the column's real FK to `sends(id)` means an unresolved id would otherwise crash the whole batch insert at constraint-check time, not gracefully no-op.
- `dropped`'s `bounced_count` increment fires for every dropped event that sets `dropped_at` for the first time, independent of whether `resolveSuppression` mapped it to suppressed/unsubscribed/no-change -- a drop is "не доставлено" regardless of the specific downstream status effect.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `send_events.send_id`'s real FK constraint rejects orphaned/never-existed send ids at INSERT time**
- **Found during:** Task 3 (writing the orphan-send integration test)
- **Issue:** The plan's D-15 behavior ("An event whose custom_args.send_id resolves to no live send is stored but produces no suppression") assumed the row could simply be inserted with the unresolved id and then skipped during side-effect processing. But `send_events.send_id references sends(id) ON DELETE SET NULL` is a real foreign key -- Postgres enforces referential integrity at INSERT time unconditionally, so passing through a `send_id` that was never a real `sends` row (e.g. a `kind: 'test'` dispatch's `randomUUID()` per Pitfall 2, or a garbage/deleted id) throws a 23503 constraint violation and aborts the whole batch, not a graceful "stored without a resolvable FK target" as the schema's own doc-comment describes. This gap was inherited unchanged from 05-01 (which never exercised a genuinely-nonexistent `send_id` against the live schema).
- **Fix:** Before building the `send_events` INSERT values, batch-resolve which candidate `send_id`s are actually live in the current workspace (`SELECT id FROM sends WHERE workspace_id = $1 AND id = ANY($2::uuid[])`) and null out any that aren't, so the INSERT never references a nonexistent id.
- **Files modified:** `apps/worker/src/queues/webhook-events.worker.ts`
- **Verification:** `webhook-events-suppression.test.ts#D-15: an event whose custom_args.send_id resolves to no live send is stored but suppresses nothing` passes; the row is stored with `send_id = NULL`, zero suppression writes occur.
- **Committed in:** `1596364` (Task 2)

---

**Total deviations:** 1 auto-fixed (1 bug -- a hard Postgres FK constraint the plan's D-15 wording didn't account for)
**Impact on plan:** Correctness-preserving; D-15's stated guarantee ("stored but no suppression") now actually holds for every orphan case, not just the ones where `send_id` happened to be null/non-UUID-shaped at extraction time. No scope creep.

## Issues Encountered

None beyond the deviation above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `sends`/`contacts`/`campaigns` now carry every column this phase's remaining plans (05-04, 05-05) and the delivery-tracking UI/campaign-metrics work need to read from: per-message current status can be derived via `deriveCurrentStatus` (05-02) against these same fact columns, and per-campaign summary stats are live in the 5 new counter columns.
- The webhook worker's side-effect pipeline is feature-complete for the WBHK-02/WBHK-04/SUBS-02 requirement set closed by this plan; no known gaps for the next plans to work around.
- `workspace_webhook_endpoints.last_event_at` is now actually advanced during normal processing (debounced), ready for a health-indicator UI in a later plan.

---
*Phase: 05-webhook-processing-delivery-tracking*
*Completed: 2026-07-08*

## Self-Check: PASSED

All 8 created/output files found on disk; all 3 task commit hashes (`db90fe8`, `1596364`, `f9babae`) found in git history.
