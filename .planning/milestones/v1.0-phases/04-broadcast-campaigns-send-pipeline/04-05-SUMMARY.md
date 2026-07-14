---
phase: 04-broadcast-campaigns-send-pipeline
plan: 05
subsystem: api
tags: [campaigns, state-machine, bullmq, role-guard, segments, fastify]

# Dependency graph
requires:
  - phase: 04-broadcast-campaigns-send-pipeline
    provides: "04-01: campaigns/campaign_recipients/sends/workspace_send_settings schema + shared-schemas campaign zod schemas + queue name/job-schema constants"
  - phase: 04-broadcast-campaigns-send-pipeline
    provides: "04-02: @mega-crm/kms envelope encryption (decryptTenantSecret)"
  - phase: 04-broadcast-campaigns-send-pipeline
    provides: "04-03: @mega-crm/delivery-core (buildContactTemplateData, audienceExclusionBreakdown, getWorkspaceSendSettings/upsertWorkspaceSendSettings)"
  - phase: 04-broadcast-campaigns-send-pipeline
    provides: "04-04: apps/worker email-broadcast/email-triggered workers consuming EMAIL_BROADCAST_QUEUE"
provides:
  - "apps/api/src/modules/campaigns/campaign.repository.ts: createCampaign/updateCampaign/listCampaigns/getCampaign/launchCampaign/scheduleCampaign/cancelCampaign/duplicateCampaign/deleteCampaign/getCampaignProgress, CampaignRow, CampaignStateError"
  - "apps/api/src/modules/campaigns/campaigns.routes.ts: registerCampaignsRoutes (full campaign lifecycle API + templates/senders/test-sample/progress/audience-breakdown)"
  - "apps/api/src/modules/campaigns/campaign-queues.ts: campaignKickoffQueue, emailBroadcastQueue (BullMQ producers)"
  - "apps/api/src/modules/campaigns/send-settings.routes.ts: registerSendSettingsRoutes"
  - "segment.repository.ts's deleteSegment now blocks when referenced by a non-canceled campaign (D-14) and gracefully maps the DB's unconditional FK RESTRICT too"
affects: [04-06, 04-07, 04-08]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Locked read-check-write (SELECT ... FOR UPDATE then status check then UPDATE) for every campaign state transition -- mirrors segment.repository.ts's updateSegment precedent, closes the D-08 'edit vs start' race"
    - "campaigns.routes.ts's launch/schedule/cancel/duplicate/settings-PUT routes re-fetch the workspace via findActiveWorkspaceBySlug inside the handler (not threaded from the requirePermission preHandler) -- matches members.ts's established double-lookup convention for role-gated routes"
    - "CampaignStateError.code ('not_found'|'illegal_transition'|'incomplete') maps to 404/409/422 via a single mapCampaignStateError helper reused across update/delete/schedule/cancel/duplicate; launch alone special-cases 'incomplete' first to attach the UI-SPEC per-field copy breakdown"

key-files:
  created:
    - apps/api/src/modules/campaigns/campaign.repository.ts
    - apps/api/src/modules/campaigns/campaigns.routes.ts
    - apps/api/src/modules/campaigns/campaign-queues.ts
    - apps/api/src/modules/campaigns/send-settings.routes.ts
    - apps/api/src/modules/campaigns/__tests__/campaign-state-machine.test.ts
  modified:
    - apps/api/src/server.ts
    - apps/api/src/modules/segments/segment.repository.ts
    - apps/api/src/modules/segments/segments.routes.ts

key-decisions:
  - "duplicateCampaign copies the source campaign's name verbatim (no '(copy)' suffix) -- the plan's action text says 'copies name/segment/template/sender into a fresh draft', read literally as an exact-value copy; renaming is a frontend/UX concern the 04-08 UI-SPEC plan can add without a repository change"
  - "launchCampaign's 'incomplete' check treats fromEmail OR fromSenderId as satisfying the sender requirement (either is a valid launch-ready sender per the createCampaignSchema's own optionality of both fields)"
  - "audience-breakdown route returns the raw segment member count (countSegmentMembers) alongside sends-ledger audienceExclusionBreakdown exactly as the plan's key_links specify -- before a campaign's first dispatch, the ledger-side breakdown is empty (no sends rows exist yet), which is expected: this endpoint's exclusion detail becomes populated once the 04-06 kickoff/dispatch worker starts writing 'excluded' rows"
  - "[Rule 1 - Bug] segment.repository.ts's deleteSegment: broadened beyond the plan's literal 'status != canceled' pre-check to also catch the DB's unconditional ON DELETE RESTRICT FK violation (postgres 23503) and convert it to the same SegmentConflictError -- a canceled campaign still carries campaigns.segment_id (04-01's T-04-01-03 backstop preserves it for Phase 7 history), so a segment referenced ONLY by a canceled campaign passed the app-level pre-check but still tripped the DB's FK, which would have surfaced as a raw 500 instead of a clean 409"

