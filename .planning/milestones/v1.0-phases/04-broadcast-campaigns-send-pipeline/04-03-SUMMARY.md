---
phase: 04-broadcast-campaigns-send-pipeline
plan: 03
subsystem: delivery
tags: [hmac, sendgrid, rfc8058, fastify, postgres, unsubscribe, send-pipeline]

# Dependency graph
requires:
  - phase: 04-broadcast-campaigns-send-pipeline
    provides: "04-01: campaigns/sends/workspace_send_settings schema + idx_sends_workspace_contact_sent_at index"
provides:
  - "@mega-crm/delivery-core: signUnsubscribeToken/verifyUnsubscribeToken (HMAC-SHA256, timing-safe), buildListUnsubscribeUrl"
  - "@mega-crm/delivery-core: buildMailSendRequest/sendTenantMailV3 (SendGrid v3 mail/send, raw fetch, per-call Bearer key)"
  - "@mega-crm/delivery-core: buildContactTemplateData (D-18 v1 dynamic_template_data contract)"
  - "@mega-crm/delivery-core: evaluatePreSendGate (suppressed/unsubscribed/no_email/frequency_cap)"
  - "@mega-crm/delivery-core: dispatchSendGate/recordSendResult/recordExcluded/audienceExclusionBreakdown (idempotent send ledger)"
  - "@mega-crm/delivery-core: getWorkspaceSendSettings/upsertWorkspaceSendSettings (3/24/null defaults)"
  - "Public /unsubscribe/:token (GET confirm page, POST one-click + form-confirm) registered top-level in apps/api"
affects: [04-04, 04-05, 04-06, 04-07, 04-08]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "delivery-core is a dependency-light shared package (reads process.env directly, no zod schema) mirroring @mega-crm/kms and @mega-crm/tenant-context's convention -- both apps/api and apps/worker import the exact same send-rule implementation"
    - "Idempotent send dispatch: INSERT ... ON CONFLICT DO NOTHING RETURNING id, then SELECT ... FOR UPDATE on conflict, return 'skipped' only when status='sent' -- mirrors imports-csv.worker.ts's existing row-lock idempotency shape"

key-files:
  created:
    - packages/delivery-core/package.json
    - packages/delivery-core/tsconfig.json
    - packages/delivery-core/vitest.config.ts
    - packages/delivery-core/src/index.ts
    - packages/delivery-core/src/unsubscribe-token.ts
    - packages/delivery-core/src/send-mail.ts
    - packages/delivery-core/src/contact-template-data.ts
    - packages/delivery-core/src/pre-send-gate.ts
    - packages/delivery-core/src/send-ledger.ts
    - packages/delivery-core/src/send-settings.ts
    - packages/delivery-core/src/__tests__/unsubscribe-token.test.ts
    - packages/delivery-core/src/__tests__/pre-send-gate.test.ts
    - apps/api/src/modules/delivery/unsubscribe.routes.ts
    - apps/api/src/modules/delivery/__tests__/unsubscribe.test.ts
  modified:
    - apps/api/src/server.ts
    - apps/api/package.json
    - apps/api/vitest.config.ts

key-decisions:
  - "dispatchSendGate returns the union 'skipped' | { sendId: string } rather than a decision object, matching the literal 'returns skipped' wording in the plan's acceptance criteria"
  - "GET /unsubscribe/:token never verifies the token at all -- it always renders the identical static confirm page regardless of validity, which trivially satisfies both 'GET must never mutate' and 'no enumeration oracle' with zero verification logic in the GET handler"
  - "POST /unsubscribe/:token branches only on the Accept header (text/html vs not) to decide response body shape (rendered success page for the human confirm-form path vs empty 200 for RFC 8058 one-click clients) -- both branches run the identical verify-then-mutate logic first, so forged/expired/unknown-contact tokens remain byte-identical within either branch"
  - "Fastify's routerOptions.maxParamLength raised from the find-my-way default (100) to 1024 app-wide -- the signed unsubscribe token (~230-260 chars) exceeded the default and every genuine token 414'd before this fix (Rule 3 - blocking)"
  - "apps/api/vitest.config.ts gained test-safe UNSUBSCRIBE_TOKEN_SECRET/PUBLIC_APP_URL defaults (Rule 3) -- delivery-core reads these directly from process.env with no zod schema, matching the KMS/tenant-context test-env pattern already established for PLATFORM_SENDGRID_API_KEY etc."

