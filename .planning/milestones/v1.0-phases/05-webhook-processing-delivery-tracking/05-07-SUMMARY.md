---
phase: 05-webhook-processing-delivery-tracking
plan: 07
subsystem: api
tags: [sendgrid, webhooks, multi-tenancy, gap-closure]

# Dependency graph
requires:
  - phase: 05-webhook-processing-delivery-tracking
    provides: sendgrid-webhook-provision.ts auto-provisioning module (05-01), sendgrid-key connect/recheck (05-01), webhook-settings reconnect routes (05-05)
provides:
  - Workspace-scoped SendGrid Event Webhook friendly_name so two workspaces sharing one BYO SendGrid key never adopt/repoint each other's webhook
  - Reuse-by-name path now repoints (PATCHes) a matched webhook's url to the current callbackUrl before returning it as active, closing a silent stale-URL tracking-loss gap
affects: [webhook-processing-delivery-tracking]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Per-workspace discriminator appended to a shared third-party resource's identifying name (friendly_name) to prevent cross-tenant adoption when tenants can share the same upstream credential"

key-files:
  created: []
  modified:
    - apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts
    - apps/api/src/modules/tenancy/sendgrid-key.ts
    - apps/api/src/modules/webhooks/webhook-settings.routes.ts
    - apps/api/src/modules/webhooks/__tests__/webhook-provisioning.test.ts

key-decisions:
  - "webhookFriendlyName(workspaceId) = `Mega CRM Delivery Tracking (${workspaceId.slice(0,8)})` -- 8-char workspace-id prefix is enough entropy to disambiguate sibling workspaces sharing one SendGrid account without a lookup"
  - "Reuse-by-name repoint routes through the existing patchWebhook helper (not a bespoke inline PATCH) so the repointed webhook gets the identical friendly_name/event-flags/enabled body as any other patch"

patterns-established:
  - "Pattern: when a shared upstream credential (BYO API key) can be attached to multiple tenants, any resource the platform provisions on it must be tenant-scoped by identifying name, not just by a stored id -- a lost/stale stored id must never fall back to matching a resource shape alone"

requirements-completed: [WBHK-01, WBHK-04]

coverage:
  - id: D1
    description: "A reused-by-name webhook whose url differs from the caller's callbackUrl is PATCHed to the callbackUrl before being returned as active"
    requirement: "WBHK-04"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/webhooks/__tests__/webhook-provisioning.test.ts#reuse-by-name with a stale url PATCHes the webhook to the new callbackUrl before returning it active"
        status: pass
    human_judgment: false
  - id: D2
    description: "friendly_name is workspace-scoped so two workspaces sharing one SendGrid key each provision their own webhook and cannot adopt/repoint each other's"
    requirement: "WBHK-01"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/webhooks/__tests__/webhook-provisioning.test.ts#a different workspace does not adopt a sibling's webhook (scoped friendly_name)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Both production callers (sendgrid-key connect/recheck, webhook-settings reconnect) pass workspace.id into provisioning; apps/api type-checks under the new signature"
    verification:
      - kind: unit
        ref: "npm run build -w apps/api (tsc -p tsconfig.json)"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/tenancy/__tests__/sendgrid-key-webhook-provisioning.test.ts (3 tests, unchanged, matches on method+path not body)"
        status: pass
    human_judgment: false

duration: 12min
completed: 2026-07-09
status: complete
---

# Phase 05 Plan 07: SendGrid webhook workspace-scoping + reuse repoint Summary

