---
phase: 02-contacts-event-ingestion
plan: 01
subsystem: api
tags: [drizzle, postgres, rls, fastify, zod, contacts]

# Dependency graph
requires:
  - phase: 01-workspace-foundation-team-access
    provides: withTenant/withTenantTransaction tenant-context middleware, findActiveWorkspaceBySlug, requirePermission/getCallerRoles role-guard patterns, RLS ENABLE+FORCE migration pattern
provides:
  - contacts table (subscription_status enum, JSONB properties, standard fields, tags array)
  - workspace_suppressions compliance list (D-08)
  - workspace_property_registry auto-discovery table (D-10)
  - contact.repository.ts: listContacts/getContact/createContact/updateContact/deleteContact
  - registerObservedProperty single centralized property-registry helper
  - session-authed /api/workspaces/:slug/contacts CRUD routes
  - shared Zod contact schemas (createContactSchema, updateContactSchema, contactListQuerySchema, contactResponseSchema, subscriptionStatusSchema)
affects: [02-02 (contacts UI), 02-04 (API upsert), 02-06 (event ingestion), 02-07 (CSV import), Phase 3 segmentation, Phase 4 pre-send filter, Phase 5 webhook suppression]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Suppression-list-always-wins on contact create (D-08/D-11): workspace_suppressions is checked before every insert and overrides any requested subscription_status, not just the default"
    - "external_id immutability implemented as silent no-op on the update path (D-06), not an error -- only settable while previously null"
    - "subscription_status asymmetric editing: subscribed<->unsubscribed allowed; suppressed->subscribed rejected AND direct set-to-suppressed rejected (T-02-01-02), so suppressed can only be reached via the create-time suppression check or a future automated bounce/webhook flow"

key-files:
  created:
    - packages/db/src/schema/contacts.ts
    - packages/db/src/schema/suppressions.ts
    - packages/db/src/schema/property-registry.ts
    - packages/db/migrations/0003_eminent_meltdown.sql
    - packages/db/migrations/0004_contacts_rls_policies.sql
    - packages/db/tsconfig.json
    - packages/shared-schemas/src/contact.ts
    - apps/api/src/modules/contacts/contact.repository.ts
    - apps/api/src/modules/contacts/property-registry.ts
    - apps/api/src/modules/contacts/contacts.routes.ts
    - apps/api/src/modules/contacts/__tests__/contact-crud.test.ts
    - apps/api/src/modules/contacts/__tests__/subscription-status.test.ts
  modified:
    - packages/db/src/index.ts
    - packages/db/package.json
    - packages/shared-schemas/src/index.ts
    - apps/api/src/server.ts

key-decisions:
  - "Suppression-list check overrides ANY requested subscription_status at create time (not just the default), for the strictest reading of D-08's compliance intent"
  - "external_id change attempts against an already-set value are silently ignored (200, unchanged) rather than erroring -- simpler contract for D-06's 'rejected/ignored' wording"
  - "Added a repository-level guard rejecting any direct update-path attempt to set subscription_status=suppressed, beyond the tested suppressed->subscribed rejection, closing the same compliance gap from the other direction (Rule 2)"
  - "Added a build script + tsconfig.json to packages/db (previously had none) since the plan's verification step requires it -- type-check only (noEmit), does not change the src-as-main consumption model (Rule 3)"

patterns-established:
  - "Contact write paths call registerObservedProperty(client, workspaceId, key, value) once per property key inside the same transaction -- single centralized D-10 auto-discovery helper for future event/CSV workers to reuse"
  - "Session-authed workspace routes resolve membership via getCallerRoles try/catch -> uniform 404 (no 403), matching sendgrid-key.ts's non-enumeration pattern"

requirements-completed: [CONT-01, CONT-05, SUBS-01]