requirements-completed: [CAMP-01, CAMP-02, CAMP-03, CAMP-04, CAMP-05, SUBS-03]

coverage:
  - id: D1
    description: "draft -> sending succeeds when template/sender/segment are all set (CAMP-01/CAMP-02), sending_started_at is stamped"
    requirement: "CAMP-02"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/campaigns/__tests__/campaign-state-machine.test.ts#draft -> sending succeeds when template/sender/segment are set"
        status: pass
    human_judgment: false
  - id: D2
    description: "launchCampaign rejects as CampaignStateError('incomplete') when template/sender is missing"
    requirement: "CAMP-02"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/campaigns/__tests__/campaign-state-machine.test.ts#launch is rejected as 'incomplete' when template/sender is missing"
        status: pass
    human_judgment: false
  - id: D3
    description: "There is no repository code path from draft directly to a terminal state -- cancelCampaign rejects a plain draft as 'illegal_transition', and launchCampaign only ever produces 'sending' (CAMP-03/D-08)"
    requirement: "CAMP-03"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/campaigns/__tests__/campaign-state-machine.test.ts#draft -> sent is rejected (no direct jump; only sending/canceled are reachable via the repository)"
        status: pass
    human_judgment: false
  - id: D4
    description: "updateCampaign on a scheduled campaign is rejected (D-08, no in-place edit of a scheduled campaign)"
    requirement: "CAMP-03"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/campaigns/__tests__/campaign-state-machine.test.ts#updateCampaign on a scheduled campaign is rejected (D-08)"
        status: pass
    human_judgment: false
  - id: D5
    description: "scheduled -> draft cancel clears scheduled_at (D-07); sending -> canceled stamps terminal_at and preserves counters (D-09)"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/campaigns/__tests__/campaign-state-machine.test.ts#scheduled -> draft cancel works (D-07)"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/campaigns/__tests__/campaign-state-machine.test.ts#sending -> canceled works (D-09)"
        status: pass
    human_judgment: false
  - id: D6
    description: "duplicateCampaign creates a new draft copying segment/template/sender (D-11)"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/campaigns/__tests__/campaign-state-machine.test.ts#duplicate creates a new draft copying segment/template/sender"
        status: pass
    human_judgment: false
  - id: D7
    description: "Role gates present on launch/schedule/cancel/duplicate and send-settings PUT (D-19); no direct SendGrid mail/send call in campaigns.routes.ts (test-send always enqueues kind='test')"
    requirement: "CAMP-04"
    verification:
      - kind: other
        ref: "grep -n requirePermission apps/api/src/modules/campaigns/campaigns.routes.ts apps/api/src/modules/campaigns/send-settings.routes.ts -- 5 matches (launch/schedule/cancel/duplicate/settings-PUT); grep -n 'mail/send|sgMail|sendTenantMailV3' campaigns.routes.ts -- 0 matches"
        status: pass
    human_judgment: false
  - id: D8
    description: "Deleting a segment referenced by a non-canceled campaign is blocked with a 409 (D-03/Phase 3 D-14)"
    requirement: "SUBS-03"
    verification:
      - kind: other
        ref: "grep -q referenced_by_campaign apps/api/src/modules/segments/segment.repository.ts; scratch integration verification (not committed) confirmed SegmentConflictError is thrown both pre-delete (non-canceled reference) and via the FK-violation fallback (canceled-only reference)"
        status: pass
    human_judgment: false
  - id: D9
    description: "apps/api typechecks; full apps/api test suite (143 tests) passes after all three tasks"
    verification:
      - kind: other
        ref: "cd apps/api && npx tsc -p tsconfig.json --noEmit (clean); npm run test -- (25 test files, 143 tests, all pass)"
        status: pass
    human_judgment: false

duration: 35min
completed: 2026-07-06
status: complete
---

# Phase 4 Plan 5: Campaign lifecycle backend Summary

**The campaign lifecycle API: a locked draft->scheduled->sending->sent/canceled state machine repository, its Fastify routes (CRUD, launch/schedule/cancel/duplicate, test-send, test-sample, progress, audience-breakdown, templates/senders), BullMQ kickoff/test producers, workspace send-settings routes, and the D-14 segment-delete block.**

