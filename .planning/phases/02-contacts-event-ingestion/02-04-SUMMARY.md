---
phase: 02-contacts-event-ingestion
plan: 04
subsystem: api
tags: [fastify, zod, postgres, jsonb, api-key-auth, upsert]

# Dependency graph
requires:
  - phase: 02-contacts-event-ingestion (02-01)
    provides: contact.repository.ts CRUD, property-registry.ts (registerObservedProperty), contacts schema/RLS
  - phase: 02-contacts-event-ingestion (02-03)
    provides: workspace_api_keys, apiKeyAuth onRequest hook, api-keys management routes
provides:
  - upsertContactByIdentity(client, workspaceId, input) — the single prioritized two-key upsert (external_id first, email fallback) shared by every future call site (events:ingest worker, imports:csv worker)
  - POST /v1/contacts — API-key-authed Contacts integration API (CONT-03)
  - upsertContactApiSchema (shared-schemas) — D-02 envelope, single or batch
  - Reserved-property-key denylist (RESERVED_CONTACT_PROPERTY_KEYS) guarding the properties JSONB merge
affects: [02-06-events-worker, 02-07-csv-import]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "SELECT ... FOR UPDATE + branch transaction for two-key-priority upserts (never a single ON CONFLICT for both keys)"
    - "Structured Pino conflict logging ({workspaceId, contactId, reason, incoming*}) for silent-data-conflict cases (D-05)"
    - "Reserved-key denylist stripped before any JSONB properties merge (defense against mass-assignment via freeform properties)"
    - "API-key-authed integration routes mounted in an encapsulated Fastify plugin scope with onRequest: apiKeyAuth + per-route rateLimit config"

key-files:
  created:
    - apps/api/src/modules/contacts/contacts-api.routes.ts
    - apps/api/src/modules/contacts/__tests__/upsert-priority.test.ts
    - apps/api/src/modules/contacts/__tests__/contacts-api.test.ts
  modified:
    - apps/api/src/modules/contacts/contact.repository.ts
    - packages/shared-schemas/src/contact.ts
    - apps/api/src/server.ts

key-decisions:
  - "External_id-matched contacts (Branch A) and email-matched contacts (Branches B/C) share one unified update path; the D-04 hard-email-conflict check runs on that shared path regardless of which identifier resolved the match, since Postgres cannot distinguish this case with a single ON CONFLICT statement"
  - "Branch C (email match, existing DIFFERENT external_id) is structurally unreachable to collide with Branch A's own external_id match — if the incoming external_id existed on any row, the first SELECT (by external_id) would already have found it, so Branch C's condition (existing.externalId set AND different from input.externalId) can only arise via the email-match path"
  - "upsertContactByIdentity takes an internal-only _isRetry flag (default false) rather than changing its public 3-arg signature, so the once-only unique-violation retry (Branch E) doesn't change the contract callers rely on"

requirements-completed: [CONT-03, CONT-04, EVNT-02]

coverage:
  - id: D1
    description: "upsertContactByIdentity resolves Branch A (external_id match, update in place)"
    requirement: "CONT-04"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/contacts/__tests__/upsert-priority.test.ts#Branch A: external_id match updates the existing contact in place, email untouched"
        status: pass
    human_judgment: false
  - id: D2
    description: "Branch B (D-03): email match with no external_id yet attaches the incoming external_id as the new identity anchor"
    requirement: "CONT-04"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/contacts/__tests__/upsert-priority.test.ts#Branch B (D-03): email match with no external_id yet attaches the incoming external_id"
        status: pass
    human_judgment: false
  - id: D3
    description: "Branch C (A1): email match whose contact already has a DIFFERENT external_id ignores the incoming one (D-06 immutability) and logs a structured conflict"
    requirement: "CONT-04"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/contacts/__tests__/upsert-priority.test.ts#Branch C (A1): email match whose contact already has a DIFFERENT external_id ignores the incoming one and logs a conflict"
        status: pass
    human_judgment: false
  - id: D4
    description: "Branch D (D-04/D-05): incoming email owned by a different contact skips the email change and logs a structured conflict"
    requirement: "CONT-04"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/contacts/__tests__/upsert-priority.test.ts#Branch D (D-04/D-05): incoming email owned by a different contact skips the email change and logs a conflict"
        status: pass
    human_judgment: false
  - id: D5
    description: "Branch E: no identifier match creates a brand new contact with default subscribed status"
    requirement: "CONT-04"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/contacts/__tests__/upsert-priority.test.ts#Branch E: no match at all creates a brand new contact"
        status: pass
    human_judgment: false
  - id: D6
    description: "Pitfall 4: a property literally named subscription_status is stripped before the JSONB merge and cannot flip the contact's real subscription_status column"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/contacts/__tests__/upsert-priority.test.ts#Pitfall 4: a property literally named subscription_status is stripped and cannot flip the contact's real status"
        status: pass
    human_judgment: false
  - id: D7
    description: "D-10: a newly observed custom-property key surviving the reserved-key strip is recorded in workspace_property_registry"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/contacts/__tests__/upsert-priority.test.ts#D-10: a newly observed custom-property key is recorded in the property registry"
        status: pass
    human_judgment: false
  - id: D8
    description: "POST /v1/contacts is API-key-authed: missing or invalid Authorization header is rejected with 401"
    requirement: "CONT-03"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/contacts/__tests__/contacts-api.test.ts#missing Authorization header -> 401"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/contacts/__tests__/contacts-api.test.ts#invalid API key -> 401"
        status: pass
    human_judgment: false
  - id: D9
    description: "POST /v1/contacts creates a new contact and returns its resolved id; a subsequent call matched by external_id updates the same contact"
    requirement: "CONT-03"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/contacts/__tests__/contacts-api.test.ts#valid key: creates a new contact and returns its resolved id"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/contacts/__tests__/contacts-api.test.ts#valid key: a second call matched by external_id updates the same contact"
        status: pass
    human_judgment: false
  - id: D10
    description: "D-02: POST /v1/contacts rejects a payload with neither email nor externalId"
    requirement: "CONT-03"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/contacts/__tests__/contacts-api.test.ts#D-02: rejects a payload with neither email nor externalId"
        status: pass
    human_judgment: false

