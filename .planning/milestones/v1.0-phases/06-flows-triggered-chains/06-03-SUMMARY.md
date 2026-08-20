---
phase: 06-flows-triggered-chains
plan: 03
subsystem: worker
tags: [bullmq, postgres, partial-unique-index, idempotency, rate-limiter, flows]

requires:
  - phase: 06-01
    provides: "sends.flow_run_id/node_id columns + sends_flow_run_node_unique partial unique index (WHERE kind='flow') -- the DB-level idempotency guarantee this plan's claim function is built on"
  - phase: 06-02
    provides: "emailTriggeredJobSchema's kind:'flow' discriminated-union variant (flowRunId/nodeId/contactId, no campaignId) that processSendJob now parses and dispatches"
  - phase: 04-broadcast-campaigns
    provides: "processSendJob's three-unit dispatch discipline (claim tx / SendGrid call outside any tx / terminal record tx), evaluatePreSendGate, consumeTenantToken per-tenant rate limiter -- all extended, not forked, for the flow path"
provides:
  - "claimFlowSend + recordFlowStepResult + recordFlowExcluded in @mega-crm/delivery-core -- flow-shaped siblings of dispatchSendGate/recordSendResult/recordExcluded"
  - "readFlowSendPrereqs + claimFlowSend orchestration in apps/worker/src/queues/flows/flow-send.ts -- resolves template/sender from the PINNED flow_versions.definition send-node config"
  - "processSendJob kind:'flow' branch in send-dispatch.ts -- rides the SAME email-triggered queue, per-tenant token bucket, and pre-send gate as campaigns"
  - "createFixtureFlowRun test helper in apps/worker/src/test/db-fixture.ts -- reusable flows/flow_versions/flow_runs triplet seed for every later flow-engine test file in this phase"
affects: [06-04, 06-05, 06-06, 06-07, 06-08, 06-09, 06-10, 06-11]

tech-stack:
  added: []
  patterns:
    - "Flow-shaped siblings of every campaign-ledger primitive (claimFlowSend/recordFlowStepResult/recordFlowExcluded next to dispatchSendGate/recordSendResult/recordExcluded) instead of a parallel campaign-vs-flow abstraction -- keeps the ON CONFLICT/partial-index shape obvious at each call site"
    - "processSendJob branches on job.kind BEFORE choosing which Zod schema to parse with -- emailBroadcastJobSchema for campaign/test, emailTriggeredJobSchema's flow variant for flow -- since a flow job has no campaignId and would fail the broadcast schema's required field"
    - "Optional (not omitted) campaignId in delivery-core's buildMailSendRequest/custom_args -- conditional-spread pattern already established for isTest, reused for campaign_id so a flow send's custom_args never carries a misleading empty/stale campaign_id"

key-files:
  created:
    - apps/worker/src/queues/flows/flow-send.ts
    - apps/worker/src/queues/__tests__/flow-send-idempotency.test.ts
  modified:
    - packages/delivery-core/src/send-ledger.ts
    - packages/delivery-core/src/index.ts
    - packages/delivery-core/src/send-mail.ts
    - apps/worker/src/queues/send-dispatch.ts
    - apps/worker/src/test/db-fixture.ts
    - apps/worker/package.json
    - package-lock.json

key-decisions:
  - "recordFlowStepResult is a full standalone implementation (not a thin call-through to recordSendResult), duplicating the $2::send_status cast query verbatim -- keeps the acceptance-criteria-grep-able cast local to the function name callers actually see, even though the underlying UPDATE is byte-identical to recordSendResult's (both key off sends.id alone, not kind)"
  - "buildMailSendRequest's campaignId became optional (Rule 2 deviation, not in the plan's files_modified list) so a flow send's custom_args can omit campaign_id entirely instead of sending an empty string -- webhook attribution (05-03) resolves via custom_args.send_id -> a DB lookup of the sends row, never custom_args.campaign_id, so this is a type-honesty fix with no behavior-changing risk to existing campaign/test dispatch"
  - "createFixtureFlowRun lives in the shared db-fixture.ts (not duplicated per-test-file like createFixtureCampaign/createFixtureContact) because every remaining flow-engine plan in this phase (06-04 through 06-11) will need the identical flows/flow_versions/flow_runs triplet shape"
  - "readFlowSendPrereqs reads templateId/fromEmail directly from the send-node's jsonb config with no SendGrid verified-senders API call inline -- unlike campaigns' resolveCampaignFromEmail (which resolves fromSenderId -> fromEmail at campaign-launch time via a live SendGrid call), that resolution step is out of this plan's scope (flow publish/CRUD routes are 06-04's responsibility); this plan's dispatch worker only reads whatever fromEmail is already persisted in the definition and throws if it's missing"

