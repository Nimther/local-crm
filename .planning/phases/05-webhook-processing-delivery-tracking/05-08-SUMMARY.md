---
phase: 05-webhook-processing-delivery-tracking
plan: 08
subsystem: api
tags: [sendgrid, webhooks, observability, drizzle, postgres, logging]

# Dependency graph
requires:
  - phase: 05-webhook-processing-delivery-tracking
    provides: sendgrid-webhook-provision.ts provisioning module, workspace_webhook_endpoints table (05-01/05-04/05-07)
provides:
  - Redacted status+body console.warn logging on every non-ok SendGrid provisioning HTTP response (list/create/patch/signed)
  - Created webhookId preserved on the error result when signed-verification fails after a successful create/patch
  - workspace_webhook_endpoints.provision_error nullable text column, live and migrated
  - Repository read/write support for provisionError (UpsertWebhookEndpointInput, WebhookEndpointRow, getWebhookEndpointByWorkspace, upsertWebhookEndpoint)
affects: [05-09, 05-10]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "logNonOkProvisionResponse(context, res, apiKey) helper reads res.text() once per non-ok branch and redacts the api key before console.warn -- mirrors the existing redactApiKey-for-Error pattern but for a plain response body string"
    - "Error result variants widen with new optional fields (webhookId?, provisionError?) rather than new discriminated branches -- keeps existing callers compiling unchanged"

key-files:
  created:
    - packages/db/migrations/0025_webhook_provision_error.sql
  modified:
    - apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts
    - apps/api/src/modules/webhooks/__tests__/webhook-provisioning.test.ts
    - apps/api/src/modules/webhooks/webhook-endpoint.repository.ts
    - packages/db/src/schema/webhook-endpoints.ts
    - packages/db/migrations/meta/_journal.json

key-decisions:
  - "redactSecret(text, apiKey) added as a standalone string-redaction helper distinct from redactApiKey(err, apiKey) (Error-only) -- logNonOkProvisionResponse needs to redact a plain response-body string, not an Error"
  - "provisionError left unwired from callers in this plan (sendgrid-key.ts, webhook-settings.routes.ts) by design -- Task 2 only threads the field through the repository layer; surfacing the typed reason to the marketer is the wave-2 slice's job (05-09/05-10)"
  - "drizzle-kit's auto-generated migration filename/tag (0025_foamy_guardsmen) renamed to 0025_webhook_provision_error to match plan naming convention, following the 03-02 precedent recorded in STATE.md"

patterns-established:
  - "Non-ok SendGrid HTTP responses always get a console.warn(context, status, redactedBody) call BEFORE returning a typed error -- applies uniformly across list/create/patch/signed call sites in sendgrid-webhook-provision.ts"

requirements-completed: [WBHK-01, WBHK-04]

coverage:
  - id: D1
    description: "Every non-ok SendGrid provisioning response (list/create/patch/signed) emits a console.warn with status + redacted body; the raw api key never appears in logs"
    requirement: "WBHK-01"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/webhooks/__tests__/webhook-provisioning.test.ts#logs a redacted status+body for a non-ok CREATE response without leaking the api key (05-08 Task 1)"
        status: pass
    human_judgment: false
  - id: D2
    description: "A created webhook id is preserved on the error result when signed-verification fails after a successful create/patch"
    requirement: "WBHK-01"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/webhooks/__tests__/webhook-provisioning.test.ts#CREATE succeeds but signed-verification returns 403: preserves the created webhookId alongside the error (05-08 Task 1)"
        status: pass
    human_judgment: false
  - id: D3
    description: "workspace_webhook_endpoints has a live, migrated provision_error column; the repository can write and read a typed reason"
    requirement: "WBHK-04"
    verification:
      - kind: integration
        ref: "npm run test -w apps/api -- webhook-settings-routes sendgrid-key-webhook-provisioning (10/10 pass against the live 0025_webhook_provision_error.sql column)"
        status: pass
      - kind: other
        ref: "npm run build -w apps/api && npm run build -w packages/db"
        status: pass
    human_judgment: false

duration: 5min
completed: 2026-07-09
status: complete
---

# Phase 05 Plan 08: SendGrid webhook provisioning observability + preserved id + provision_error column Summary

**Redacted status+body logging on every non-ok SendGrid webhook API response, a preserved webhookId when signed-verification fails after a successful create, and a live `provision_error` column threaded through the repository read/write path.**

## Performance

- **Duration:** ~5 min (task commits 17:17:45 -> 17:20:30 local)
- **Started:** 2026-07-09T12:14:06Z (per STATE.md phase-start marker)
- **Completed:** 2026-07-09T12:20:48Z
- **Tasks:** 3/3 completed
- **Files modified:** 6 (1 new migration + 1 new snapshot)