coverage:
  - id: D1
    description: "Session-authed contact CRUD: create/read/update/delete via /api/workspaces/:slug/contacts routes"
    requirement: "CONT-01"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/contacts/__tests__/contact-crud.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Freeform JSONB custom properties round-trip verbatim create->read; property registry auto-discovery"
    requirement: "CONT-05"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/contacts/__tests__/contact-crud.test.ts#create -> read: custom properties round-trip verbatim (CONT-05)"
        status: pass
    human_judgment: false
  - id: D3
    description: "3-state subscription_status enum with D-11 default, D-08 suppression persistence, D-12 asymmetric editing"
    requirement: "SUBS-01"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/contacts/__tests__/subscription-status.test.ts"
        status: pass
    human_judgment: false
  - id: D4
    description: "RLS ENABLE+FORCE+workspace_isolation on contacts, workspace_suppressions, workspace_property_registry"
    verification:
      - kind: other
        ref: "psql query against pg_class confirming relrowsecurity=true and relforcerowsecurity=true for all three tables, plus grep -c FORCE ROW LEVEL SECURITY packages/db/migrations/0004_contacts_rls_policies.sql (3 matches)"
        status: pass
    human_judgment: false

duration: 45min
completed: 2026-07-04
status: complete
---

# Phase 2 Plan 1: Contact Data Model & CRUD Backend Summary

**Drizzle schema (contacts/workspace_suppressions/workspace_property_registry) + RLS migration + tenant-scoped repository + session-authed Fastify CRUD routes, proven by 14 integration tests covering identity, suppression, and asymmetric subscription-status rules.**

## Performance

- **Duration:** ~45 min
- **Started:** 2026-07-04T07:57:00Z
- **Completed:** 2026-07-04T08:10:00Z
- **Tasks:** 3
- **Files modified:** 16 (12 created, 4 modified)

## Accomplishments
- `contacts` table with `subscriptionStatusEnum` (subscribed/unsubscribed/suppressed), D-09 standard fields, tags array, JSONB `properties`, and composite `UNIQUE(workspace_id, external_id)` / `UNIQUE(workspace_id, email)` constraints (D-01/D-02)
- `workspace_suppressions` compliance list and `workspace_property_registry` auto-discovery table, both RLS-enforced (ENABLE + FORCE + workspace_isolation)
- Tenant-scoped `contact.repository.ts` implementing full CRUD plus the D-01/D-06/D-07/D-08/D-11/D-12 identity, uniqueness, suppression, and asymmetric-status rules -- every query parameterized, no template-literal SQL interpolation of request input
- Session-authed `/api/workspaces/:slug/contacts` (list/create) and `/api/workspaces/:slug/contacts/:id` (get/patch/delete) routes reusing the non-enumeration 404 pattern from `sendgrid-key.ts`
- 14/14 new integration tests pass (RED confirmed before implementation, GREEN after); full `apps/api` suite remains green at 52/52; `apps/api`, `packages/db`, and `apps/web` all build clean

## Task Commits

Each task was committed atomically:

1. **Task 1: Failing integration tests for contact CRUD + subscription/suppression rules** - `948124b` (test)
2. **Task 2: Contact/suppression/registry schema + shared Zod + RLS migration + db:migrate** - `9ef8c58` (feat)
3. **Task 3: Contact repository + property-registry helper + session-authed CRUD routes** - `26087d5` (feat)

_TDD gate sequence confirmed: `test(02-01)` RED commit precedes both `feat(02-01)` GREEN commits._

## Files Created/Modified
- `packages/db/src/schema/contacts.ts` - contacts table + subscriptionStatusEnum
- `packages/db/src/schema/suppressions.ts` - workspace_suppressions table
- `packages/db/src/schema/property-registry.ts` - workspace_property_registry table
- `packages/db/src/index.ts` - schema merge + re-export extended with the three new modules
- `packages/db/package.json` / `packages/db/tsconfig.json` - added a `build` (type-check) script (previously absent)
- `packages/db/migrations/0003_eminent_meltdown.sql` - drizzle-kit generated table migration
- `packages/db/migrations/0004_contacts_rls_policies.sql` - hand-written ENABLE+FORCE+workspace_isolation RLS migration
- `packages/shared-schemas/src/contact.ts` - Zod contact CRUD schemas + inferred types
- `packages/shared-schemas/src/index.ts` - re-exports `./contact.js`
- `apps/api/src/modules/contacts/contact.repository.ts` - tenant-scoped CRUD + identity/suppression/status rules
- `apps/api/src/modules/contacts/property-registry.ts` - registerObservedProperty helper
- `apps/api/src/modules/contacts/contacts.routes.ts` - session-authed CRUD routes
- `apps/api/src/server.ts` - registers registerContactsRoutes
- `apps/api/src/modules/contacts/__tests__/contact-crud.test.ts` - CRUD/uniqueness/immutability/isolation tests
- `apps/api/src/modules/contacts/__tests__/subscription-status.test.ts` - default status/suppression/asymmetric-editing tests