requirements-completed: [FLOW-01, FLOW-07]

coverage:
  - id: D1
    description: "A flow send-node dispatch claims the sends ledger via ON CONFLICT (workspace_id, flow_run_id, node_id) DO NOTHING, so a redelivered identical job never double-sends"
    requirement: "FLOW-07"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/flow-send-idempotency.test.ts#T-06-03-01: a redelivered flow-step job sends exactly once and inserts exactly one kind='flow' sends row"
        status: pass
    human_judgment: false
  - id: D2
    description: "A kind:'flow' job routes through the SAME email-triggered queue, the SAME per-tenant token bucket, and the SAME pre-send gate as campaigns -- no forked dispatch path, no second rate limiter"
    requirement: "FLOW-01"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/flow-send-idempotency.test.ts#T-06-03-02: the flow path consumes the SAME per-tenant token bucket key as campaign/test dispatch (no second limiter)"
        status: pass
      - kind: other
        ref: "grep confirms consumeTenantToken (rate-limiter.ts) is the only rate-limiter call in send-dispatch.ts, used identically by both kind==='campaign' and kind==='flow' branches"
        status: pass
    human_judgment: false
  - id: D3
    description: "processSendJob resolves template + sender for a flow send from the pinned flow_versions.definition send-node config (not from a campaigns row)"
    requirement: "FLOW-01"
    verification:
      - kind: other
        ref: "grep confirms flow-send.ts joins flow_runs.flow_version_id (never flows.live_version_id); npm run build -w apps/worker exits 0"
        status: pass
    human_judgment: false
  - id: D4
    description: "D-05: a flow send blocked by the pre-send gate (suppressed/unsubscribed/frequency-capped) is recorded excluded in the ledger and skipped -- same disposition as broadcast; the gate is re-evaluated at EVERY dispatch so a contact re-subscribed mid-flow has its subsequent sends go out"
    requirement: "FLOW-01"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/flow-send-idempotency.test.ts#T-06-03-03/D-05: a suppressed contact's flow send is recorded excluded and SendGrid is never called"
        status: pass
    human_judgment: false

duration: 20min
completed: 2026-07-10
status: complete
---

# Phase 6 Plan 3: Idempotent flow-step send Summary

**Flow send-node dispatch extends (not forks) the existing email-triggered pipeline: claimFlowSend's partial-unique-index claim guarantees at-most-once send under BullMQ redelivery, while the SAME rate limiter and pre-send gate as campaigns run unmodified.**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-07-10T03:49:00Z
- **Completed:** 2026-07-10T04:09:00Z
- **Tasks:** 3
- **Files modified:** 9 (2 created, 7 modified)