## Performance

- **Duration:** ~35 min
- **Tasks:** 3 (all executed, no checkpoints)
- **Files modified:** 8 (5 created, 3 modified)

## Accomplishments
- `campaign.repository.ts`: `CampaignRow`/`CampaignStateError` types, `CAMPAIGN_COLUMNS` alias list, and every CRUD + state-transition function (`createCampaign`, `listCampaigns`, `getCampaign`, `updateCampaign`, `launchCampaign`, `scheduleCampaign`, `cancelCampaign`, `duplicateCampaign`, `deleteCampaign`, `getCampaignProgress`) -- every transition does a locked `SELECT ... FOR UPDATE` before checking status and writing, exactly mirroring `segment.repository.ts`'s `updateSegment` precedent.
- `campaign-state-machine.test.ts`: 8 integration tests against a real Postgres test DB (via `buildServer`/sign-up/workspace/segment HTTP fixtures + direct repository calls) covering draft->sending happy path, incomplete-launch rejection, the "no direct draft->sent jump" invariant, update-on-scheduled rejection, scheduled->draft cancel, sending->canceled cancel, and duplicate.
- `campaign-queues.ts`: `campaignKickoffQueue`/`emailBroadcastQueue` BullMQ producers, copying `imports-csv-queue.ts`'s connection-options + `defaultJobOptions` (attempts 5, exponential backoff, `removeOnFail: false`) shape exactly.
- `campaigns.routes.ts`: full `registerCampaignsRoutes` -- ordinary-member CRUD (create/list/get/update/delete), Owner/Admin-only launch/schedule/cancel/duplicate (`requirePermission("campaign","launch")`, D-19), test-send (enqueues `kind:'test'` on the same broadcast queue the 04-04 worker consumes, never a direct SendGrid call), `GET /test-sample` (the single `buildContactTemplateData` contract, D-18, with a placeholder fallback built through the same function rather than an ad-hoc object), `GET /progress` (row counters + a live `sends`-ledger cross-check, CAMP-05), `GET /audience-breakdown` (segment count + `delivery-core.audienceExclusionBreakdown`, D-04), and `GET /sendgrid/templates` + `GET /sendgrid/senders` (decrypt tenant key -> live SendGrid lookups, D-16/D-17).
- `send-settings.routes.ts`: `registerSendSettingsRoutes` -- member-level GET, Owner/Admin-only PUT for the workspace's frequency cap / RPS override (D-13).
- `server.ts`: both new route modules registered.
- `segment.repository.ts`/`segments.routes.ts`: `deleteSegment` now pre-checks `campaigns WHERE segment_id = $1 AND status != 'canceled'` and throws `SegmentConflictError('referenced_by_campaign')`; the DELETE route maps it to 409. A Rule-1 fix additionally catches the DB's own unconditional FK-violation (23503) for the canceled-campaign-only-reference edge case the pre-check alone doesn't cover.

## Task Commits

1. **Task 1: Campaign repository + state machine** - `ec131bf` (feat)
2. **Task 2: Campaign routes + queue producers + send-settings routes** - `81f4db6` (feat)
3. **Task 3: D-14 segment-delete block when referenced by a campaign** - `be38694` (fix, includes the Rule-1 FK-violation fallback)

## Files Created/Modified
- `apps/api/src/modules/campaigns/campaign.repository.ts` - state machine + CRUD (10 exported functions, `CampaignStateError`)
- `apps/api/src/modules/campaigns/__tests__/campaign-state-machine.test.ts` - 8 integration tests
- `apps/api/src/modules/campaigns/campaign-queues.ts` - `campaignKickoffQueue`/`emailBroadcastQueue` producers
- `apps/api/src/modules/campaigns/campaigns.routes.ts` - `registerCampaignsRoutes` (14 routes)
- `apps/api/src/modules/campaigns/send-settings.routes.ts` - `registerSendSettingsRoutes` (GET/PUT)
- `apps/api/src/server.ts` - registers both new route modules
- `apps/api/src/modules/segments/segment.repository.ts` - `deleteSegment` D-14 pre-check + FK-violation fallback
- `apps/api/src/modules/segments/segments.routes.ts` - DELETE handler maps `SegmentConflictError` to 409

