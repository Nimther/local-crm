---
phase: 05-webhook-processing-delivery-tracking
plan: 02
subsystem: delivery-core

tags: [sendgrid, webhook, suppression, delivery-tracking, typescript, vitest]

# Dependency graph
requires:
  - phase: 04-broadcast-campaigns-send-pipeline
    provides: "buildMailSendRequest + send-dispatch.ts's two call sites (kind='campaign'/'test') to extend"
provides:
  - "buildMailSendRequest forces open_tracking/click_tracking on for every send (D-04)"
  - "kind='test' sends carry a test='true' custom_arg distinguishable in webhook payloads (D-15)"
  - "normalizeEventType: pure SendGrid event -> NormalizedEventType mapper (WBHK-02), incl. hard/soft bounce split"
  - "resolveSuppression: pure event+reason -> subscription-status-outcome decision table (SUBS-02, D-10/D-11/D-12)"
  - "deriveCurrentStatus: pure D-06 priority helper from a DeliveryFacts fact-timestamp set"
  - "SOFT_BOUNCE_SUPPRESS_THRESHOLD=3 shared platform constant for 05-03's streak logic"
affects: [05-03, 05-04, 05-05]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pure decision-table modules (no db/pg/tenant-context imports) for event->status logic, fully unit-tested without a database, consumed later by the webhook worker's side-effect writes"
    - "Read-time status-derivation helper (not a stored generated column) so priority rules can change without a migration"

key-files:
  created:
    - packages/delivery-core/src/event-normalize.ts
    - packages/delivery-core/src/suppression-rules.ts
    - packages/delivery-core/src/send-status.ts
    - packages/delivery-core/src/__tests__/event-normalize.test.ts
    - packages/delivery-core/src/__tests__/suppression-rules.test.ts
    - packages/delivery-core/src/__tests__/send-status.test.ts
    - packages/delivery-core/src/__tests__/send-mail.test.ts
  modified:
    - packages/delivery-core/src/send-mail.ts
    - packages/delivery-core/src/index.ts
    - apps/worker/src/queues/send-dispatch.ts

key-decisions:
  - "isTest defaults to undefined/false on BuildMailSendRequestParams; only kind='test' dispatch passes isTest:true, kind='campaign' explicitly passes isTest:false"
  - "custom_args widened with an optional test?: \"true\" field rather than a generic Record<string,string>, keeping the three base keys type-checked"
  - "deriveCurrentStatus's DeliveryFacts includes unsubscribedAt in its interface (per plan spec) but it does not participate in the D-06 priority chain -- unsubscribe is a subscription-status concern, not a delivery-status one"

patterns-established:
  - "Pure event/suppression/status decision modules live in packages/delivery-core with zero DB imports, verified by a grep-based acceptance check, so the 05-03 worker can import them for side-effect writes without smuggling in a DB dependency"

requirements-completed: [WBHK-02, SUBS-02]

coverage:
  - id: D1
    description: "buildMailSendRequest forces open_tracking/click_tracking on for every send, independent of tenant account settings (D-04)"
    requirement: "WBHK-02"
    verification:
      - kind: unit
        ref: "packages/delivery-core/src/__tests__/send-mail.test.ts#forces open_tracking and click_tracking on alongside the existing subscription_tracking:false"
        status: pass
    human_judgment: false
  - id: D2
    description: "kind='test' sends carry a test='true' custom_arg; kind='campaign' sends never carry it"
    requirement: "SUBS-02"
    verification:
      - kind: unit
        ref: "packages/delivery-core/src/__tests__/send-mail.test.ts#a test build (isTest: true) has custom_args.test === 'true'"
        status: pass
      - kind: unit
        ref: "packages/delivery-core/src/__tests__/send-mail.test.ts#a campaign build (isTest omitted) has NO test custom_arg"
        status: pass
    human_judgment: false
  - id: D3
    description: "normalizeEventType maps every WBHK-02 SendGrid event to a stable normalized type, with hard vs soft bounce split, returning null for out-of-scope events"
    requirement: "WBHK-02"
    verification:
      - kind: unit
        ref: "packages/delivery-core/src/__tests__/event-normalize.test.ts"
        status: pass
    human_judgment: false
  - id: D4
    description: "resolveSuppression implements the full D-10/D-11/D-12 suppression decision table, pure and DB-free"
    requirement: "SUBS-02"
    verification:
      - kind: unit
        ref: "packages/delivery-core/src/__tests__/suppression-rules.test.ts"
        status: pass
    human_judgment: false
  - id: D5
    description: "deriveCurrentStatus applies the D-06 terminal>clicked>opened>delivered>sent priority order, order-insensitively"
    requirement: "WBHK-02"
    verification:
      - kind: unit
        ref: "packages/delivery-core/src/__tests__/send-status.test.ts"
        status: pass
    human_judgment: false