**Workspace-scoped `webhookFriendlyName(workspaceId)` plus a repoint-on-reuse PATCH in `createWebhook` closes CR-01 (the phase's sole Critical review finding): two workspaces sharing one BYO SendGrid key can no longer adopt/repoint each other's Event Webhook, and a reused webhook with a stale URL is now repointed instead of silently 404ing while reporting `provisionStatus: 'active'`.**

## Performance

- **Duration:** 12 min
- **Started:** 2026-07-09T11:20:00Z
- **Completed:** 2026-07-09T11:29:40Z
- **Tasks:** 2 completed
- **Files modified:** 4

## Accomplishments
- `provisionEventWebhook`/`createWebhook`/`patchWebhook`/`postCreate` all thread a required `workspaceId` and use the new `webhookFriendlyName(workspaceId)` helper everywhere the friendly_name is written or matched
- `createWebhook`'s reuse-by-name branch now compares the matched webhook's `url` to the caller's `callbackUrl` and PATCHes it (via `patchWebhook`) when they differ, before returning it as active
- Both production callers -- `sendgrid-key.ts`'s connect/recheck handlers and `webhook-settings.routes.ts`'s reconnect handler -- pass `workspace.id` through to provisioning
- Two new regression tests prove both fixes: a stale-url reuse repoints before returning, and a different workspace never adopts a sibling's webhook (and provisions its own instead)

## Task Commits

Each task was committed atomically:

1. **Task 1: Workspace-scope the friendly_name + repoint the reused webhook's url; thread workspaceId through both callers** - `d0209e6` (fix)
2. **Task 2: Regression tests — reuse-by-name repoints a stale url; a different workspace does not adopt a sibling's webhook** - `3c9ce41` (test)

**Plan metadata:** (this commit)

## Files Created/Modified
- `apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts` - `WEBHOOK_FRIENDLY_NAME_BASE` constant + new `webhookFriendlyName(workspaceId)` helper; `provisionEventWebhook`/`createWebhook`/`patchWebhook`/`postCreate` all gained a `workspaceId` parameter; reuse-by-name branch now repoints a stale url via `patchWebhook` before returning
- `apps/api/src/modules/tenancy/sendgrid-key.ts` - `provisionWebhookBestEffort(workspaceId, apiKey)` signature change; both connect and recheck call sites now pass `workspace.id`
- `apps/api/src/modules/webhooks/webhook-settings.routes.ts` - reconnect handler's `provisionEventWebhook` call now passes `workspace.id`
- `apps/api/src/modules/webhooks/__tests__/webhook-provisioning.test.ts` - all seven existing `provisionEventWebhook(...)` call sites updated for the new signature with a `TEST_WORKSPACE_ID` constant; two `friendly_name` assertions updated to `EXPECTED_FRIENDLY_NAME`; two new regression tests added

## Decisions Made
- `webhookFriendlyName` truncates the workspace UUID to its first 8 hex chars (`slice(0, 8)`) as the discriminator -- enough entropy to disambiguate sibling workspaces on one SendGrid account, keeps the SendGrid `friendly_name` field readable, and needs no extra lookup or persisted mapping.
- The stale-url repoint in `createWebhook`'s reuse branch delegates to the existing `patchWebhook` helper (returning its result directly) rather than adding a bespoke inline PATCH -- keeps a single source of truth for the PATCH body shape (`enabled`, `url`, scoped `friendly_name`, event flags).

## Deviations from Plan

None - plan executed exactly as written. Both tasks matched their `<action>` and `<acceptance_criteria>` sections without requiring any auto-fixes.

## Issues Encountered

None. `npm run build -w apps/api` compiled cleanly on the first pass after the signature change (all call sites, including both test files, matched); `sendgrid-key-webhook-provisioning.test.ts` required no changes since its nock interceptors match on method+path, not request body.

## User Setup Required

None - no external service configuration required. Logic-only change to existing provisioning module, two callers, and test files; no new dependencies.

## Next Phase Readiness

- CR-01 (the phase's sole Critical review finding) is closed: 05-VERIFICATION.md truth #1 ("SendGrid events arrive on the workspace's per-tenant webhook URL and update each message's status in the send log") can flip from partial to passing, now covering the reused-webhook URL-repoint and cross-workspace non-adoption cases.
- No blockers for phase completion. This was the final outstanding gap-closure plan (05-06 closed WR-01/WR-02 in the prior plan); phase 05 requirements WBHK-01 and WBHK-04 are now both structurally complete per this plan's regression coverage.

---
*Phase: 05-webhook-processing-delivery-tracking*
*Completed: 2026-07-09*

## Self-Check: PASSED

All created/modified files found on disk; both task commits (`d0209e6`, `3c9ce41`) and the summary commit (`41f5607`) verified present in git log.