patterns-established:
  - "Shared send-rule packages (delivery-core) never import apps/api's env.ts -- they read process.env directly so apps/worker (04-04) can depend on the same implementation without a backward dependency on apps/api"

requirements-completed: [SUBS-03, SUBS-04, SEND-04]

coverage:
  - id: D1
    description: "HMAC-signed unsubscribe token binds sendId+contactId+workspaceId+exp; round-trips for a valid token and returns null for any tampered payload or signature (SUBS-04, T-04-03-01)"
    requirement: "SUBS-04"
    verification:
      - kind: unit
        ref: "packages/delivery-core/src/__tests__/unsubscribe-token.test.ts#signUnsubscribeToken / verifyUnsubscribeToken (SUBS-04, T-04-03-01)"
        status: pass
    human_judgment: false
  - id: D2
    description: "buildContactTemplateData produces exactly the documented D-18 snake_case key set (first_name/last_name/email/phone/city/country/tags/properties/unsubscribe_url), with no reserved column leaking"
    requirement: "SUBS-04"
    verification:
      - kind: unit
        ref: "packages/delivery-core/src/__tests__/unsubscribe-token.test.ts#buildContactTemplateData (D-18 v1 contact-profile contract)"
        status: pass
    human_judgment: false
  - id: D3
    description: "evaluatePreSendGate returns each of suppressed/unsubscribed/no_email/frequency_cap for its condition and sendable:true on the happy path, using the index-backed rolling-window count query (SUBS-03/SEND-04/D-04/D-14)"
    requirement: "SEND-04"
    verification:
      - kind: unit
        ref: "packages/delivery-core/src/__tests__/pre-send-gate.test.ts#evaluatePreSendGate (SUBS-03/SEND-04/D-04/D-14)"
        status: pass
    human_judgment: false
  - id: D4
    description: "dispatchSendGate is idempotent -- returns the sendId to proceed on a fresh insert, and 'skipped' when a redelivered job finds the existing row already status='sent'"
    requirement: "SEND-04"
    verification:
      - kind: unit
        ref: "packages/delivery-core/src/__tests__/pre-send-gate.test.ts#dispatchSendGate idempotency (SEND-06)"
        status: pass
    human_judgment: false
  - id: D5
    description: "getWorkspaceSendSettings returns 3/24/null defaults when no workspace_send_settings row exists (D-13)"
    verification:
      - kind: unit
        ref: "packages/delivery-core/src/__tests__/pre-send-gate.test.ts#getWorkspaceSendSettings (D-13 defaults)"
        status: pass
    human_judgment: false
  - id: D6
    description: "POST /unsubscribe/:token with a valid token flips subscription_status to unsubscribed and returns 200 with an empty body; repeated POSTs are a safe no-op"
    requirement: "SUBS-04"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/delivery/__tests__/unsubscribe.test.ts#POST with a valid token sets subscription_status to unsubscribed and returns 200 with an empty body"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/delivery/__tests__/unsubscribe.test.ts#POST is idempotent: re-posting an already-unsubscribed contact's token stays 200 with an empty body"
        status: pass
    human_judgment: false
  - id: D7
    description: "GET /unsubscribe/:token renders an HTML confirm page and never mutates subscription_status"
    requirement: "SUBS-04"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/delivery/__tests__/unsubscribe.test.ts#GET renders an HTML confirm page and does NOT mutate subscription_status"
        status: pass
    human_judgment: false
  - id: D8
    description: "Enumeration-oracle safety: a forged token, an expired token, and a valid-but-unknown-contact token all produce byte-identical (POST) or shape-identical (GET) responses"
    requirement: "SUBS-04"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/delivery/__tests__/unsubscribe.test.ts#GET renders the identical page for a garbage/forged token as for a genuine one (enumeration-oracle safety)"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/delivery/__tests__/unsubscribe.test.ts#POST produces byte-identical responses for a forged token and a valid-but-unknown-contact token"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/delivery/__tests__/unsubscribe.test.ts#POST with an expired token does not mutate and matches the invalid-token response"
        status: pass
    human_judgment: false