# Metrics
duration: 15min
completed: 2026-07-08
status: complete
---

# Phase 5 Plan 2: Send-Side Markers and Pure Delivery Decision Logic Summary

**Forced open/click tracking + test-send marker on every mail/send, plus three pure DB-free decision modules (event normalization, suppression rules, current-status priority) ready for the 05-03 webhook worker.**

## Performance

- **Duration:** 15 min
- **Completed:** 2026-07-08
- **Tasks:** 3
- **Files modified:** 10

## Accomplishments
- `buildMailSendRequest` now forces `open_tracking`/`click_tracking` on for every outbound message (D-04), independent of a tenant's own SendGrid account settings, so opened/clicked webhook events actually fire.
- `kind='test'` sends are tagged with a `test="true"` custom_arg (D-15); `kind='campaign'` sends never carry the key, verified by dedicated unit tests on both branches.
- `normalizeEventType` maps every WBHK-02 SendGrid event (delivered/open/click/bounce with hard-vs-soft split/dropped/spamreport/unsubscribe/group_unsubscribe) to a stable type, returning `null` for out-of-scope events.
- `resolveSuppression` encodes the full D-10/D-11/D-12 suppression decision table (hard bounce, spam report, unsubscribe/group_unsubscribe, and the 4-way `dropped`-reason map), pure and DB-free.
- `deriveCurrentStatus` implements the D-06 current-status priority (terminal bounced/dropped/spam > clicked > opened > delivered > baseStatus) as a read-time helper, proven order-insensitive by test.

## Task Commits

Each task was committed atomically:

1. **Task 1: Force open/click tracking (D-04) + test-marker custom_arg (D-15)** - `3ef31ce` (feat)
2. **Task 2: Pure event-type normalization + suppression decision table** - `f6d6d20` (feat)
3. **Task 3: Current-status priority helper (D-06)** - `33187a4` (feat)

**Plan metadata:** (this commit, docs: complete plan)

## Files Created/Modified
- `packages/delivery-core/src/send-mail.ts` - Extended `SendGridMailSendRequest`/`BuildMailSendRequestParams` with forced tracking_settings + optional `isTest`/`test` custom_arg
- `packages/delivery-core/src/event-normalize.ts` - `normalizeEventType` + `NormalizedEventType` (WBHK-02)
- `packages/delivery-core/src/suppression-rules.ts` - `resolveSuppression`, `ADDRESS_DROP_REASONS`, `SOFT_BOUNCE_SUPPRESS_THRESHOLD` (SUBS-02)
- `packages/delivery-core/src/send-status.ts` - `deriveCurrentStatus`, `DeliveryFacts` (D-06)
- `packages/delivery-core/src/index.ts` - barrel exports for all three new modules
- `apps/worker/src/queues/send-dispatch.ts` - both `buildMailSendRequest` call sites pass the correct `isTest` flag
- `packages/delivery-core/src/__tests__/{send-mail,event-normalize,suppression-rules,send-status}.test.ts` - unit coverage for all of the above

## Decisions Made
- `isTest` is optional on `BuildMailSendRequestParams`; the `kind==='campaign'` call site explicitly passes `isTest: false` (rather than omitting it) for clarity and symmetry with the `kind==='test'` call site's `isTest: true`.
- `custom_args` widened with a narrowly-typed optional `test?: "true"` field (not a generic string-record) so the three base keys (`send_id`/`workspace_id`/`campaign_id`) stay required and type-checked.
- `DeliveryFacts` retains `unsubscribedAt` in its shape (matching the plan's literal interface spec) even though D-06's priority chain doesn't reference it — unsubscribe is a subscription-status concern the 05-03 worker handles separately from delivery-status derivation.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Both pure decision modules (`event-normalize.ts`, `suppression-rules.ts`) and the priority helper (`send-status.ts`) are DB-free and fully unit-tested, ready for 05-03's webhook worker to import for its actual side-effect writes (send fact-column updates, `contacts.subscription_status` transitions, `workspace_suppressions` inserts).
- `SOFT_BOUNCE_SUPPRESS_THRESHOLD` constant is in place for 05-03's soft-bounce streak logic to reference rather than hardcoding N=3 a second time.
- `buildMailSendRequest`'s `isTest` flag and forced tracking settings are live in the actual send path (`send-dispatch.ts`), so 05-03's webhook payloads will already carry the `test` custom_arg and open/click events will already be firing once 05-01's provisioning + 05-03's worker land.
- No blockers.

---
*Phase: 05-webhook-processing-delivery-tracking*
*Completed: 2026-07-08*

## Self-Check: PASSED

All created/modified files verified present on disk; all 3 task commit hashes (3ef31ce, f6d6d20, 33187a4) verified present in git log.