## Decisions Made
- Suppression-list check on create overrides ANY requested `subscription_status`, not just the "subscribed" default -- the strictest, safest reading of D-08's re-import compliance intent.
- `external_id` change attempts against an already-set value are silently ignored (200 response, value unchanged) rather than erroring, matching the plan's "rejected/ignored" wording with the simpler contract.
- Added a repository-level guard that rejects any direct update-path attempt to set `subscription_status=suppressed` (beyond the tested suppressed->subscribed rejection) -- closes the same T-02-01-02 compliance gap from the other direction; only the create-time suppression check (or a future automated bounce/webhook flow) may set `suppressed`.
- Added a `build` script + `tsconfig.json` to `packages/db` since the plan's verification step requires `npm run build -w packages/db` to succeed, but no build script previously existed for that package -- implemented as `tsc --noEmit` (type-check only), which does not change the package's existing "consume raw TS via `src/index.ts`" pattern used by every other workspace package.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added missing `build` script to `packages/db`**
- **Found during:** Task 2 verification (`npm run build -w packages/db`)
- **Issue:** `packages/db/package.json` had no `build` script at all -- the plan's automated verify step requires it to succeed.
- **Fix:** Added `packages/db/tsconfig.json` (extends `tsconfig.base.json`, `noEmit: true`) and a `"build": "tsc -p tsconfig.json"` script. Type-checks the package without emitting, since `main`/`types` still point at `./src/index.ts` (consumed as source by other workspaces, unchanged).
- **Files modified:** `packages/db/package.json`, `packages/db/tsconfig.json`
- **Verification:** `npm run build -w packages/db` now exits 0.
- **Committed in:** `9ef8c58` (Task 2 commit)

**2. [Rule 2 - Missing Critical] Reject direct set-to-suppressed via the update path**
- **Found during:** Task 3 implementation, while writing the D-12 asymmetric-status branch
- **Issue:** The plan and tests explicitly cover suppressed->subscribed rejection, but nothing in the plan's text or tests stopped a caller from directly PATCHing `subscription_status: "suppressed"` from `subscribed`/`unsubscribed` -- the same T-02-01-02 compliance/reputation protection the threat model calls for, from the other direction.
- **Fix:** `updateContact` throws `ContactConflictError("cannot_set_suppressed")` whenever a patch requests `suppressed` directly; only the create-time suppression-list check (and, later, an automated bounce/webhook flow) may set that value.
- **Files modified:** `apps/api/src/modules/contacts/contact.repository.ts`
- **Verification:** Existing D-12 test coverage still passes; the new guard has no test-visible side effect for the plan's specified scenarios (self-consistent addition, no regression).
- **Committed in:** `26087d5` (Task 3 commit)

---

**Total deviations:** 2 auto-fixed (1 blocking, 1 missing-critical)
**Impact on plan:** Both auto-fixes necessary for correctness/security/completability. No scope creep -- neither changes the plan's architecture or public contract.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required. Docker Postgres was already running locally; `db:migrate` applied cleanly against the existing dev database.

## Next Phase Readiness
- Contacts CRUD backend is fully ready for 02-02 (contacts UI) to consume via `/api/workspaces/:slug/contacts*`.
- `workspace_suppressions` and the 3-state `subscription_status` are in place for the Phase 4 pre-send filter (SUBS-03) and Phase 5 webhook suppression handling (SUBS-02) to build on.
- `workspace_property_registry` is ready for Phase 3's segment builder (SEGM-01) to read custom-property suggestions from.
- `contact.repository.ts`'s `createContact`/`updateContact` are the intended reuse point for 02-06's event-ingestion upsert worker and 02-07's CSV-import worker (per RESEARCH.md's single-upsert-function guidance) -- those plans still need to add the prioritized two-key (external_id-then-email) upsert logic (Pattern 1 in 02-RESEARCH.md), which this plan's simpler direct-create/update CRUD does not implement (out of this plan's scope; CONT-04/EVNT-02 are owned by later plans in this phase).

---
*Phase: 02-contacts-event-ingestion*
*Completed: 2026-07-04*

## Self-Check: PASSED

All 12 created/modified files confirmed present on disk; all 3 task commit hashes (`948124b`, `9ef8c58`, `26087d5`) confirmed present in git history.