## Accomplishments
- Added `claimFlowSend`/`recordFlowStepResult`/`recordFlowExcluded` to `packages/delivery-core/src/send-ledger.ts` -- flow-shaped siblings of `dispatchSendGate`/`recordSendResult`/`recordExcluded` that key off `(workspace_id, flow_run_id, node_id)` against the `sends_flow_run_node_unique` partial index (06-01) instead of `(workspace_id, campaign_id, contact_id)`. Exported from the delivery-core barrel.
- New `apps/worker/src/queues/flows/flow-send.ts`: `readFlowSendPrereqs` resolves the tenant's decrypted SendGrid key + RPS override (same as campaigns) plus `templateId`/`fromEmail` from the **pinned** `flow_versions.definition` send-node config (joined via `flow_runs.flow_version_id`, never `flows.live_version_id`); `claimFlowSend` orchestration mirrors `claimCampaignSend`'s exact shape (contact fetch -> `evaluatePreSendGate` -> idempotent ledger claim -> unsubscribe token + `dynamicTemplateData` build).
- `send-dispatch.ts`'s `processSendJob` now branches on `job.kind === "flow"` **before** choosing a Zod schema (a flow job has no `campaignId` and would fail `emailBroadcastJobSchema`'s required field), then dispatches through a new `processFlowSendJob` that replicates the campaign path's three-unit discipline (claim tx commits before any network call / SendGrid call outside any tx / terminal-record tx only after SendGrid responds) and calls the SAME `consumeTenantToken` limiter instance -- no second rate limiter constructed anywhere in the flow path.
- `packages/delivery-core/src/send-mail.ts`: `campaignId` widened to optional in `BuildMailSendRequestParams`/`custom_args` (Rule 2 deviation -- see below) so a flow send's `custom_args` never carries a misleading `campaign_id`.
- New `flow-send-idempotency.test.ts` (3 integration tests against real Postgres/Redis): redelivery sends exactly once and inserts exactly one `kind='flow'` sends row; a suppressed contact is recorded excluded with zero SendGrid calls; the flow path is proven to share the campaign path's per-tenant token bucket by exhausting it and observing the flow send get rate-limited too.
- `createFixtureFlowRun` added to the shared `apps/worker/src/test/db-fixture.ts` -- seeds a minimal `flows`/`flow_versions`/`flow_runs` triplet with one send node, reusable by every remaining flow-engine test file in this phase.
- Full `apps/worker` suite: 71/71 tests passing (15 files) -- no regressions.

## Task Commits

Each task was committed atomically:

1. **Task 1: claimFlowSend + recordFlowStepResult in delivery-core send-ledger** - `c3de450` (feat)
2. **Task 2: readFlowSendPrereqs + processSendJob kind:'flow' branch** - `f60cce7` (feat)
3. **Task 3: Redelivery idempotency integration test** - `d7907f7` (test)

**Plan metadata:** pending (docs: complete plan)

_Note: Task 3 carries `tdd="true"` in the plan, but the SendGrid-dispatch feature it verifies was implemented in Tasks 1-2 immediately prior in this SAME plan (the plan's own explicit task ordering, not a masked bug) -- see "TDD Gate Compliance" below._

## Files Created/Modified
- `packages/delivery-core/src/send-ledger.ts` - claimFlowSend, recordFlowStepResult, recordFlowExcluded
- `packages/delivery-core/src/index.ts` - exports the three new functions from the barrel
- `packages/delivery-core/src/send-mail.ts` - campaignId optional in BuildMailSendRequestParams/custom_args (Rule 2)
- `apps/worker/src/queues/flows/flow-send.ts` - readFlowSendPrereqs + claimFlowSend orchestration (new file)
- `apps/worker/src/queues/send-dispatch.ts` - processSendJob kind:'flow' branch + processFlowSendJob
- `apps/worker/src/test/db-fixture.ts` - createFixtureFlowRun shared test fixture
- `apps/worker/src/queues/__tests__/flow-send-idempotency.test.ts` - redelivery/exclusion/rate-limiter-sharing integration tests (new file)
- `apps/worker/package.json` - added @mega-crm/flows-core dependency
- `package-lock.json` - lockfile update for the new workspace dependency

## Decisions Made
- `recordFlowStepResult` duplicates `recordSendResult`'s `$2::send_status`-cast UPDATE verbatim rather than delegating to it, so the cast discipline documented in the acceptance criteria is directly visible at the function callers actually invoke.
- `buildMailSendRequest`'s `campaignId` became optional (not in this plan's `files_modified` list -- Rule 2 auto-add) since webhook attribution resolves via `custom_args.send_id` -> a DB lookup, never `custom_args.campaign_id`; omitting the key for flow sends is strictly more correct than sending an empty string, with zero behavior change for existing campaign/test dispatch (which still always passes a real `campaignId`).
- `createFixtureFlowRun` was centralized in `db-fixture.ts` instead of being duplicated locally in `flow-send-idempotency.test.ts` (unlike `createFixtureCampaign`/`createFixtureContact`, which stay local per the established convention) because every remaining flow-engine plan in this phase needs the identical triplet shape.
- `readFlowSendPrereqs` does not call SendGrid's verified-senders API to resolve `fromSenderId` -> `fromEmail` inline (unlike campaigns' `resolveCampaignFromEmail`) -- that resolution is 06-04's responsibility (flow publish/CRUD routes); this plan's dispatch worker only reads whatever `fromEmail` is already persisted in the pinned definition and throws if it's missing.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Made `campaignId` optional in `buildMailSendRequest`/`custom_args`**
- **Found during:** Task 2
- **Issue:** The plan's Task 2 action explicitly requires "campaignId omitted for flow sends" when calling `buildMailSendRequest`, but `packages/delivery-core/src/send-mail.ts` (not listed in this plan's `files_modified`) declared `campaignId: string` as a required field on both `BuildMailSendRequestParams` and the built `custom_args`, with no conditional-omission path.
- **Fix:** Widened `campaignId` to optional in both the params interface and `SendGridMailSendRequest`'s `custom_args` type, and switched to the same conditional-spread pattern already used for `isTest` (`...(params.campaignId !== undefined ? { campaign_id: params.campaignId } : {})`) so a flow send's `custom_args` never carries the key at all.
- **Files modified:** `packages/delivery-core/src/send-mail.ts`
- **Verification:** `npm run build -w packages/delivery-core -w apps/worker -w apps/api` all exit 0; `flow-send-idempotency.test.ts`'s first test asserts `payload?.personalizations[0].custom_args` does NOT have a `campaign_id` property; full `apps/worker` suite (71/71, including the pre-existing campaign-path tests that DO expect `campaign_id`, via `packages/delivery-core`'s own build) still passes.
- **Committed in:** `f60cce7` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (Rule 2)
**Impact on plan:** Necessary type-level correction so the flow dispatch path can honestly omit `campaign_id` from `custom_args` as the plan's own Task 2 action required; no behavior change to the existing campaign/test dispatch paths (they still always pass a concrete `campaignId`).