## Decisions Made
- Every campaign state transition locks the row (`SELECT ... FOR UPDATE`) before checking status and writing -- the same locked read-check-write discipline `segment.repository.ts`'s `updateSegment` already established, closing the D-08 "edit vs start" race by construction rather than by convention.
- `launchCampaign`'s incomplete-field validation accepts `fromEmail` OR `fromSenderId` as satisfying the sender requirement (either is launch-ready).
- `duplicateCampaign` copies the source campaign's `name` verbatim (no auto-generated suffix) -- a literal reading of the plan's action text; a UI-level rename affordance is 04-08's concern, not this plan's.
- Launch/schedule/cancel/duplicate routes and the send-settings PUT route re-fetch the workspace via `findActiveWorkspaceBySlug` inside the handler body (rather than threading it from the `requirePermission` preHandler) -- matches `members.ts`'s established double-lookup convention for role-gated routes in this codebase.
- `CampaignStateError`'s three codes (`not_found`/`illegal_transition`/`incomplete`) map to 404/409/422 via one shared `mapCampaignStateError` helper reused by update/delete/schedule/cancel/duplicate; only `launch` special-cases `incomplete` first, to attach the UI-SPEC per-field copy (`segmentId`/`templateId`/`sender`) the confirm dialog needs.
- `GET /audience-breakdown` returns the raw segment count plus the ledger-derived exclusion breakdown exactly as the plan's `key_links` specify; before a campaign's first dispatch the exclusion breakdown is empty by design (no `sends` rows exist yet) -- it becomes populated once 04-06's kickoff/dispatch worker starts recording excluded contacts.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `segment.repository.ts`'s `deleteSegment` left a gap where a segment referenced ONLY by a canceled campaign still surfaced a raw 500**
- **Found during:** Task 3, an ad-hoc scratch integration test written to validate the D-14 delete-block against the real test DB before committing (not part of the plan's `files_modified`, removed after verification)
- **Issue:** The plan's literal pre-check (`campaigns WHERE segment_id = $1 AND status != 'canceled'`) correctly allows the DELETE to proceed once the only referencing campaign is canceled -- but `campaigns.segment_id` is `ON DELETE RESTRICT` (04-01's `T-04-01-03` backstop, which deliberately does NOT distinguish by campaign status, since a canceled campaign still needs its audience reference preserved for Phase 7 history). The DELETE statement itself then throws a raw Postgres `23503` foreign-key-violation error, which `segments.routes.ts`'s DELETE handler had no way to distinguish from any other unexpected error -- it would have surfaced as a bare 500 instead of the same actionable `SegmentConflictError`/409 the non-canceled case already gets.
- **Fix:** Wrapped the `DELETE FROM segments` statement in a try/catch; on Postgres error code `23503`, throw the same `SegmentConflictError('referenced_by_campaign')` instead of letting the raw constraint violation propagate.
- **Files modified:** `apps/api/src/modules/segments/segment.repository.ts`
- **Verification:** Scratch integration test (removed after verification) confirmed both paths now throw `SegmentConflictError`: (a) a non-canceled referencing campaign trips the app-level pre-check, and (b) a campaign that was canceled after being referenced still trips the FK-fallback catch, both producing the same 409 shape. Full `apps/api` test suite (143 tests) remains green.
- **Committed in:** `be38694` (Task 3 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 bug, found via ad-hoc verification testing, not a plan-scope expansion)
**Impact on plan:** Closes a real 500-vs-409 gap in the exact feature this task was building; no API surface changed, no new files beyond what the plan specified.

## Issues Encountered
None beyond the deviation above.

## User Setup Required
None - no new external service configuration required. Reuses the SendGrid key/KMS/Redis setup already documented in prior 04-01..04-04 STATE.md entries.

## Next Phase Readiness
- `campaignKickoffQueue.add('kickoff', { workspaceId, campaignId }, { jobId: campaignId })` is enqueued on launch -- 04-06's scheduler/kickoff worker can consume `CAMPAIGN_KICKOFF_QUEUE` jobs immediately, re-deriving recipients/template/sender from the campaign row.
- `emailBroadcastQueue.add('test', ...)` from the test-send route is consumable today by the already-built 04-04 `email-broadcast.worker.ts` (`kind: 'test'` path already implemented there).
- `GET /audience-breakdown` and `GET /progress` are ready for 04-08's UI to poll once 04-06 starts writing to the `sends` ledger during an actual send.
- No blockers for 04-06 (scheduler + kickoff worker), 04-07, or 04-08 (frontend).

---
*Phase: 04-broadcast-campaigns-send-pipeline*
*Completed: 2026-07-06*

## Self-Check: PASSED

All 8 key files confirmed present on disk (5 created, 3 modified); all three task commits (`ec131bf`, `81f4db6`, `be38694`) confirmed in git history; apps/api typechecks clean; full apps/api test suite (25 test files, 143 tests) passes.
