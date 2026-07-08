---
phase: 05-webhook-processing-delivery-tracking
plan: 04
subsystem: api
tags: [fastify, sendgrid, webhooks, rls, kms, zod]

# Dependency graph
requires:
  - phase: 05-webhook-processing-delivery-tracking (05-01)
    provides: workspace_webhook_endpoints table + findWebhookEndpointByToken pre-tenant-context lookup, POST /webhooks/sendgrid/:pathToken receiver
provides:
  - "provisionEventWebhook(apiKey, callbackUrl, existingWebhookId?) -- creates/PATCHes the platform's own signed Event Webhook via a tenant's BYO key"
  - "SendGrid key connect/recheck now best-effort auto-provisions the webhook and persists {pathToken, sendgridWebhookId, publicKey, provisionStatus}"
  - "GET /api/workspaces/:slug/webhook-health + POST /api/workspaces/:slug/webhook-reconnect authenticated routes"
  - "webhookHealthResponseSchema / WebhookHealthResponse shared-schemas contract"
affects: [05-05, delivery-tracking-ui]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Raw-fetch-with-Bearer SendGrid provisioning service, never throws -- always returns { id, publicKey } or a typed { error } so a webhook failure can never fail the key connect/recheck response (D-01 fallback)"
    - "Tenant-scoped repository pair on the same table: findWebhookEndpointByToken (pre-tenant-context, GUC-scoped runtime lookup) vs getWebhookEndpointByWorkspace/upsertWebhookEndpoint (normal withTenantTransaction/RLS path)"

key-files:
  created:
    - apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts
    - apps/api/src/modules/webhooks/webhook-settings.routes.ts
    - packages/shared-schemas/src/webhook.ts
    - apps/api/src/modules/webhooks/__tests__/webhook-provisioning.test.ts
    - apps/api/src/modules/tenancy/__tests__/sendgrid-key-webhook-provisioning.test.ts
    - apps/api/src/modules/webhooks/__tests__/webhook-settings-routes.test.ts
  modified:
    - apps/api/src/modules/tenancy/sendgrid-key.ts
    - apps/api/src/modules/webhooks/webhook-endpoint.repository.ts
    - apps/api/src/server.ts
    - packages/shared-schemas/src/index.ts

key-decisions:
  - "No new migration for a workspace_id UNIQUE constraint -- upsertWebhookEndpoint does a SELECT-then-branch (INSERT or UPDATE) inside withTenantTransaction instead of ON CONFLICT, since provisioning is only ever triggered synchronously from a single connect/recheck/reconnect HTTP request per workspace, never concurrently"
  - "provisionEventWebhook's CREATE path pre-flights GET .../settings/all: reuses an existing platform webhook found by friendly_name (in case a stored sendgridWebhookId was ever lost) and surfaces max_allowed cap exhaustion as a typed cap_reached error before ever POSTing (Pitfall 4)"
  - "webhookWarning is an additive, optional field on the existing sendgrid-key connect/recheck success response -- never changes the 200/connected:true contract, satisfying D-01's 'a webhook failure never fails the key connect' requirement"
  - "webhook-settings.routes.ts duplicates a slim version of the reconnect provisioning flow rather than importing sendgrid-key.ts's private provisionWebhookBestEffort helper, keeping the file boundary matching the plan's files_modified list exactly"

patterns-established:
  - "Best-effort side-effect wrapped in try/catch at TWO layers (inside provisionEventWebhook itself, and again in the caller's provisionWebhookBestEffort) so a provisioning failure can never propagate to fail an unrelated primary operation"

requirements-completed: [WBHK-01]