## TDD Gate Compliance

Task 3 is tagged `tdd="true"` in the plan, and its commit is `test(06-03): ...` (`d7907f7`) with no separate GREEN `feat` commit following it. This is NOT a missing-gate violation: the SendGrid-dispatch behavior Task 3's test verifies (`claimFlowSend`, `processFlowSendJob`) was built in Tasks 1-2 immediately prior, per the plan's own explicit task ordering (Task 1: ledger primitives -> Task 2: dispatch branch -> Task 3: integration test). Running the new test against the already-complete implementation passed on the first attempt (3/3, no debugging needed) -- there was no RED phase to record because there was no remaining implementation gap by the time Task 3 started. The full `apps/worker` suite (71/71) confirms no regression was introduced by treating Tasks 1-2 as the de facto GREEN state this test proves.

## Issues Encountered
None. Postgres and Redis were already running locally (verified via `pg_isready`/`redis-cli ping`); `npm install` picked up the new `@mega-crm/flows-core` workspace dependency without any registry fetch (already symlinked via the existing workspace install).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- `claimFlowSend`/`recordFlowStepResult`/`recordFlowExcluded` (delivery-core) and `readFlowSendPrereqs`/`claimFlowSend` orchestration (`flow-send.ts`) are ready for 06-05's flow-run-advance worker to call once a `send` node is reached during a run's advance step -- this plan only builds the dispatch half (queue -> SendGrid), not the "what enqueues this job" half (flow_run_steps append, run advance), which 06-05 owns per this plan's `<implementation>` note.
- `createFixtureFlowRun` in `db-fixture.ts` is ready for reuse by 06-04 (publish/CRUD routes), 06-05 (run-advance worker), and 06-06 (reconciliation/segment-sweep workers) test suites.
- `readFlowSendPrereqs` currently throws if a send node's `fromEmail` is unset -- 06-04's flow publish validation (`validateFlowDefinition`, 06-02) does not currently enforce this at publish time (only the three D-17 hard errors: `no_trigger`/`empty_send`/`branch_missing_exit`); 06-04 should decide whether `fromSenderId` -> `fromEmail` resolution happens at publish time (mirroring `resolveCampaignFromEmail`) or whether a send node's missing sender is deliberately left as a v1 runtime-dispatch failure mode. Not a blocker for this plan (out of scope), but flagged for 06-04's planning.

---
*Phase: 06-flows-triggered-chains*
*Completed: 2026-07-10*

## Self-Check: PASSED

All 8 created/modified files verified present on disk; all 3 task commit hashes (`c3de450`, `f60cce7`, `d7907f7`) verified present in git log.