## Accomplishments

- `sendgrid-webhook-provision.ts` now logs a redacted `console.warn(context, status, redactedBody)` at every terminal non-ok branch (`list`, `create`, `patch`, `signed`) via a new `redactSecret`/`logNonOkProvisionResponse` pair -- closes the L2 silent-failure gap diagnosed in `.planning/debug/sendgrid-webhook-not-provisioned.md`.
- `ProvisionEventWebhookResult`'s error variant widened to `{ error; webhookId? }`; `provisionEventWebhook` now returns `{ error: signedResult.error, webhookId: webhookResult.id }` instead of dropping the just-created id when signed-verification fails.
- `workspace_webhook_endpoints.provision_error` (nullable text) added to the Drizzle schema, migrated live via `0025_webhook_provision_error.sql`, and threaded through `UpsertWebhookEndpointInput`/`WebhookEndpointRow`/`getWebhookEndpointByWorkspace`/`upsertWebhookEndpoint`.
- Two new unit tests prove: (a) a created id survives a signed-verification 403, and (b) the logged output contains the HTTP status but never the raw api key.

## Task Commits

Each task was committed atomically:

1. **Task 1: Observability + preserve-created-id fix in the provisioning module** - `492ac33` (feat)
2. **Task 2: Add provision_error column (schema) + repository threading** - `2a2775d` (feat)
3. **Task 3 [BLOCKING]: Generate + apply the provision_error migration and confirm the live column** - `a52a7b6` (feat)

**Plan metadata:** (pending -- final docs commit follows this summary)

## Files Created/Modified

- `apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts` - Added `redactSecret`/`logNonOkProvisionResponse`; widened error result with optional `webhookId`; call sites at `list`/`create`/`patch`/`signed` non-ok branches; preserved created id on signed-verification failure
- `apps/api/src/modules/webhooks/__tests__/webhook-provisioning.test.ts` - Two new tests (webhookId preservation, redacted-log assertion)
- `packages/db/src/schema/webhook-endpoints.ts` - Added `provisionError: text("provision_error")` column
- `apps/api/src/modules/webhooks/webhook-endpoint.repository.ts` - Added `provisionError` to `UpsertWebhookEndpointInput`/`WebhookEndpointRow`; extended SELECT/INSERT/UPDATE
- `packages/db/migrations/0025_webhook_provision_error.sql` - `ALTER TABLE workspace_webhook_endpoints ADD COLUMN provision_error text;`
- `packages/db/migrations/meta/_journal.json` - New entry (renamed tag `0025_foamy_guardsmen` -> `0025_webhook_provision_error`)
- `packages/db/migrations/meta/0025_snapshot.json` - drizzle-kit auto-generated snapshot for migration 0025

## Decisions Made

- `redactSecret(text, apiKey)` kept as a separate helper from the existing `redactApiKey(err, apiKey)` since the latter is Error-shaped and the former operates on a plain response-body string read via `res.text()`.
- `provisionError` is threaded through the repository layer only in this plan; no caller (`sendgrid-key.ts`, `webhook-settings.routes.ts`) writes a value into it yet -- that wiring, plus surfacing the reason to the marketer UI, is explicitly deferred to the wave-2 slice (05-09/05-10) per the plan's stated purpose ("substrate — visible failures and a persisted reason — that the wave-2 slice renders to the user").
- Followed the 03-02 precedent (recorded in STATE.md) of renaming drizzle-kit's auto-generated migration filename/tag to match the plan's explicit `0025_webhook_provision_error` naming.

## Deviations from Plan

None - plan executed exactly as written. `db:generate`/`db:migrate` required loading `.env` via Node's `process.loadEnvFile` (the same pattern already established in `scripts/migrate-dev.mjs`) since the executor's shell environment does not have `DATABASE_URL` exported by default -- this is the documented existing pattern, not a new deviation.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required. This plan operates entirely within the existing local Postgres dev database and SendGrid API integration already configured in prior phases.

## Next Phase Readiness

- `provision_error` is live in the database and readable/writable via the repository, ready for 05-09/05-10 to (a) write a typed reason on provisioning failure and (b) surface it to the marketer in the UI.
- The preserved `webhookId` on signed-verification failure gives the wave-2 slice a non-orphaned id to persist alongside the failure reason (avoids a duplicate webhook on retry).
- Redacted logging is live in process logs now, so the next live-key UAT attempt (re-running UAT Test 1/3) will surface the actual SendGrid status/body for the first time, letting a human pin down the proximate cause (missing_scope vs. localhost callbackUrl) ranked in the debug doc.

---
*Phase: 05-webhook-processing-delivery-tracking*
*Completed: 2026-07-09*