duration: 25min
completed: 2026-07-06
status: complete
---

# Phase 4 Plan 3: Shared delivery-core + public unsubscribe endpoint Summary

**New `@mega-crm/delivery-core` package (HMAC unsubscribe tokens, SendGrid mail/send builder, D-18 contact-template-data contract, idempotent pre-send gate + send ledger) plus a live RFC 8058 one-click `/unsubscribe/:token` endpoint in apps/api.**

## Performance

- **Duration:** 25 min
- **Tasks:** 3
- **Files modified:** 17 (14 created, 3 modified)

## Accomplishments
- `@mega-crm/delivery-core` exists as the single source of truth for send rules: HMAC-signed unsubscribe tokens, the SendGrid v3 `mail/send` request builder + raw-fetch sender, the standardized D-18 `dynamic_template_data` shape, the shared pre-send gate (suppression/subscription/frequency-cap), and the idempotent send ledger -- all unit-tested (19 tests, both `tsc --noEmit` and `vitest run` green).
- Public, unauthenticated `/unsubscribe/:token` is live: GET always renders the same static confirm page (zero verification, so nothing can leak or mutate); POST verifies the HMAC + expiry, flips `subscription_status` idempotently, and returns byte-identical responses for a forged token, an expired token, and a valid-but-unknown-contact token.
- Both `apps/api`'s test suite (24 files / 135 tests) and the full workspace build (`npm run build --workspaces`) pass clean after these changes.

## Task Commits

1. **Task 1: @mega-crm/delivery-core — unsubscribe token + mail/send builder + D-18 contact template data** - `6770e39` (feat)
2. **Task 2: Pre-send gate + send ledger + send settings (shared rules)** - `e519206` (feat)
3. **Task 3: Public RFC 8058 unsubscribe endpoint** - `a733458` (feat)

_Note: no TDD gate commits (RED/GREEN split) — `tdd="true"` tasks were implemented with tests written and passing in the same commit per the plan's own action/verify grouping; both `tsc` and `vitest` gates ran green before each commit._

## Files Created/Modified
- `packages/delivery-core/src/unsubscribe-token.ts` - `signUnsubscribeToken`/`verifyUnsubscribeToken`/`buildListUnsubscribeUrl`
- `packages/delivery-core/src/send-mail.ts` - `SendGridMailSendRequest`, `buildMailSendRequest`, `sendTenantMailV3`
- `packages/delivery-core/src/contact-template-data.ts` - `buildContactTemplateData` (D-18 v1 contract)
- `packages/delivery-core/src/pre-send-gate.ts` - `evaluatePreSendGate`
- `packages/delivery-core/src/send-ledger.ts` - `dispatchSendGate`, `recordSendResult`, `recordExcluded`, `audienceExclusionBreakdown`
- `packages/delivery-core/src/send-settings.ts` - `getWorkspaceSendSettings`, `upsertWorkspaceSendSettings`
- `packages/delivery-core/src/index.ts` - barrel export for the whole package
- `apps/api/src/modules/delivery/unsubscribe.routes.ts` - `registerUnsubscribeRoutes` (public GET/POST `/unsubscribe/:token`)
- `apps/api/src/server.ts` - registers `registerUnsubscribeRoutes`; raises `routerOptions.maxParamLength` to 1024
- `apps/api/package.json` - adds `@mega-crm/delivery-core` dependency
- `apps/api/vitest.config.ts` - test-safe `UNSUBSCRIBE_TOKEN_SECRET`/`PUBLIC_APP_URL` defaults