# Metrics
duration: 20min
completed: 2026-07-04
status: complete
---

# Phase 2 Plan 4: Contacts integration API + prioritized two-key upsert Summary

**`upsertContactByIdentity` — a single SELECT-FOR-UPDATE-plus-branch upsert resolving external_id-first/email-fallback contact identity (D-03 attach, D-04/A1 conflict logging, Pitfall-4 reserved-key defense) — exposed via an API-key-authed POST /v1/contacts, ready for the event and CSV workers to reuse verbatim.**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-07-04T13:49:50+05:00 (context load)
- **Completed:** 2026-07-04T14:00:50+05:00
- **Tasks:** 2 (TDD: RED, GREEN)
- **Files modified:** 4 (2 new source files, 2 modified; 2 new test files)

## Accomplishments
- `upsertContactByIdentity(client, workspaceId, input)` in `contact.repository.ts`: the single prioritized two-key upsert (CONT-04) — Branch A (external_id match), Branch B (email match + D-03 attach), Branch C (email match + A1 conflict-and-ignore on a differing external_id), Branch D (D-04/D-05 hard email conflict, skip + log), Branch E (insert, D-08/D-11 suppression override, once-only unique-violation retry)
- Reserved property keys `{id, workspace_id, external_id, email, subscription_status}` stripped before every properties JSONB merge (Pitfall 4), verified by a test asserting a literal `subscription_status` property key cannot flip the real column
- Every surviving custom-property key recorded via the existing shared `registerObservedProperty` helper (D-10), verified against `workspace_property_registry`
- `POST /v1/contacts` (CONT-03): API-key-authed, rate-limited Fastify plugin scope (`contacts-api.routes.ts`) resolving the workspace exclusively from `request.apiKeyWorkspaceId` — never falls back to session/slug resolution
- `upsertContactApiSchema` (shared-schemas): D-02 "at least one of email/externalId" envelope, accepting a single contact or a batch

## Task Commits

Each task was committed atomically:

1. **Task 1: RED — four-branch upsert + reserved-key + Contacts API tests** - `86750ad` (test)
2. **Task 2: GREEN — upsertContactByIdentity + /v1/contacts routes + shared schema** - `d5cf002` (feat)

**Plan metadata:** (this commit) `docs(02-04): complete plan`

## Files Created/Modified
- `apps/api/src/modules/contacts/contact.repository.ts` - Added `upsertContactByIdentity`, `RESERVED_CONTACT_PROPERTY_KEYS`, reserved-key stripping, unique-violation retry
- `apps/api/src/modules/contacts/contacts-api.routes.ts` - NEW: `registerContactsApiRoutes` mounting POST /v1/contacts under `apiKeyAuth` + rate limit
- `packages/shared-schemas/src/contact.ts` - Added `upsertContactApiSchema` (single-or-batch, D-02 refine)
- `apps/api/src/server.ts` - Registered `registerContactsApiRoutes`
- `apps/api/src/modules/contacts/__tests__/upsert-priority.test.ts` - NEW: branch A-E + reserved-key + registry coverage
- `apps/api/src/modules/contacts/__tests__/contacts-api.test.ts` - NEW: 401/create/update/D-02 coverage for /v1/contacts

## Decisions Made
- The D-04 hard-email-conflict check applies uniformly to any matched contact (Branch A/B/C), not just a dedicated "Branch D" path, since Postgres's SELECT-then-branch resolution means the same "is this new email already taken by someone else" check is needed regardless of which identifier resolved the match.
- `upsertContactByIdentity` keeps its documented 3-argument public signature; the once-only unique-violation retry (Branch E) uses an internal-only 4th parameter (`_isRetry`, default `false`) rather than changing the contract.
- POST /v1/contacts returns `200` uniformly for both create and update outcomes (the caller distinguishes via the returned `attached`/`emailChangeSkipped` flags, not the HTTP status), matching this being an idempotent upsert endpoint rather than a strict create-only route.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- `upsertContactByIdentity` is ready to be called verbatim from the events:ingest worker (02-06) and imports:csv worker (02-07) — no duplication risk for D-03/D-04 semantics.
- `RESERVED_CONTACT_PROPERTY_KEYS` and the property-registry recording pattern are exported/reusable for those same call sites.
- POST /v1/contacts (CONT-03) is live and API-key-authed; 02-06's events:ingest route can follow the identical `apiKeyAuth` onRequest + rate-limit plugin-scope pattern established in `contacts-api.routes.ts`.

---
*Phase: 02-contacts-event-ingestion*
*Completed: 2026-07-04*

## Self-Check: PASSED

All created/modified files exist on disk; both task commits (`86750ad`, `d5cf002`) found in git history.