coverage:
  - id: D1
    description: "Connecting or rechecking a SendGrid key auto-provisions the platform's own named, signed Event Webhook via the tenant key and persists {sendgridWebhookId, publicKey, pathToken}"
    requirement: "WBHK-01"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/tenancy/__tests__/sendgrid-key-webhook-provisioning.test.ts#connect best-effort provisions the platform's Event Webhook and persists {pathToken, sendgridWebhookId, publicKey, provisionStatus: 'active'}"
        status: pass
    human_judgment: false
  - id: D2
    description: "Re-provisioning PATCHes the stored sendgridWebhookId in place rather than POSTing a new webhook -- no duplicate accumulation on reconnect"
    requirement: "WBHK-01"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/tenancy/__tests__/sendgrid-key-webhook-provisioning.test.ts#recheck reuses the stored pathToken and PATCHes the existing sendgridWebhookId in place (no duplicate create)"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/webhooks/__tests__/webhook-settings-routes.test.ts#POST reconnect PATCHes the existing sendgridWebhookId in place (reuses stored pathToken, no duplicate create)"
        status: pass
      - kind: unit
        ref: "apps/api/src/modules/webhooks/__tests__/webhook-provisioning.test.ts#existingWebhookId path PATCHes in place and never POSTs a create"
        status: pass
    human_judgment: false
  - id: D3
    description: "Provisioning failure (insufficient scope / plan cap / unexpected error) surfaces a graceful, non-fatal message and never blocks the key connect itself"
    requirement: "WBHK-01"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/tenancy/__tests__/sendgrid-key-webhook-provisioning.test.ts#a provisioning failure (403 missing scope) degrades gracefully -- connect still returns 200 with a webhookWarning, and provisionStatus 'error' persisted"
        status: pass
      - kind: unit
        ref: "apps/api/src/modules/webhooks/__tests__/webhook-provisioning.test.ts#a 403 scope response on PATCH returns { error: 'missing_scope' } without throwing"
        status: pass
      - kind: unit
        ref: "apps/api/src/modules/webhooks/__tests__/webhook-provisioning.test.ts#a cap-reached listing (webhooks.length >= max_allowed) returns { error: 'cap_reached' } without POSTing"
        status: pass
      - kind: unit
        ref: "apps/api/src/modules/webhooks/__tests__/webhook-provisioning.test.ts#an unexpected fetch exception is caught and returns { error: 'failed' } (never throws)"
        status: pass
    human_judgment: false
  - id: D4
    description: "A workspace member can read webhook health (connected/disconnected + last_event_at) and an Owner/Admin can trigger a reconnect; the pathToken/publicKey are never leaked and unknown/non-member callers get a uniform 404"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/webhooks/__tests__/webhook-settings-routes.test.ts#GET health returns connected:true/provisionStatus:'active' after a successful connect, and never leaks pathToken/publicKey"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/webhooks/__tests__/webhook-settings-routes.test.ts#GET health returns the same generic 404 for an authenticated non-member as for a nonexistent workspace (no enumeration oracle)"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/webhooks/__tests__/webhook-settings-routes.test.ts#POST reconnect refuses a Member with 403 while the Owner succeeds"
        status: pass
    human_judgment: false
  - id: D5
    description: "Live provisioning against a real tenant SendGrid key confirms the exact CREATE path (A3), the signed webhook shows up in the SendGrid dashboard as 'Mega CRM Delivery Tracking', and existing tenant webhooks are untouched"
    verification: []
    human_judgment: true
    rationale: "Requires a live tenant SendGrid API key with webhook-management scope, per the plan's user_setup and deferred phase-UAT human-check (human_verify_mode: end-of-phase, Phase 1 precedent). Not available in this automated execution session."
---

# Phase 5 Plan 4: SendGrid Webhook Auto-Provisioning Summary

**Connecting or rechecking a tenant's SendGrid key now best-effort provisions the platform's own signed, named Event Webhook (PATCH-in-place on reconnect) and exposes read/reconnect routes, with every failure mode degrading gracefully instead of ever blocking the key connect**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-07-08T14:38:00Z
- **Completed:** 2026-07-08T14:50:20Z
- **Tasks:** 3
- **Files modified:** 10

## Accomplishments
- `provisionEventWebhook` creates or PATCHes the platform's own independently-named ("Mega CRM Delivery Tracking") Event Webhook via a tenant's raw BYO SendGrid key, enables signed verification, and returns `{ id, publicKey }` or a typed `{ error: "missing_scope" | "cap_reached" | "failed" }` -- it never throws, matching D-01's "never blocks the key connect" requirement
- The CREATE path pre-flights `GET .../settings/all` to reuse an already-present platform webhook by name (dedup guard) and to detect the plan's `max_allowed` cap before ever POSTing; a 404/405 on the primary CREATE path falls back to `.../settings/all` (Open Question A3)
- SendGrid key connect and recheck now trigger this provisioning inside the same tenant transaction that persists the key, generating a random 32-byte `pathToken` once and reusing it (and the stored `sendgridWebhookId`) across every subsequent reconnect -- so a reconnect always PATCHes in place, never re-POSTs (Pitfall 4)
- New authenticated `GET /api/workspaces/:slug/webhook-health` (member-readable, anti-enumeration 404) and `POST /api/workspaces/:slug/webhook-reconnect` (Owner/Admin-gated) routes expose `{ connected, provisionStatus, lastEventAt }` without ever leaking the `pathToken` or `publicKey`

## Task Commits

Each task was committed atomically:

1. **Task 1: SendGrid Event Webhook provisioning service (create/list/patch/enable-signed) via tenant key** - `aa34e75` (feat)
2. **Task 2: Trigger best-effort provisioning on key connect/recheck + persist endpoint row** - `81688ac` (feat)
3. **Task 3: Webhook health GET + reconnect POST authenticated routes + shared response contract** - `bd8052a` (feat)

## Files Created/Modified
- `apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts` - `provisionEventWebhook` service (create/patch/enable-signed, cap/scope pre-flight, redacted errors)
- `apps/api/src/modules/webhooks/__tests__/webhook-provisioning.test.ts` - stubbed-`fetch` unit tests for every provisioning branch
- `apps/api/src/modules/webhooks/webhook-endpoint.repository.ts` - added `getWebhookEndpointByWorkspace`/`upsertWebhookEndpoint` (tenant-scoped RLS path) alongside the existing `findWebhookEndpointByToken`
- `apps/api/src/modules/tenancy/sendgrid-key.ts` - `provisionWebhookBestEffort` helper wired into both connect and recheck handlers; adds optional `webhookWarning` to the response
- `apps/api/src/modules/tenancy/__tests__/sendgrid-key-webhook-provisioning.test.ts` - nock-mocked integration tests: success persistence, graceful 403 degradation, reconnect reuse
- `apps/api/src/modules/webhooks/webhook-settings.routes.ts` - `registerWebhookSettingsRoutes` (GET health, POST reconnect)
- `apps/api/src/modules/webhooks/__tests__/webhook-settings-routes.test.ts` - health/reconnect route tests (role gates, anti-enumeration, no-leak assertions)
- `packages/shared-schemas/src/webhook.ts` - `webhookHealthResponseSchema`/`WebhookHealthResponse`
- `packages/shared-schemas/src/index.ts` - barrel export for the new schema
- `apps/api/src/server.ts` - registered `registerWebhookSettingsRoutes`

## Decisions Made
- No new migration for a `workspace_id` UNIQUE constraint on `workspace_webhook_endpoints` -- `upsertWebhookEndpoint` does a SELECT-then-branch inside `withTenantTransaction` instead of `ON CONFLICT`, since provisioning is only ever triggered synchronously from a single HTTP request per workspace
- `webhookWarning` is purely additive on the connect/recheck success response, never changing the existing `connected: true` contract -- verified by existing `sendgrid-key-connect.test.ts` continuing to pass unmodified
- `webhook-settings.routes.ts`'s reconnect handler duplicates a slim version of the provisioning-persist flow rather than importing `sendgrid-key.ts`'s private helper, keeping each file's change scoped to what the plan's frontmatter listed

## Deviations from Plan

None - plan executed exactly as written. Task 2 added an integration test file (`sendgrid-key-webhook-provisioning.test.ts`) not explicitly named in the plan's `files_modified` list, but this was required to satisfy the task's own stated acceptance criterion ("A stubbed provisioning failure leaves the key-connect response still successful (test asserts 200/connected:true)") and the `<verify>` command (`npm run test -w apps/api -- sendgrid-key webhook`) -- not a scope deviation, just the natural test artifact for the acceptance criterion.

## Issues Encountered
None. The existing `sendgrid-key-connect.test.ts` suite was verified to still pass unmodified after wiring provisioning into the connect/recheck handlers -- unmocked outbound `fetch` calls in that file fail fast in this sandboxed test environment and are caught by `provisionEventWebhook`'s own try/catch, so no hang or flake was observed; the full `apps/api` suite (33 files / 180 tests) and the full monorepo `npm run build` both pass clean.

## User Setup Required
None required to run the automated test suite. A live tenant SendGrid API key with webhook-management scope is needed for the phase-level UAT human-check (deferred per `human_verify_mode: end-of-phase`, Phase 1 precedent) to confirm: the exact CREATE path (A3) against a real account, that the signed "Mega CRM Delivery Tracking" webhook appears in the SendGrid dashboard, and that the tenant's own pre-existing webhooks are untouched. See this plan's frontmatter `user_setup` block.

## Next Phase Readiness
- `workspace_webhook_endpoints` rows are now populated automatically by real connect/recheck/reconnect traffic, closing the loop with 05-01's receiver (which already consumed `pathToken`/`publicKey` from manually-provisioned rows in its own tests)
- 05-05 can wire the frontend to `GET /api/workspaces/:slug/webhook-health` and `POST /api/workspaces/:slug/webhook-reconnect` for the "Переподключить" UI (D-02/D-03) using the `WebhookHealthResponse` shared-schemas type
- The A3 CREATE-path assumption (documented path vs `.../settings/all` fallback) remains formally unconfirmed against a live account until the phase-UAT human-check runs

---
*Phase: 05-webhook-processing-delivery-tracking*
*Completed: 2026-07-08*