## Decisions Made
- `dispatchSendGate` returns `"skipped" | { sendId: string }` (a plain union), not a decision object, matching the plan's literal "returns 'skipped'" acceptance wording.
- GET never verifies the token at all (always the same static page) -- the simplest possible way to guarantee both non-mutation and enumeration-oracle safety simultaneously, with no verification code path to get wrong.
- POST's Accept-header branch (`text/html` -> rendered success page; otherwise -> empty 200) is a pure presentation choice made *after* the identical verify-then-mutate decision, so it cannot become a second oracle.
- Raised Fastify's `routerOptions.maxParamLength` to 1024 app-wide (find-my-way's default of 100 was silently 414-ing every real unsubscribe token before this fix).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fastify's default `maxParamLength` (100) rejected every real unsubscribe token with a 414**
- **Found during:** Task 3 (writing and running `unsubscribe.test.ts`)
- **Issue:** find-my-way's router caps a single route param at 100 chars by default; the signed HMAC token (base64url JSON payload + `.` + base64url signature) runs ~230-260 chars, so every genuine `/unsubscribe/:token` request 414'd before reaching the handler.
- **Fix:** Set `routerOptions: { maxParamLength: 1024 }` in the `Fastify(...)` constructor in `apps/api/src/server.ts` (the non-deprecated form, per Fastify's `routerOptions` migration).
- **Files modified:** `apps/api/src/server.ts`
- **Verification:** All 6 `unsubscribe.test.ts` tests pass; full `apps/api` suite (135 tests) still green.
- **Committed in:** `a733458` (Task 3 commit)

**2. [Rule 3 - Blocking] `UNSUBSCRIBE_TOKEN_SECRET`/`PUBLIC_APP_URL` not available under `apps/api`'s test environment**
- **Found during:** Task 3 (writing `unsubscribe.test.ts`, which imports `signUnsubscribeToken` from delivery-core)
- **Issue:** delivery-core reads these two env vars directly from `process.env` (no zod schema, by design); apps/api's `vitest.config.ts` didn't set them, so any call would throw `"UNSUBSCRIBE_TOKEN_SECRET is not set"`.
- **Fix:** Added test-safe defaults to `apps/api/vitest.config.ts`'s `test.env` block, mirroring the existing `PLATFORM_SENDGRID_API_KEY`/`KMS_LOCAL_KEK` test-default pattern.
- **Files modified:** `apps/api/vitest.config.ts`
- **Verification:** `unsubscribe.test.ts` suite passes.
- **Committed in:** `a733458` (Task 3 commit)

---

**Total deviations:** 2 auto-fixed (both Rule 3 - blocking)
**Impact on plan:** Both fixes were required for the endpoint to function at all under test or in production; neither expands scope beyond what the plan specified.

## Issues Encountered
None beyond the two auto-fixed blocking issues above.

## User Setup Required

**External services require manual configuration.** Per the plan's `<user_setup>` block, a human must add to `apps/api` and `apps/worker`'s `.env`/`.env.example` (executor tooling is hard-denied on `.env*` paths):
- `UNSUBSCRIBE_TOKEN_SECRET` — a 32+ byte random secret (e.g. `openssl rand -base64 48`).
- `PUBLIC_APP_URL` — the public HTTPS base URL of the API that receives one-click unsubscribes (e.g. `https://api.example.com`).

Neither var is required to boot `apps/api` (delivery-core reads them lazily inside `signUnsubscribeToken`/`verifyUnsubscribeToken`/`buildListUnsubscribeUrl`, not at import time), so local dev without these set will boot fine; only actually signing/verifying a token or building a `List-Unsubscribe` URL will throw until they're set. Test suites use safe local defaults (`apps/api/vitest.config.ts`) and never touch real values.

## Next Phase Readiness
- `@mega-crm/delivery-core`'s full surface (`evaluatePreSendGate`, `dispatchSendGate`, `recordSendResult`, `buildMailSendRequest`, `sendTenantMailV3`, `buildContactTemplateData`, `signUnsubscribeToken`) is ready for 04-04 (the dispatch worker) to import directly — no further shared-package work needed before that plan starts.
- 04-05 (campaign audience breakdown) can call `audienceExclusionBreakdown`/`evaluatePreSendGate` for the D-04 exclusion counts using the exact same rule the worker will enforce at send time.
- `UNSUBSCRIBE_TOKEN_SECRET`/`PUBLIC_APP_URL` still need to be added to real `.env`/`.env.example` files by the user before any live send/unsubscribe round-trip can be manually verified end-to-end (tracked as a carried-forward operational prerequisite, consistent with the REDIS_URL/PLATFORM_SENDGRID_API_KEY precedent already in STATE.md).

---
*Phase: 04-broadcast-campaigns-send-pipeline*
*Completed: 2026-07-06*

## Self-Check: PASSED

All 9 key files confirmed present on disk; all 3 task commits (`6770e39`, `e519206`, `a733458`) confirmed in git history.
