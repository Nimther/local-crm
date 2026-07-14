---
phase: 04-broadcast-campaigns-send-pipeline
plan: 09
subsystem: api
tags: [sendgrid, campaigns, sender-resolution, fastify, vitest, tdd]

requires:
  - phase: 04-broadcast-campaigns-send-pipeline
    provides: campaign builder UI writing fromSenderId, dispatch worker hard-requiring campaigns.from_email (04-01..04-08)
provides:
  - resolveCampaignFromEmail(workspaceId, campaign) resolver that turns a verified-sender id into a concrete email and persists it
  - CampaignSenderError (sender_not_found | no_key) mapped to HTTP 422 with a sender field message
  - launch/schedule/test-send routes now resolve+persist campaigns.from_email before any queue enqueue
affects: [04-06 campaign scheduler, 04-04 send dispatch, campaign builder UI]

tech-stack:
  added: []
  patterns:
    - "Resolver wraps its own withTenant(workspaceId, ...) scope so callers pass workspaceId explicitly rather than relying on an ambient tenant context already being active"
    - "CampaignSenderError mirrors CampaignStateError's {message, code} shape and maps to the same fields.sender 422 UI-SPEC copy as launchIncompleteFields"

key-files:
  created:
    - apps/api/src/modules/campaigns/sender-resolver.ts
    - apps/api/src/modules/campaigns/__tests__/sender-resolution.test.ts
  modified:
    - apps/api/src/modules/campaigns/campaigns.routes.ts

key-decisions:
  - "resolveCampaignFromEmail is only invoked when fromSenderId OR fromEmail is set on launch/schedule/test-send -- when neither is set, the existing incomplete/missing-sender error paths (launchIncompleteFields, MISSING_SENDER_COPY) still own the message so the richer multi-field breakdown isn't replaced by a generic sender error"
  - "resolveCampaignFromEmail wraps its own withTenant(workspaceId, ...) internally (not assuming the caller already established tenant context) to match the plan's literal resolveCampaignFromEmail(workspaceId, campaign) signature while still calling getKey()/withTenantTransaction safely"

requirements-completed: [CAMP-01, CAMP-02, CAMP-04]

coverage:
  - id: D1
    description: "A campaign configured only with fromSenderId (no fromEmail) resolves to a concrete verified sender email, persisted to campaigns.from_email, before launch enqueues the kickoff job"
    requirement: CAMP-02
    verification:
      - kind: integration
        ref: "apps/api/src/modules/campaigns/__tests__/sender-resolution.test.ts#launch resolves a fromSenderId-only campaign to its verified sender email and persists it"
        status: pass
    human_judgment: false
  - id: D2
    description: "A test send from a fromSenderId-only campaign resolves and persists the verified sender email before enqueuing"
    requirement: CAMP-04
    verification:
      - kind: integration
        ref: "apps/api/src/modules/campaigns/__tests__/sender-resolution.test.ts#test-send resolves a fromSenderId-only campaign to its verified sender email and persists it"
        status: pass
    human_judgment: false
  - id: D3
    description: "Launch/test-send of a campaign whose fromSenderId does not match any verified sender fails closed with 422 (never enqueues an undispatchable job)"
    requirement: CAMP-01
    verification:
      - kind: integration
        ref: "apps/api/src/modules/campaigns/__tests__/sender-resolution.test.ts#launch fails with 422 when fromSenderId does not match any verified sender"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/campaigns/__tests__/sender-resolution.test.ts#test-send fails with 422 when fromSenderId does not match any verified sender"
        status: pass
    human_judgment: false

duration: 20min
completed: 2026-07-06
status: complete
---

# Phase 04 Plan 09: Campaign Sender Resolution (CR-02 gap closure) Summary

**Closed CR-02: fromSenderId-only campaigns (the only kind the builder UI produces) are now dispatchable — resolveCampaignFromEmail resolves and persists a verified from_email at launch, schedule, and test-send time, before any job reaches the queue.**

## Performance

- **Duration:** 20 min
- **Started:** 2026-07-06T12:38:00Z
- **Completed:** 2026-07-06T12:58:44Z
- **Tasks:** 2 completed
- **Files modified:** 3

## Accomplishments
- Every UI-created campaign (which only ever sets `fromSenderId`, never `fromEmail`) can now actually be launched, scheduled, or test-sent — previously the dispatch worker (`send-dispatch.ts:155`) would throw for every one of them since `campaigns.from_email` was never populated.
- Unresolvable sender ids (stale/forged/never-verified) fail closed with HTTP 422 before any job is enqueued, closing the T-04-09-01 spoofing threat.
- A real-contract integration test proves the launch → SendGrid-verified-senders → from_email → dispatch chain end-to-end, with SendGrid's HTTP surface stubbed (no real network access) so the test is fast and deterministic.

## Task Commits

Each task was committed atomically:

1. **Task 1: Failing real-contract integration test** - `6d7269e` (test)
2. **Task 2: resolveCampaignFromEmail resolver + wire into launch/schedule/test-send routes** - `7b2ca73` (feat)

_Note: TDD RED (Task 1) confirmed failing for the right reason (from_email stayed null, unresolvable sender returned 200/202 instead of 422) before Task 2 turned it GREEN._

## Files Created/Modified
- `apps/api/src/modules/campaigns/sender-resolver.ts` - `resolveCampaignFromEmail` + `CampaignSenderError`; decrypts the tenant SendGrid key, matches `fromSenderId` against `/v3/verified_senders`, persists the resolved email to `campaigns.from_email`
- `apps/api/src/modules/campaigns/campaigns.routes.ts` - launch/schedule/test-send handlers now call `resolveCampaignFromEmail` before their respective state transition/enqueue; added `mapCampaignSenderError` (422 + `fields.sender`)
- `apps/api/src/modules/campaigns/__tests__/sender-resolution.test.ts` - real-contract integration test (launch/test-send happy path + unresolvable-sender 422 cases), stubs `global.fetch` for SendGrid's `/v3/scopes` and `/v3/verified_senders`

## Decisions Made
- Resolution is skipped entirely (falls through to the existing `incomplete`/`MISSING_SENDER_COPY` paths) when a campaign has neither `fromSenderId` nor `fromEmail` set, so the multi-field "missing template/sender/segment" breakdown message isn't replaced by a narrower sender-only error.
- `resolveCampaignFromEmail` establishes its own `withTenant(workspaceId, ...)` scope internally rather than requiring callers to already be inside one, matching the plan's literal function signature while still safely calling `getKey()`/`withTenantTransaction`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking issue] Fixed a test-file typecheck error surfaced by `tsc --noEmit`**
- **Found during:** Task 2 verification (`npx tsc --noEmit`)
- **Issue:** The test file's `stubSendGridFetch` helper typed its stub function's parameter as `RequestInfo | URL`, but this project's tsconfig lib set doesn't expose the global `RequestInfo` DOM type, causing `TS2552: Cannot find name 'RequestInfo'`.
- **Fix:** Retyped the parameters via `Parameters<typeof fetch>[0]` / `Parameters<typeof fetch>[1]`, which resolves structurally without depending on the DOM lib types.
- **Files modified:** `apps/api/src/modules/campaigns/__tests__/sender-resolution.test.ts`
- **Commit:** `7b2ca73`

## Self-Check: PASSED

- FOUND: apps/api/src/modules/campaigns/sender-resolver.ts
- FOUND: apps/api/src/modules/campaigns/__tests__/sender-resolution.test.ts
- FOUND commit 6d7269e
- FOUND commit 7b2ca73
